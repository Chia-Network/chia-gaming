use std::borrow::Borrow;
use std::rc::Rc;

use clvmr::{NodePtr, run_program};
use clvm_traits::{ClvmEncoder, ToClvm};

use log::debug;

use crate::channel_handler::game_handler::{
    GameHandler, MessageHandler, MessageInputs, MyTurnResult, TheirTurnInputs, TheirTurnMoveData,
    TheirTurnResult,
};
use crate::channel_handler::types::{Evidence, GameStartInfo, ReadableMove, StateUpdateProgram, ValidationInfo};
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{standard_solution_partial, ChiaIdentity};
use crate::common::types::{
    chia_dialect, u64_from_atom, usize_from_atom, AllocEncoder, Amount, CoinCondition, CoinSpend, CoinString, Error, GameID,
    Hash, IntoErr, Node, Program, Puzzle, PuzzleHash, RcNode, Sha256Input, Sha256tree, Spend,
};
use crate::referee::my_turn::{MyTurnReferee, MyTurnRefereeMakerGameState};
use crate::referee::types::{
    curry_referee_puzzle, curry_referee_puzzle_hash, GameMoveDetails, GameMoveStateInfo,
    IdentityCoinAndSolution, OnChainRefereeMove, OnChainRefereeSolution, RMFixed,
    RefereeOnChainTransaction, RefereePuzzleArgs, TheirTurnCoinSpentResult, TheirTurnMoveResult, StateUpdateResult, InternalStateUpdateArgs, StateUpdateMoveArgs,
    REM_CONDITION_FIELDS,
};
use crate::referee::{BrokenOutCoinSpendInfo, RefereeByTurn, SlashOutcome};

// Contains a state of the game for use in currying the coin puzzle or for
// reference when calling the game_handler.
#[derive(Clone, Debug)]
pub enum TheirTurnRefereeMakerGameState {
    Initial {
        initial_state: Rc<Program>,
        initial_validation_program: StateUpdateProgram,
        initial_puzzle_args: Rc<RefereePuzzleArgs>,
        game_handler: GameHandler,
    },
    // We were given a validation program back from the 'our turn' handler
    // as well as a state.
    AfterOurTurn {
        their_turn_game_handler: GameHandler,
        their_turn_validation_program: StateUpdateProgram,
        state_after_our_turn: Rc<Program>,
        create_this_coin: Rc<RefereePuzzleArgs>,
        spend_this_coin: Rc<RefereePuzzleArgs>,
    },
}

impl TheirTurnRefereeMakerGameState {
    pub fn is_my_turn(&self) -> bool {
        match self {
            TheirTurnRefereeMakerGameState::Initial { game_handler, .. } => {
                matches!(game_handler, GameHandler::MyTurnHandler(_))
            }
            TheirTurnRefereeMakerGameState::AfterOurTurn { .. } => false,
        }
    }

    pub fn processing_my_turn(&self) -> bool {
        match self {
            TheirTurnRefereeMakerGameState::Initial { .. } => false,
            TheirTurnRefereeMakerGameState::AfterOurTurn { .. } => true,
        }
    }

    pub fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            TheirTurnRefereeMakerGameState::Initial {
                initial_puzzle_args,
                ..
            } => initial_puzzle_args.clone(),
            TheirTurnRefereeMakerGameState::AfterOurTurn {
                create_this_coin, ..
            } => create_this_coin.clone(),
        }
    }

    pub fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            TheirTurnRefereeMakerGameState::Initial {
                initial_puzzle_args,
                ..
            } => initial_puzzle_args.clone(),
            TheirTurnRefereeMakerGameState::AfterOurTurn {
                spend_this_coin, ..
            } => spend_this_coin.clone(),
        }
    }
}

// XXX break out state so we can have a previous state and easily swap them.
// Referee coin has two inner puzzles.
// Throughout channel handler, the one that's ours is the standard format puzzle
// to the pubkey of the referee private key (referred to in channel_handler).
#[derive(Clone, Debug)]
pub struct TheirTurnReferee {
    pub fixed: Rc<RMFixed>,

    pub finished: bool,
    pub message_handler: Option<MessageHandler>,

    pub state: Rc<TheirTurnRefereeMakerGameState>,
    pub state_number: usize,
    pub parent: Option<Rc<MyTurnReferee>>,
}

impl TheirTurnReferee {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        allocator: &mut AllocEncoder,
        referee_coin_puzzle: Puzzle,
        referee_coin_puzzle_hash: PuzzleHash,
        game_start_info: &GameStartInfo,
        my_identity: ChiaIdentity,
        their_puzzle_hash: &PuzzleHash,
        nonce: usize,
        agg_sig_me_additional_data: &Hash,
        state_number: usize,
    ) -> Result<(Self, PuzzleHash), Error> {
        debug!("referee maker: game start {:?}", game_start_info);
        let initial_move = GameMoveStateInfo {
            mover_share: game_start_info.initial_mover_share.clone(),
            move_made: game_start_info.initial_move.clone(),
        };
        let my_turn = game_start_info.game_handler.is_my_turn();
        debug!("referee maker: my_turn {my_turn}");

        let fixed_info = Rc::new(RMFixed {
            referee_coin_puzzle,
            referee_coin_puzzle_hash: referee_coin_puzzle_hash.clone(),
            their_referee_puzzle_hash: their_puzzle_hash.clone(),
            my_identity: my_identity.clone(),
            timeout: game_start_info.timeout.clone(),
            amount: game_start_info.amount.clone(),
            nonce,
            agg_sig_me_additional_data: agg_sig_me_additional_data.clone(),
        });

        // TODO: Revisit how we create initial_move
        let is_hash = game_start_info
            .initial_state
            .sha256tree(allocator)
            .hash()
            .clone();
        let ip_hash = game_start_info
            .initial_validation_program
            .sha256tree(allocator)
            .hash()
            .clone();
        let vi_hash = Sha256Input::Array(vec![
            Sha256Input::Hash(&is_hash),
            Sha256Input::Hash(&ip_hash),
        ])
        .hash();
        let ref_puzzle_args = Rc::new(RefereePuzzleArgs::new(
            &fixed_info,
            &initial_move,
            game_start_info.initial_max_move_size,
            None,
            &vi_hash,
            // Special for start: nobody can slash the first turn and both sides need to
            // compute the same value for amount to sign.  The next move will set mover share
            // and the polarity of the move will determine whether that applies to us or them
            // from both frames of reference.
            Some(&Amount::default()),
            my_turn,
        ));
        // If this reflects my turn, then we will spend the next parameter set.
        if my_turn {
            assert_eq!(
                fixed_info.my_identity.puzzle_hash,
                ref_puzzle_args.mover_puzzle_hash
            );
        } else {
            assert_eq!(
                fixed_info.their_referee_puzzle_hash,
                ref_puzzle_args.mover_puzzle_hash
            );
        }
        let state = Rc::new(TheirTurnRefereeMakerGameState::Initial {
            initial_state: game_start_info.initial_state.p(),
            initial_validation_program: game_start_info.initial_validation_program.clone(),
            initial_puzzle_args: ref_puzzle_args.clone(),
            game_handler: game_start_info.game_handler.clone(),
        });
        let puzzle_hash =
            curry_referee_puzzle_hash(allocator, &referee_coin_puzzle_hash, &ref_puzzle_args)?;

        Ok((
            TheirTurnReferee {
                fixed: fixed_info,
                finished: false,
                message_handler: None,
                state,
                state_number,
                parent: None,
            },
            puzzle_hash,
        ))
    }

    pub fn state_number(&self) -> usize {
        self.state_number
    }

    pub fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        self.state.args_for_this_coin()
    }

    pub fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        self.state.spend_this_coin()
    }

    pub fn is_my_turn(&self) -> bool {
        false
    }

    pub fn processing_my_turn(&self) -> bool {
        true
    }

    pub fn get_game_handler(&self) -> GameHandler {
        match self.state.borrow() {
            TheirTurnRefereeMakerGameState::Initial { game_handler, .. } => {
                game_handler.clone()
            }
            TheirTurnRefereeMakerGameState::AfterOurTurn { their_turn_game_handler, .. } => {
                their_turn_game_handler.clone()
            }
        }
    }

    pub fn get_game_state(&self) -> Rc<Program> {
        match self.state.borrow() {
            TheirTurnRefereeMakerGameState::Initial { initial_state, .. } => initial_state.clone(),
            TheirTurnRefereeMakerGameState::AfterOurTurn { state_after_our_turn, .. } => {
                state_after_our_turn.clone()
            }
        }
    }

    pub fn get_validation_program_for_their_move(
        &self,
    ) -> Result<(Rc<Program>, StateUpdateProgram), Error> {
        match self.state.borrow() {
            TheirTurnRefereeMakerGameState::Initial {
                game_handler,
                initial_state,
                initial_validation_program,
                ..
            } => {
                if game_handler.is_my_turn() {
                    return Err(Error::StrErr("no moves have been made yet".to_string()));
                }
                Ok((initial_state.clone(), initial_validation_program.clone()))
            }
            TheirTurnRefereeMakerGameState::AfterOurTurn { state_after_our_turn, their_turn_validation_program, .. } => Ok((
                state_after_our_turn.clone(),
                their_turn_validation_program.clone(),
            )),
        }
    }

    pub fn get_validation_program(&self) -> Result<Rc<Program>, Error> {
        match self.state.borrow() {
            TheirTurnRefereeMakerGameState::Initial {
                initial_validation_program,
                ..
            } => Ok(initial_validation_program.to_program().clone()),
            TheirTurnRefereeMakerGameState::AfterOurTurn { their_turn_validation_program, .. } => {
                Ok(their_turn_validation_program.to_program())
            }
        }
    }

    pub fn get_amount(&self) -> Amount {
        self.fixed.amount.clone()
    }

    pub fn get_our_current_share(&self) -> Amount {
        let args = self.spend_this_coin();
        if self.processing_my_turn() {
            self.fixed.amount.clone() - args.game_move.basic.mover_share.clone()
        } else {
            args.game_move.basic.mover_share.clone()
        }
    }

    pub fn get_their_current_share(&self) -> Amount {
        self.fixed.amount.clone() - self.get_our_current_share()
    }

    pub fn accept_their_move(
        &self,
        allocator: &mut AllocEncoder,
        game_handler: Option<GameHandler>,
        new_state: Rc<Program>,
        old_args: Rc<RefereePuzzleArgs>,
        referee_args: Rc<RefereePuzzleArgs>,
        details: &GameMoveDetails,
        state_number: usize,
    ) -> Result<MyTurnReferee, Error> {
        // assert_ne!(old_args.mover_puzzle_hash, referee_args.mover_puzzle_hash);
        // assert_eq!(old_args.mover_puzzle_hash, referee_args.waiter_puzzle_hash);
        assert_ne!(
            self.fixed.my_identity.puzzle_hash,
            referee_args.mover_puzzle_hash
        );
        debug!("accept their move {details:?}");

        let new_state = MyTurnRefereeMakerGameState::AfterTheirTurn {
            game_handler: game_handler.clone(),
            state_after_their_turn: new_state.clone(),
            create_this_coin: old_args,
            spend_this_coin: referee_args,
        };

        let new_parent = TheirTurnReferee {
            state_number,
            ..self.clone()
        };
        Ok(MyTurnReferee {
            finished: self.finished,
            fixed: self.fixed.clone(),
            state: Rc::new(new_state),
            state_number,
            message_handler: self.message_handler.clone(),
            parent: Some(Rc::new(new_parent)),
        })
    }

    pub fn receive_readable(
        &self,
        allocator: &mut AllocEncoder,
        message: &[u8],
    ) -> Result<ReadableMove, Error> {
        // Do stuff with message handler.
        let (state, move_data, mover_share) = match self.state.borrow() {
            TheirTurnRefereeMakerGameState::Initial {
                game_handler,
                initial_state,
                initial_puzzle_args,
                ..
            } => (
                initial_state.clone(),
                initial_puzzle_args.game_move.basic.move_made.clone(),
                if matches!(game_handler, GameHandler::MyTurnHandler(_)) {
                    initial_puzzle_args.game_move.basic.mover_share.clone()
                } else {
                    self.fixed.amount.clone()
                        - initial_puzzle_args.game_move.basic.mover_share.clone()
                },
            ),
            TheirTurnRefereeMakerGameState::AfterOurTurn {
                state_after_our_turn,
                create_this_coin,
                ..
            } => (
                state_after_our_turn.clone(),
                create_this_coin.game_move.basic.move_made.clone(),
                self.fixed.amount.clone() - create_this_coin.game_move.basic.mover_share.clone(),
            ),
        };

        let result = if let Some(handler) = self.message_handler.as_ref() {
            let state_nodeptr = state.to_nodeptr(allocator)?;
            handler.run(
                allocator,
                &MessageInputs {
                    message: message.to_vec(),
                    amount: self.fixed.amount.clone(),
                    state: state_nodeptr,
                    move_data,
                    mover_share,
                },
            )?
        } else {
            return Err(Error::StrErr(
                "no message handler but have a message".to_string(),
            ));
        };

        // self.message_handler = None;

        Ok(result)
    }

    pub fn on_chain_referee_puzzle(&self, allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
        let args = self.args_for_this_coin();
        curry_referee_puzzle(
            allocator,
            &self.fixed.referee_coin_puzzle,
            &self.fixed.referee_coin_puzzle_hash,
            &args,
        )
    }

    pub fn outcome_referee_puzzle(&self, allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
        let args = self.spend_this_coin();
        curry_referee_puzzle(
            allocator,
            &self.fixed.referee_coin_puzzle,
            &self.fixed.referee_coin_puzzle_hash,
            &args,
        )
    }

    pub fn on_chain_referee_puzzle_hash(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error> {
        let args = self.args_for_this_coin();
        curry_referee_puzzle_hash(allocator, &self.fixed.referee_coin_puzzle_hash, &args)
    }

    pub fn outcome_referee_puzzle_hash(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error> {
        let args = self.spend_this_coin();
        curry_referee_puzzle_hash(allocator, &self.fixed.referee_coin_puzzle_hash, &args)
    }

    // Ensure this returns
    fn get_transaction(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        always_produce_transaction: bool,
        puzzle: Puzzle,
        targs: &RefereePuzzleArgs,
        args: &OnChainRefereeSolution,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
        let our_move = self.is_my_turn();

        let my_mover_share = if our_move {
            targs.game_move.basic.mover_share.clone()
        } else {
            self.fixed.amount.clone() - targs.game_move.basic.mover_share.clone()
        };

        if always_produce_transaction || my_mover_share != Amount::default() {
            let signature = args.get_signature().unwrap_or_default();

            // The transaction solution is not the same as the solution for the
            // inner puzzle as we take additional move or slash data.
            //
            // OnChainRefereeSolution encodes this properly.
            let transaction_solution = args.to_clvm(allocator).into_gen()?;
            debug!("transaction solution inputs {args:?}");
            let transaction_bundle = Spend {
                puzzle: puzzle.clone(),
                solution: Program::from_nodeptr(allocator, transaction_solution)?.into(),
                signature,
            };
            let output_coin_string = CoinString::from_parts(
                &coin_string.to_coin_id(),
                &puzzle.sha256tree(allocator),
                &my_mover_share,
            );
            return Ok(Some(RefereeOnChainTransaction {
                bundle: transaction_bundle,
                amount: self.fixed.amount.clone(),
                coin: output_coin_string,
            }));
        }

        // Zero mover share case.
        Ok(None)
    }

    /// Output coin_string:
    /// Parent is hash of current_coin
    /// Puzzle hash is my_referee_puzzle_hash.
    ///
    /// Timeout unlike other actions applies to the current ph, not the one at the
    /// start of a turn proper.
    pub fn get_transaction_for_timeout(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
        debug!("get_transaction_for_timeout turn {}", self.is_my_turn());
        debug!(
            "mover share at start of action   {:?}",
            self.args_for_this_coin().game_move.basic.mover_share
        );
        debug!(
            "mover share at end   of action   {:?}",
            self.spend_this_coin().game_move.basic.mover_share
        );

        let targs = self.spend_this_coin();
        let puzzle = curry_referee_puzzle(
            allocator,
            &self.fixed.referee_coin_puzzle,
            &self.fixed.referee_coin_puzzle_hash,
            &targs,
        )?;

        self.get_transaction(
            allocator,
            coin_string,
            false,
            puzzle,
            &targs,
            &OnChainRefereeSolution::Timeout,
        )
    }

    /// The move transaction works like this:
    ///
    /// The referee puzzle has the hash of the puzzle of another locking coin,
    /// possibly the standard coin, and uses that to secure against another person
    /// commanding it.  This isn't the be confused with the coin that serves as the
    /// parent of the referee coin which is also assumed to be a standard puzzle
    /// coin.
    ///
    /// The inner coin, assuming it is a standard coin, takes the puzzle reveal
    /// for the above puzzle and the solution for that inner puzzle as the last two
    /// arguments to the move case of how it's invoked.
    ///
    /// The output conditions to step it are therefore built into those conditions
    /// which needs to include the puzzle hash of the target state of the referee
    /// (their move, the state precipitated by our move set as the current game
    /// state).
    ///
    /// We do the spend of the inner puzzle to that puzzle hash to progress the
    /// referee coin.
    ///
    /// One consequence of this is that we must sign it with the synthetic private
    /// key as the standard puzzle embeds a synthetic public key based on it.
    ///
    /// In all cases, we're spending a referee coin that already exists.  The use
    /// of the mover coin here is purely to take advantage of its puzzle to provide
    /// a signature requirement.
    pub fn get_transaction_for_move(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        on_chain: bool,
    ) -> Result<RefereeOnChainTransaction, Error> {
        // We can only do a move to replicate our turn.
        assert!(self.processing_my_turn());
        let target_args = self.spend_this_coin();
        let spend_puzzle = self.on_chain_referee_puzzle(allocator)?;

        let prog = StateUpdateProgram::new(allocator, Rc::new(Program::from_bytes(&[0x80])));
        debug!(
            "referee maker: get transaction for move {:?}",
            GameStartInfo {
                game_handler: self.get_game_handler(),
                game_id: GameID::default(),
                amount: self.get_amount(),
                initial_state: self.get_game_state().clone().into(),
                initial_max_move_size: target_args.max_move_size,
                initial_move: target_args.game_move.basic.move_made.clone(),
                initial_mover_share: target_args.game_move.basic.mover_share.clone(),
                my_contribution_this_game: Amount::default(),
                their_contribution_this_game: Amount::default(),
                initial_validation_program: prog,
                timeout: self.fixed.timeout.clone(),
            }
        );

        // Get the puzzle hash for the next referee state.
        // This reflects a "their turn" state with the updated state from the
        // game handler returned by consuming our move.  This is assumed to
        // have been done by consuming the move in a different method call.

        // Get the current state of the referee on chain.  This reflects the
        // current state at the time the move was made.
        // The current referee uses the previous state since we have already
        // taken the move.
        //
        debug!("get_transaction_for_move: previous curry");
        let args = self.args_for_this_coin();

        debug!("transaction for move: state {:?}", self.state);
        debug!("get_transaction_for_move: source curry {args:?}");
        debug!("get_transaction_for_move: target curry {target_args:?}");
        assert_eq!(
            target_args.mover_puzzle_hash,
            self.fixed.my_identity.puzzle_hash
        );
        // assert_ne!(args.mover_puzzle_hash, target_args.mover_puzzle_hash);
        // assert_eq!(args.mover_puzzle_hash, target_args.waiter_puzzle_hash);
        assert!(matches!(
            self.state.borrow(),
            TheirTurnRefereeMakerGameState::AfterOurTurn { .. }
        ));
        assert!(matches!(
            self.get_game_handler(),
            GameHandler::TheirTurnHandler(_)
        ));

        if let Some((_, ph, _)) = coin_string.to_parts() {
            if on_chain {
                let start_ph = curry_referee_puzzle_hash(
                    allocator,
                    &self.fixed.referee_coin_puzzle_hash,
                    &args,
                )?;
                let end_ph = curry_referee_puzzle_hash(
                    allocator,
                    &self.fixed.referee_coin_puzzle_hash,
                    &target_args,
                )?;
                debug!("spend puzzle hash {ph:?}");
                debug!("this coin start {start_ph:?}");
                debug!("this coin end   {end_ph:?}");
                // assert_eq!(ph, start_ph);
            }
        }

        assert_eq!(
            Some(&args.game_move.validation_info_hash),
            target_args.previous_validation_info_hash.as_ref()
        );
        debug!(
            "transaction for move: from {:?} to {target_args:?}",
            self.args_for_this_coin()
        );
        let target_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            &target_args,
        )?;
        let target_referee_puzzle = curry_referee_puzzle(
            allocator,
            &self.fixed.referee_coin_puzzle,
            &self.fixed.referee_coin_puzzle_hash,
            &target_args,
        )?;
        assert_eq!(
            target_referee_puzzle.sha256tree(allocator),
            target_referee_puzzle_hash
        );

        let inner_conditions = [(
            CREATE_COIN,
            (
                target_referee_puzzle_hash.clone(),
                (self.fixed.amount.clone(), ()),
            ),
        )]
        .to_clvm(allocator)
        .into_gen()?;

        // Generalize this once the test is working.  Move out the assumption that
        // referee private key is my_identity.synthetic_private_key.
        debug!("referee spend with parent coin {coin_string:?}");
        debug!(
            "signing coin with synthetic public key {:?} for public key {:?}",
            self.fixed.my_identity.synthetic_public_key, self.fixed.my_identity.public_key
        );
        let referee_spend = standard_solution_partial(
            allocator,
            &self.fixed.my_identity.synthetic_private_key,
            &coin_string.to_coin_id(),
            inner_conditions,
            &self.fixed.my_identity.synthetic_public_key,
            &self.fixed.agg_sig_me_additional_data,
            false,
        )?;

        let args_list = OnChainRefereeSolution::Move(OnChainRefereeMove {
            details: target_args.game_move.clone(),
            max_move_size: target_args.max_move_size,
            mover_coin: IdentityCoinAndSolution {
                mover_coin_puzzle: self.fixed.my_identity.puzzle.clone(),
                mover_coin_spend_solution: referee_spend.solution.p(),
                mover_coin_spend_signature: referee_spend.signature.clone(),
            },
        });

        if let Some(transaction) = self.get_transaction(
            allocator,
            coin_string,
            true,
            spend_puzzle,
            &target_args,
            &args_list,
        )? {
            Ok(transaction)
        } else {
            // Return err
            Err(Error::StrErr(
                "no transaction returned when doing on chain move".to_string(),
            ))
        }
    }

    /// Run the initial validator for a their turn move.  We must run the their turn validator
    /// first before we run the turn handler to provide a new state to the turn handler.
    pub fn run_state_update(
        &self,
        allocator: &mut AllocEncoder,
        details: &GameMoveDetails,
        state_number: usize,
        evidence: Evidence,
        coin: Option<&CoinString>,
    ) -> Result<StateUpdateResult, Error> {
        let puzzle_args = self.args_for_this_coin();
        let new_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            &puzzle_args
        )?;

        let (state, validation_program) = self.get_validation_program_for_their_move()?;

        let solution = self.fixed.my_identity.standard_solution(
            allocator,
            &[(
                self.fixed.my_identity.puzzle_hash.clone(),
                Amount::default(),
            )],
        )?;
        let solution_program = Rc::new(Program::from_nodeptr(allocator, solution)?);
        let validator_move_args = InternalStateUpdateArgs {
            old_state: self.get_game_state(),
            move_made: details.basic.move_made.clone(),
            // Unused by validator, present for the referee.
            new_validation_info_hash: Default::default(),
            mover_share: puzzle_args.game_move.basic.mover_share.clone(),
            previous_validation_info_hash: Default::default(),
            mover_puzzle_hash: puzzle_args.mover_puzzle_hash.clone(),
            waiter_puzzle_hash: puzzle_args.waiter_puzzle_hash.clone(),
            amount: self.fixed.amount.clone(),
            timeout: self.fixed.timeout.clone(),
            max_move_size: self.spend_this_coin().max_move_size,
            referee_hash: new_puzzle_hash.clone(),
            move_args: StateUpdateMoveArgs {
                evidence: evidence.to_program(),
                state: state.clone(),
                // XXX
                previous_validation_program: solution_program.clone(),
                mover_puzzle: self.fixed.my_identity.puzzle.to_program(),
                solution: solution_program,
            },
        };

        let validation_program_mod_hash = validation_program.hash();
        debug!("validation_program_mod_hash {validation_program_mod_hash:?}");
        let validation_program_nodeptr = validation_program.to_nodeptr(allocator)?;
        let validator_full_args_node = validator_move_args.to_nodeptr(
            allocator,
            validation_program_nodeptr,
            PuzzleHash::from_hash(validation_program_mod_hash.clone()),
        )?;
        let validator_full_args = Program::from_nodeptr(allocator, validator_full_args_node)?;

        debug!("validator program {:?}", validation_program);
        debug!("validator args {:?}", validator_full_args);
        let raw_result = run_program(
            allocator.allocator(),
            &chia_dialect(),
            validation_program_nodeptr,
            validator_full_args_node,
            0,
        ).into_gen()?;
        let pres = Program::from_nodeptr(allocator, raw_result.1)?;
        debug!("validator result {pres:?}");

        let update_result = StateUpdateResult::from_nodeptr(allocator, raw_result.1)?;
        if let StateUpdateResult::MoveOk(state, max_move_size) = &update_result {
            debug!("<V> their turn state result {:?} {state:?}", validation_program.sha256tree(allocator));
            let state_nodeptr = state.to_nodeptr(allocator)?;
            let validation_info_hash = ValidationInfo::new(
                allocator,
                validation_program.clone(),
                state_nodeptr,
            );
            assert_eq!(&details.validation_info_hash, validation_info_hash.hash());
        }

        Ok(update_result)
    }

    pub fn their_turn_move_off_chain(
        &self,
        allocator: &mut AllocEncoder,
        details: &GameMoveDetails,
        state_number: usize,
        coin: Option<&CoinString>,
    ) -> Result<(Option<MyTurnReferee>, TheirTurnMoveResult), Error> {
        debug!("do their turn {details:?}");

        let handler = self.get_game_handler();
        let my_turn_args = self.args_for_this_coin();
        let args = self.spend_this_coin();

        // Run the initial our turn validation to get the new state.
        let evidence = Evidence::nil()?;
        let state_update = self.run_state_update(
            allocator,
            details,
            state_number,
            evidence,
            coin
        )?;

        // Retrieve evidence from their turn handler.
        let (new_state, max_move_size) =
            match &state_update {
                StateUpdateResult::MoveOk(state, max_move_size) => {
                    (state.clone(), *max_move_size)
                }
                StateUpdateResult::Slash(evidence) => {
                    return Ok((None, TheirTurnMoveResult {
                        puzzle_hash_for_unroll: None,
                        original: TheirTurnResult::Slash(Evidence::from_nodeptr(allocator, *evidence)?),
                    }));
                }
            };

        let state_nodeptr = new_state.to_nodeptr(allocator)?;
        let result = handler.call_their_turn_driver(
            allocator,
            &TheirTurnInputs {
                amount: self.fixed.amount.clone(),
                last_state: state_nodeptr,

                last_move: &args.game_move.basic.move_made,
                last_mover_share: args.game_move.basic.mover_share.clone(),

                new_move: details.clone(),
            },
        )?;

        let (handler, move_data) = match &result {
            TheirTurnResult::FinalMove(move_data) => (None, move_data.clone()),
            TheirTurnResult::MakeMove(handler, _, move_data) => {
                (Some(handler.clone()), move_data.clone())
            }

            // Slash can't be used when we're off chain.
            TheirTurnResult::Slash(evidence) => {
                return Ok((
                    None,
                    TheirTurnMoveResult {
                        puzzle_hash_for_unroll: None,
                        original: TheirTurnResult::Slash(evidence.clone()),
                    },
                ))
            }
        };

        let (_, validation_program) = self.get_validation_program_for_their_move()?;
        let new_validation = ValidationInfo::new(
            allocator,
            validation_program,
            state_nodeptr
        );

        assert_eq!(new_validation.hash(), &details.validation_info_hash);
        let puzzle_args = Rc::new(RefereePuzzleArgs::new(
            &self.fixed,
            &details.basic,
            max_move_size,
            Some(&my_turn_args.game_move.validation_info_hash),
            &details.validation_info_hash,
            Some(&move_data.mover_share),
            false,
        ));

        debug!("<W> {puzzle_args:?}");

        let new_self = self.accept_their_move(
            allocator,
            handler,
            new_state.clone(),
            my_turn_args.clone(),
            puzzle_args.clone(),
            details,
            state_number,
        )?;

        // If specified, check for slash.
        if let Some(coin_string) = coin {
            for evidence in move_data.slash_evidence.iter() {
                debug!("calling slash for given evidence");
                if let StateUpdateResult::Slash(result_evidence) = self.run_state_update(
                    allocator,
                    details,
                    state_number,
                    evidence.clone(),
                    coin
                )? {
                    return Ok((None, TheirTurnMoveResult {
                        puzzle_hash_for_unroll: None,
                        original: TheirTurnResult::Slash(Evidence::from_nodeptr(allocator, result_evidence)?)
                    }));
                }
            }
        }

        let out_move =
            self.finish_their_turn(allocator, &move_data, puzzle_args, result, coin)?;

        Ok((Some(new_self), out_move))
    }

    pub fn their_turn_coin_spent(
        &self,
        my_rc: Rc<TheirTurnReferee>,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        conditions: &[CoinCondition],
        state_number: usize,
    ) -> Result<(Option<RefereeByTurn>, TheirTurnCoinSpentResult), Error> {
        let after_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            &self.spend_this_coin(),
        )?;

        // XXX Revisit this in conjuction with rewind.  There is a better way to do this.
        let repeat = if let Some(CoinCondition::CreateCoin(ph, _amt)) = conditions
            .iter()
            .find(|cond| matches!(cond, CoinCondition::CreateCoin(_, _)))
        {
            after_puzzle_hash == *ph
        } else {
            false
        };
        let created_coin = if let Some((ph, amt)) = conditions
            .iter()
            .filter_map(|cond| {
                if let CoinCondition::CreateCoin(ph, amt) = cond {
                    Some((ph, amt))
                } else {
                    None
                }
            })
            .next()
        {
            CoinString::from_parts(&coin_string.to_coin_id(), ph, amt)
        } else {
            return Err(Error::StrErr("no coin created".to_string()));
        };

        debug!("rems in spend {conditions:?}");

        // Read parameters off conditions
        let rem_condition = if let Some(CoinCondition::Rem(rem_condition)) = conditions
            .iter()
            .find(|cond| matches!(cond, CoinCondition::Rem(_)))
        {
            // Got rem condition
            rem_condition.to_vec()
        } else {
            Vec::default()
        };

        let mover_share = self.get_our_current_share();

        // Check properties of conditions
        if rem_condition.is_empty() {
            // Timeout case
            // Return enum timeout and we give the coin string of our reward
            // coin if any.
            let my_reward_coin_string = CoinString::from_parts(
                &coin_string.to_coin_id(),
                &self.fixed.my_identity.puzzle_hash,
                &mover_share,
            );

            debug!("game coin timed out: conditions {conditions:?}");
            return Ok((
                Some(RefereeByTurn::TheirTurn(my_rc)),
                TheirTurnCoinSpentResult::Timedout {
                    my_reward_coin_string: Some(my_reward_coin_string),
                },
            ));
        }

        if rem_condition.len() != REM_CONDITION_FIELDS {
            return Err(Error::StrErr(
                "rem condition should have the right number of fields".to_string(),
            ));
        }

        let new_move = &rem_condition[0];
        let validation_info_hash = Hash::from_slice(&rem_condition[1]);
        let (new_mover_share, new_max_move_size) = if let (Some(share), Some(max_size)) = (
            u64_from_atom(&rem_condition[2]),
            usize_from_atom(&rem_condition[3]),
        ) {
            (Amount::new(share), max_size)
        } else {
            return Err(Error::StrErr(
                "mover share wasn't a properly sized atom".to_string(),
            ));
        };

        let details = GameMoveDetails {
            basic: GameMoveStateInfo {
                move_made: new_move.clone(),
                mover_share: new_mover_share.clone(),
            },
            validation_info_hash,
        };

        let (new_self, result) =
            self.their_turn_move_off_chain(allocator, &details, state_number, None)?;

        let finish_result =
            |allocator: &mut AllocEncoder, move_data: &TheirTurnMoveData| {
                if repeat {
                    debug!("repeat: current state {:?}", self.state);

                    // Not my turn.
                    let nil_readable = ReadableMove::from_program(Program::from_hex("80")?.into());
                    return Ok((
                        Some(RefereeByTurn::TheirTurn(my_rc)),
                        TheirTurnCoinSpentResult::Moved {
                            new_coin_string: CoinString::from_parts(
                                &coin_string.to_coin_id(),
                                &after_puzzle_hash,
                                &self.fixed.amount,
                            ),
                            readable: nil_readable,
                            mover_share: self.spend_this_coin().game_move.basic.mover_share.clone(),
                        },
                    ));
                }

                let new_self = if let Some(new_self) = new_self {
                    new_self
                } else {
                    // Didn't slash but didn't update is an error.
                    return Err(Error::StrErr("we didn't slash but also didn't return a new state".to_string()));
                };

                let args = new_self.spend_this_coin();

                let new_puzzle = curry_referee_puzzle(
                    allocator,
                    &self.fixed.referee_coin_puzzle,
                    &self.fixed.referee_coin_puzzle_hash,
                    &args,
                )?;
                let new_puzzle_hash =
                    curry_referee_puzzle_hash(allocator, &self.fixed.referee_coin_puzzle_hash, &args)?;
                debug!("THEIR TURN MOVE OFF CHAIN SUCCEEDED {new_puzzle_hash:?}");


                let final_move = TheirTurnCoinSpentResult::Moved {
                    new_coin_string: CoinString::from_parts(
                        &coin_string.to_coin_id(),
                        &new_puzzle_hash,
                        &self.fixed.amount,
                    ),
                    readable: ReadableMove::from_program(move_data.readable_move.p()),
                    mover_share: args.game_move.basic.mover_share.clone(),
                };

                Ok((Some(RefereeByTurn::MyTurn(Rc::new(new_self))), final_move))

            };

        match &result.original {
            TheirTurnResult::Slash(evidence) => {
                // Slash specified.
                let args = self.spend_this_coin();
                let slash_spend = self.make_slash_spend(allocator, coin_string)?;
                let new_puzzle = curry_referee_puzzle(
                    allocator,
                    &self.fixed.referee_coin_puzzle,
                    &self.fixed.referee_coin_puzzle_hash,
                    &args,
                )?;
                let new_puzzle_hash =
                    curry_referee_puzzle_hash(allocator, &self.fixed.referee_coin_puzzle_hash, &args)?;
                let slash = self.make_slash_for_their_turn(
                    allocator,
                    coin_string,
                    new_puzzle,
                    &new_puzzle_hash,
                    &slash_spend,
                    evidence.clone(),
                )?;
                Ok((None, slash))
            }
            TheirTurnResult::FinalMove(move_data) => finish_result(allocator, &move_data),
            TheirTurnResult::MakeMove(_, _, move_data) => {
                finish_result(allocator, &move_data)
            }
        }
    }

    // It me.
    fn target_puzzle_hash_for_slash(&self) -> PuzzleHash {
        self.fixed.my_identity.puzzle_hash.clone()
    }

    fn slashing_coin_solution(
        &self,
        allocator: &mut AllocEncoder,
        state: NodePtr,
        my_validation_info_hash: PuzzleHash,
        validation_program_clvm: NodePtr,
        slash_solution: NodePtr,
        evidence: Evidence,
    ) -> Result<NodePtr, Error> {
        (
            Node(state),
            (
                my_validation_info_hash,
                (
                    Node(validation_program_clvm),
                    (
                        RcNode::new(self.fixed.my_identity.puzzle.to_program()),
                        (Node(slash_solution), (evidence, ())),
                    ),
                ),
            ),
        )
            .to_clvm(allocator)
            .into_gen()
    }

    fn make_slash_conditions(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        [(
            CREATE_COIN,
            (
                self.target_puzzle_hash_for_slash(),
                (self.fixed.amount.clone(), ()),
            ),
        )]
            .to_clvm(allocator)
            .into_gen()
    }

    pub fn make_slash_spend(
        &self,
        allocator: &mut AllocEncoder,
        coin_id: &CoinString,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        debug!("slash spend: parent coin is {coin_id:?}");
        let slash_conditions = self.make_slash_conditions(allocator)?;
        standard_solution_partial(
            allocator,
            &self.fixed.my_identity.synthetic_private_key,
            &coin_id.to_coin_id(),
            slash_conditions,
            &self.fixed.my_identity.synthetic_public_key,
            &self.fixed.agg_sig_me_additional_data,
            false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn make_slash_for_their_turn(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        new_puzzle: Puzzle,
        new_puzzle_hash: &PuzzleHash,
        slash_spend: &BrokenOutCoinSpendInfo,
        evidence: Evidence,
    ) -> Result<TheirTurnCoinSpentResult, Error> {
        // Probably readable_info overlaps solution.
        // Moving driver in that context is the signature.
        // My reward coin string is the coin that we'll make
        // after the transaction below has been spent so its
        // parent is the coin id of that coin.
        let current_mover_share = self.get_our_current_share();

        let (state, validation_program) = self.get_validation_program_for_their_move()?;
        let reward_amount = self.fixed.amount.clone() - current_mover_share;
        if reward_amount == Amount::default() {
            return Ok(TheirTurnCoinSpentResult::Slash(Box::new(
                SlashOutcome::NoReward,
            )));
        }

        let state_nodeptr = state.to_nodeptr(allocator)?;
        let validation_program_node = validation_program.to_nodeptr(allocator)?;
        let validation_program_hash = validation_program.sha256tree(allocator);
        let solution_nodeptr = slash_spend.solution.to_nodeptr(allocator)?;
        let slashing_coin_solution = self.slashing_coin_solution(
            allocator,
            state_nodeptr,
            validation_program_hash,
            validation_program_node,
            solution_nodeptr,
            evidence,
        )?;

        let coin_string_of_output_coin =
            CoinString::from_parts(&coin_string.to_coin_id(), new_puzzle_hash, &reward_amount);

        Ok(TheirTurnCoinSpentResult::Slash(Box::new(
            SlashOutcome::Reward {
                transaction: Box::new(CoinSpend {
                    // Ultimate parent of these coins.
                    coin: coin_string.clone(),
                    bundle: Spend {
                        puzzle: new_puzzle.clone(),
                        solution: Program::from_nodeptr(allocator, slashing_coin_solution)?.into(),
                        signature: slash_spend.signature.clone(),
                    },
                }),
                my_reward_coin_string: coin_string_of_output_coin,
            },
        )))
    }

    pub fn finish_their_turn(
        &self,
        allocator: &mut AllocEncoder,
        move_data: &TheirTurnMoveData,
        puzzle_args: Rc<RefereePuzzleArgs>,
        result: TheirTurnResult,
        coin: Option<&CoinString>,
    ) -> Result<TheirTurnMoveResult, Error> {
        let puzzle_hash_for_unroll = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            &puzzle_args,
        )?;
        debug!(
            "new_curried_referee_puzzle_hash (their turn): {:?}",
            puzzle_hash_for_unroll
        );

        // Coin calculated off the new new state.
        Ok(TheirTurnMoveResult {
            puzzle_hash_for_unroll: Some(puzzle_hash_for_unroll),
            original: result,
        })
    }
}
