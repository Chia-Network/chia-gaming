use std::borrow::Borrow;
use std::rc::Rc;

use clvm_traits::ToClvm;
use clvmr::NodePtr;

use log::debug;

use crate::channel_handler::game_handler::{TheirTurnMoveData, TheirTurnResult};
use crate::channel_handler::types::{
    Evidence, HasStateUpdateProgram, ReadableMove, StateUpdateProgram, ValidationInfo,
};
use crate::channel_handler::v1::game_handler::{
    GameHandler, MessageHandler, MessageInputs, TheirTurnInputs,
};
use crate::channel_handler::v1::game_start_info::GameStartInfo;
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{standard_solution_partial, ChiaIdentity};
use crate::common::types::{
    u64_from_atom, AllocEncoder, Amount, CoinCondition, CoinSpend, CoinString, Error, Hash,
    IntoErr, Node, Program, ProgramRef, Puzzle, PuzzleHash, RcNode, Sha256tree, Spend,
};
use crate::referee::types::{
    GameMoveDetails, GameMoveStateInfo, SlashOutcome, TheirTurnCoinSpentResult, TheirTurnMoveResult,
};
use crate::referee::v1::my_turn::{MyTurnReferee, MyTurnRefereeMakerGameState};
use crate::referee::v1::types::{
    curry_referee_puzzle, curry_referee_puzzle_hash, InternalStateUpdateArgs, RMFixed,
    RefereePuzzleArgs, StateUpdateMoveArgs, StateUpdateResult, REM_CONDITION_FIELDS,
};
use crate::referee::v1::{BrokenOutCoinSpendInfo, RefereeByTurn};

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

#[allow(dead_code)]
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

#[allow(dead_code)]
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
            max_move_size: game_start_info.initial_max_move_size,
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

        let validation_info_hash = ValidationInfo::new_state_update(
            allocator,
            game_start_info.initial_validation_program.clone(),
            game_start_info.initial_state.p(),
        );
        let ref_puzzle_args = Rc::new(RefereePuzzleArgs::new(
            &fixed_info,
            &GameMoveDetails {
                basic: initial_move.clone(),
                validation_info_hash: validation_info_hash.hash().clone(),
            },
            None,
            game_start_info.initial_validation_program.clone(),
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
            TheirTurnRefereeMakerGameState::Initial { game_handler, .. } => game_handler.clone(),
            TheirTurnRefereeMakerGameState::AfterOurTurn {
                their_turn_game_handler,
                ..
            } => their_turn_game_handler.clone(),
        }
    }

    pub fn get_game_state(&self) -> Rc<Program> {
        match self.state.borrow() {
            TheirTurnRefereeMakerGameState::Initial { initial_state, .. } => initial_state.clone(),
            TheirTurnRefereeMakerGameState::AfterOurTurn {
                state_after_our_turn,
                ..
            } => state_after_our_turn.clone(),
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
            TheirTurnRefereeMakerGameState::AfterOurTurn {
                state_after_our_turn,
                their_turn_validation_program,
                ..
            } => Ok((
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
            } => Ok(initial_validation_program.p().to_program().clone()),
            TheirTurnRefereeMakerGameState::AfterOurTurn {
                their_turn_validation_program,
                ..
            } => Ok(their_turn_validation_program.p().to_program()),
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
        game_handler: Option<GameHandler>,
        new_state: Rc<Program>,
        old_args: Rc<RefereePuzzleArgs>,
        referee_args: Rc<RefereePuzzleArgs>,
        details: &GameMoveDetails,
        state_number: usize,
    ) -> Result<MyTurnReferee, Error> {
        debug!("their turn: new_state {new_state:?}");
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
            enable_cheating: None,
        })
    }

    pub fn receive_readable(
        &self,
        allocator: &mut AllocEncoder,
        message: &[u8],
    ) -> Result<ReadableMove, Error> {
        // Do stuff with message handler.
        let state = match self.state.borrow() {
            TheirTurnRefereeMakerGameState::Initial { initial_state, .. } => initial_state.clone(),
            TheirTurnRefereeMakerGameState::AfterOurTurn {
                state_after_our_turn,
                ..
            } => state_after_our_turn.clone(),
        };

        let result = if let Some(handler) = self.message_handler.as_ref() {
            handler.run(
                allocator,
                &MessageInputs {
                    message: message.to_vec(),
                    amount: self.fixed.amount.clone(),
                    state: ProgramRef::new(state.clone()),
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
        curry_referee_puzzle(allocator, &self.fixed.referee_coin_puzzle, &args)
    }

    pub fn outcome_referee_puzzle(&self, allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
        let args = self.spend_this_coin();
        curry_referee_puzzle(allocator, &self.fixed.referee_coin_puzzle, &args)
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

    /// Run the initial validator for a their turn move.  We must run the their turn validator
    /// first before we run the turn handler to provide a new state to the turn handler.
    pub fn run_state_update(
        &self,
        allocator: &mut AllocEncoder,
        details: &GameMoveDetails,
        evidence: Evidence,
    ) -> Result<StateUpdateResult, Error> {
        let puzzle_args = self.spend_this_coin();
        let (state, validation_program) = self.get_validation_program_for_their_move()?;
        debug!(
            "their turn validation program {:?}",
            validation_program.to_program()
        );
        debug!(
            "their turn running state update {} with state {:?}",
            validation_program.name(),
            state
        );
        let validation_info =
            ValidationInfo::new_state_update(allocator, validation_program.clone(), state.clone());
        assert_eq!(*validation_info.hash(), details.validation_info_hash);
        let solution = self.fixed.my_identity.standard_solution(
            allocator,
            &[(
                self.fixed.my_identity.puzzle_hash.clone(),
                Amount::default(),
            )],
        )?;
        let solution_program = Rc::new(Program::from_nodeptr(allocator, solution)?);
        let ref_puzzle_args: &RefereePuzzleArgs = puzzle_args.borrow();
        let validator_move_args = InternalStateUpdateArgs {
            validation_program: validation_program.p(),
            referee_args: Rc::new(RefereePuzzleArgs {
                mover_puzzle_hash: self.fixed.their_referee_puzzle_hash.clone(),
                waiter_puzzle_hash: self.fixed.my_identity.puzzle_hash.clone(),
                game_move: details.clone(),
                validation_program: validation_program.clone(),
                previous_validation_info_hash: ref_puzzle_args
                    .previous_validation_info_hash
                    .clone()
                    .map(|_| ref_puzzle_args.game_move.validation_info_hash.clone()),
                ..ref_puzzle_args.clone()
            }),
            state_update_args: StateUpdateMoveArgs {
                evidence: evidence.to_program(),
                state: state.clone(),
                mover_puzzle: self.fixed.my_identity.puzzle.to_program(),
                solution: solution_program,
            },
        };
        validator_move_args.run(allocator)
    }

    pub fn their_turn_move_off_chain(
        &self,
        allocator: &mut AllocEncoder,
        details: &GameMoveDetails,
        state_number: usize,
        coin: Option<&CoinString>,
    ) -> Result<(Option<MyTurnReferee>, TheirTurnMoveResult), Error> {
        // Did we get a slash?

        debug!("do their turn {details:?}");

        let handler = self.get_game_handler();
        let args = self.spend_this_coin();

        // Run the initial our turn validation to get the new state.
        let evidence = Evidence::nil()?;
        let state_update = self.run_state_update(allocator, details, evidence)?;
        debug!("XXX their_turn state_update: {state_update:?}");

        // Retrieve evidence from their turn handler.
        let new_state = match &state_update {
            StateUpdateResult::MoveOk(state) => state,
            StateUpdateResult::Slash(evidence) => {
                return Ok((
                    None,
                    TheirTurnMoveResult {
                        puzzle_hash_for_unroll: None,
                        original: TheirTurnResult::Slash(Evidence::new(evidence.clone())),
                    },
                ));
            }
        };

        let state_nodeptr = new_state.to_nodeptr(allocator)?;
        let (_old_state, validation_program) = self.get_validation_program_for_their_move()?;
        let validation_program_hash = validation_program.sha256tree(allocator).hash().clone();
        let result = handler.call_their_turn_driver(
            allocator,
            &TheirTurnInputs {
                amount: self.fixed.amount.clone(),
                state: state_nodeptr,

                last_move: &args.game_move.basic.move_made,
                last_mover_share: args.game_move.basic.mover_share.clone(),

                new_move: GameMoveDetails {
                    validation_info_hash: validation_program_hash,
                    ..details.clone()
                },
            },
        )?;

        let (handler, move_data) = match &result {
            TheirTurnResult::FinalMove(move_data) => (None, move_data.clone()),
            TheirTurnResult::MakeMove(handler, _, move_data) => {
                (Some(handler.v1().clone()), move_data.clone())
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
        let puzzle_args = Rc::new(RefereePuzzleArgs::new(
            &self.fixed,
            details,
            Some(&args.game_move.validation_info_hash),
            validation_program.clone(),
            false,
        ));

        debug!("<W> {puzzle_args:?}");

        let new_self = self.accept_their_move(
            handler,
            new_state.clone(),
            args.clone(),
            puzzle_args.clone(),
            details,
            state_number,
        )?;

        // If specified, check for slash.
        if coin.is_some() {
            for evidence in move_data.slash_evidence.iter() {
                debug!("calling slash for given evidence");
                if let StateUpdateResult::Slash(result_evidence) =
                    self.run_state_update(allocator, details, evidence.clone())?
                {
                    return Ok((
                        None,
                        TheirTurnMoveResult {
                            puzzle_hash_for_unroll: None,
                            original: TheirTurnResult::Slash(Evidence::new(result_evidence)),
                        },
                    ));
                }
            }
        }

        let out_move = self.finish_their_turn(allocator, puzzle_args, result)?;

        debug!("final inputs {:?}", new_self.spend_this_coin());
        Ok((Some(new_self), out_move))
    }

    pub fn their_turn_coin_spent(
        &self,
        allocator: &mut AllocEncoder,
        referee_coin_string: &CoinString,
        conditions: &[CoinCondition],
        state_number: usize,
        rem_conditions: &[Vec<u8>],
    ) -> Result<(Option<RefereeByTurn>, TheirTurnCoinSpentResult), Error> {
        debug!(
            "their_turn_coin_spent: current ref coinstring: {:?}",
            referee_coin_string
        );
        debug!(
            "their_turn_coin_spent: current ref coinstring: {:?}",
            conditions
        );

        if rem_conditions.len() != REM_CONDITION_FIELDS {
            return Err(Error::StrErr(
                "rem condition should have the right number of fields".to_string(),
            ));
        }

        let new_move = &rem_conditions[0];
        let validation_info_hash = Hash::from_slice(&rem_conditions[1]);
        let new_mover_share = if let Some(share) = u64_from_atom(&rem_conditions[2]) {
            Amount::new(share)
        } else {
            return Err(Error::StrErr(
                "mover share wasn't a properly sized atom".to_string(),
            ));
        };
        let max_move_size = if let Some(mms) = u64_from_atom(&rem_conditions[3]) {
            mms as usize
        } else {
            return Err(Error::StrErr(
                "max move size wasn't a properly sized atom".to_string(),
            ));
        };

        // reconstruct details of an off-chain move
        let details = GameMoveDetails {
            basic: GameMoveStateInfo {
                move_made: new_move.clone(),
                mover_share: new_mover_share.clone(),
                max_move_size,
            },
            validation_info_hash,
        };

        let (new_self, result) =
            self.their_turn_move_off_chain(allocator, &details, state_number, None)?;

        let finish_result = |allocator: &mut AllocEncoder, move_data: &TheirTurnMoveData| {
            let new_self = if let Some(new_self) = new_self {
                new_self
            } else {
                // Didn't slash but didn't update is an error.
                return Err(Error::StrErr(
                    "we didn't slash but also didn't return a new state".to_string(),
                ));
            };

            let args = new_self.spend_this_coin();

            let new_puzzle_hash =
                curry_referee_puzzle_hash(allocator, &self.fixed.referee_coin_puzzle_hash, &args)?;
            debug!("THEIR TURN MOVE OFF CHAIN SUCCEEDED {new_puzzle_hash:?}");

            let final_move = TheirTurnCoinSpentResult::Moved {
                new_coin_string: CoinString::from_parts(
                    &referee_coin_string.to_coin_id(),
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
                let slash_spend = self.make_slash_spend(allocator, referee_coin_string)?;
                let new_puzzle =
                    curry_referee_puzzle(allocator, &self.fixed.referee_coin_puzzle, &args)?;
                let new_puzzle_hash = curry_referee_puzzle_hash(
                    allocator,
                    &self.fixed.referee_coin_puzzle_hash,
                    &args,
                )?;
                let slash = self.make_slash_for_their_turn(
                    allocator,
                    referee_coin_string,
                    new_puzzle,
                    &new_puzzle_hash,
                    &slash_spend,
                    evidence.clone(),
                )?;
                Ok((None, slash))
            }
            TheirTurnResult::FinalMove(move_data) => finish_result(allocator, move_data),
            TheirTurnResult::MakeMove(_, _, move_data) => finish_result(allocator, move_data),
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
        let validation_program_node = validation_program.p().to_nodeptr(allocator)?;
        let validation_program_hash = validation_program.p().sha256tree(allocator);
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
        puzzle_args: Rc<RefereePuzzleArgs>,
        result: TheirTurnResult,
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
