use std::rc::Rc;

use log::debug;

use clvm_traits::ToClvm;

use crate::common::constants::CREATE_COIN;
use crate::common::types::{AllocEncoder, Amount, CoinString, Error, GameID, Hash, IntoErr, Program, ProgramRef, Puzzle, PuzzleHash, Sha256Input, Sha256tree};
use crate::common::standard_coin::{ChiaIdentity, standard_solution_partial};
use crate::channel_handler::types::{GameStartInfo, ValidationProgram, ReadableMove, ValidationInfo};
use crate::channel_handler::game_handler::{GameHandler, MessageInputs, MyTurnInputs, MyTurnResult, MessageHandler};
use crate::referee::types::{RefereeMakerGameState, RMFixed, RefereeOnChainTransaction, OnChainRefereeSolution, OnChainRefereeMove, IdentityCoinAndSolution, StoredGameState, GameMoveWireData, GameMoveStateInfo, GameMoveDetails};
use crate::referee::puzzle_args::{RefereePuzzleArgs, curry_referee_puzzle_hash, curry_referee_puzzle};

pub struct MyTurnReferee {
    fixed: Rc<RMFixed>,
    validation_program_before_our_turn: ValidationProgram,
    state_from_our_last_turn_handler: ProgramRef,
    mover_share_from_their_move_handler: Amount,
    max_move_size_from_their_validation: usize,

    message_handler: Option<MessageHandler>,
}

pub struct MyTurnCarryData {
    validation_program_for_their_move: ValidationProgram,
    validation_program_for_my_next_move: ValidationProgram,
    state_from_our_turn_handler: ProgramRef,
    mover_share_from_our_move_handler: Amount,
    max_move_size_from_our_move_handler: usize,
}

impl MyTurnReferee {
    pub fn new(
        allocator: &mut AllocEncoder,
        fixed_info: Rc<RMFixed>,
        referee_coin_puzzle: Puzzle,
        referee_coin_puzzle_hash: PuzzleHash,
        game_start_info: &GameStartInfo,
        my_identity: ChiaIdentity,
        their_puzzle_hash: &PuzzleHash,
        nonce: usize,
        agg_sig_me_additional_data: &Hash,
    ) -> Result<Self, Error> {
        debug!("referee maker: game start {:?}", game_start_info);
        let initial_move = GameMoveStateInfo {
            mover_share: game_start_info.initial_mover_share.clone(),
            move_made: game_start_info.initial_move.clone(),
            max_move_size: game_start_info.initial_max_move_size,
        };

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
            None,
            &vi_hash,
            // Special for start: nobody can slash the first turn and both sides need to
            // compute the same value for amount to sign.  The next move will set mover share
            // and the polarity of the move will determine whether that applies to us or them
            // from both frames of reference.
            Some(&Amount::default()),
            true,
        ));
        // If this reflects my turn, then we will spend the next parameter set.
        assert_eq!(
            fixed_info.my_identity.puzzle_hash,
            ref_puzzle_args.mover_puzzle_hash
        );
        let state = Rc::new(RefereeMakerGameState::Initial {
            initial_state: game_start_info.initial_state.p(),
            initial_validation_program: game_start_info.initial_validation_program.clone(),
            initial_max_move_size: game_start_info.initial_max_move_size,
            initial_puzzle_args: ref_puzzle_args.clone(),
            game_handler: game_start_info.game_handler.clone(),
        });

        Ok(MyTurnReferee {
            fixed: fixed_info,
            max_move_size_from_their_validation: game_start_info.initial_max_move_size,
            message_handler: None,
            mover_share_from_their_move_handler: game_start_info.initial_mover_share.clone(),
            state_from_our_last_turn_handler: game_start_info.initial_state.clone(),
            validation_program_before_our_turn: game_start_info.initial_validation_program.clone(),
        })
    }

    fn get_amount(&self) -> Amount {
        todo!();
    }

    fn get_game_state(&self) -> Rc<Program> {
        todo!();
    }

    pub fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        todo!();
    }

    pub fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        todo!();
    }

    pub fn get_game_handler(&self) -> GameHandler {
        todo!();
    }

    fn get_our_state_for_handler(
        &mut self,
        allocator: &mut AllocEncoder,
    ) -> Result<(Hash, ProgramRef, usize), Error> {
        todo!();
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
        todo!();
    }

    pub fn on_chain_referee_puzzle(
        &self,
        allocator: &mut AllocEncoder
    ) -> Result<Puzzle, Error> {
        todo!();
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
        let args = self.spend_this_coin();
        let spend_puzzle = self.on_chain_referee_puzzle(allocator)?;

        let prog = ValidationProgram::new(allocator, Rc::new(Program::from_bytes(&[0x80])));
        debug!(
            "referee maker: get transaction for move {:?}",
            GameStartInfo {
                game_handler: self.get_game_handler(),
                game_id: GameID::default(),
                amount: self.get_amount(),
                initial_state: self.get_game_state().clone().into(),
                initial_max_move_size: args.game_move.basic.max_move_size,
                initial_move: args.game_move.basic.move_made.clone(),
                initial_mover_share: args.game_move.basic.mover_share.clone(),
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

        // debug!("transaction for move: state {:?}", self.state);
        debug!("get_transaction_for_move: source curry {args:?}");
        let target_args = self.spend_this_coin();
        debug!("get_transaction_for_move: target curry {target_args:?}");
        assert_ne!(
            target_args.mover_puzzle_hash,
            self.fixed.my_identity.puzzle_hash
        );
        assert_ne!(args.mover_puzzle_hash, target_args.mover_puzzle_hash);
        assert_eq!(args.mover_puzzle_hash, target_args.waiter_puzzle_hash);
        // assert!(matches!(
        //     self.state.borrow(),
        //     RefereeMakerGameState::AfterOurTurn { .. }
        // ));
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

    pub fn receive_readable(
        &mut self,
        allocator: &mut AllocEncoder,
        message: &[u8],
    ) -> Result<ReadableMove, Error> {
        // Do stuff with message handler.
        // let (state, move_data, mover_share) = match self.state.borrow() {
        //     RefereeMakerGameState::Initial {
        //         game_handler,
        //         initial_state,
        //         initial_puzzle_args,
        //         ..
        //     } => (
        //         initial_state.clone(),
        //         initial_puzzle_args.game_move.basic.move_made.clone(),
        //         if matches!(game_handler, GameHandler::MyTurnHandler(_)) {
        //             initial_puzzle_args.game_move.basic.mover_share.clone()
        //         } else {
        //             self.fixed.amount.clone()
        //                 - initial_puzzle_args.game_move.basic.mover_share.clone()
        //         },
        //     ),
        //     RefereeMakerGameState::AfterOurTurn {
        //         state,
        //         my_turn_result,
        //         spend_this_coin,
        //         ..
        //     } => (
        //         state.p(),
        //         spend_this_coin.game_move.basic.move_made.clone(),
        //         spend_this_coin.game_move.basic.mover_share.clone(),
        //     ),
        //     RefereeMakerGameState::AfterTheirTurn {
        //         most_recent_our_state_result,
        //         create_this_coin,
        //         ..
        //     } => (
        //         most_recent_our_state_result.clone(),
        //         create_this_coin.game_move.basic.move_made.clone(),
        //         self.fixed.amount.clone() - create_this_coin.game_move.basic.mover_share.clone(),
        //     ),
        // };

        // let result = if let Some(handler) = self.message_handler.as_ref() {
        //     let state_nodeptr = state.to_nodeptr(allocator)?;
        //     handler.run(
        //         allocator,
        //         &MessageInputs {
        //             message: message.to_vec(),
        //             amount: self.fixed.amount.clone(),
        //             state: state_nodeptr,
        //             move_data,
        //             mover_share,
        //         },
        //     )?
        // } else {
        //     return Err(Error::StrErr(
        //         "no message handler but have a message".to_string(),
        //     ));
        // };

        // self.message_handler = None;

        // Ok(result)
        todo!();
    }

    // Since we may need to know new_entropy at a higher layer, we'll need to ensure it
    // gets passed in rather than originating it here.
    pub fn my_turn_make_move(
        &mut self,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove,
        new_entropy: Hash,
        state_number: usize,
    ) -> Result<GameMoveWireData, Error> {
        let game_handler = self.get_game_handler();
        let args = self.spend_this_coin();

        // debug!("my turn state {:?}", self.state);
        debug!("entropy {state_number} {new_entropy:?}");

        let (new_validation_program_hash, state, max_move_size) = self.get_our_state_for_handler(allocator)?;
        let result = Rc::new(game_handler.call_my_turn_driver(
            allocator,
            &MyTurnInputs {
                readable_new_move: readable_move.clone(),
                amount: self.fixed.amount.clone(),
                last_mover_share: args.game_move.basic.mover_share.clone(),
                entropy: new_entropy.clone(),
                last_max_move_size: args.game_move.basic.max_move_size,
                last_move: &args.game_move.basic.move_made,
                #[cfg(test)]
                run_debug: false,
            },
        )?);
        debug!("referee my turn referee move details {:?}", result);

        debug!("my turn result {result:?}");
        debug!("new state {:?}", state);

        let state_node = state.to_clvm(allocator).into_gen()?;
        let vinfo = ValidationInfo::new_from_validation_program_hash_and_state(
            allocator,
            result.validation_program_hash.clone(),
            state_node,
        );
        let game_move = GameMoveStateInfo {
            move_made: result.game_move.basic.move_made.clone(),
            max_move_size: max_move_size,
            mover_share: result.game_move.basic.mover_share.clone(),
        };
        let ref_puzzle_args = Rc::new(RefereePuzzleArgs::new(
            &self.fixed,
            &game_move,
            Some(&args.game_move.validation_info_hash),
            vinfo.hash(),
            None,
            false,
        ));
        assert_eq!(
            Some(&args.game_move.validation_info_hash),
            ref_puzzle_args.previous_validation_info_hash.as_ref()
        );

        let game_move_details = GameMoveDetails {
            basic: game_move,
            validation_info_hash: vinfo.hash().clone(),
        };
        self.accept_this_move(
            &result.waiting_driver,
            args.clone(),
            ref_puzzle_args.clone(),
            result.clone(),
            &game_move_details,
            state.clone(),
            max_move_size,
            state_number,
        )?;

        // self.message_handler = result.message_parser.clone();

        // To make a puzzle hash for unroll: curry the correct parameters into
        // the referee puzzle.
        //
        // Validation_info_hash is hashed together the state and the validation
        // puzzle.
        let new_curried_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            &ref_puzzle_args,
        )?;

        debug!("new_curried_referee_puzzle_hash (our turn) {new_curried_referee_puzzle_hash:?}");

        Ok(GameMoveWireData {
            puzzle_hash_for_unroll: new_curried_referee_puzzle_hash,
            details: game_move_details,
        })
    }

    pub fn accept_this_move(
        &mut self,
        game_handler: &GameHandler,
        current_puzzle_args: Rc<RefereePuzzleArgs>,
        new_puzzle_args: Rc<RefereePuzzleArgs>,
        my_turn_result: Rc<MyTurnResult>,
        details: &GameMoveDetails,
        state: ProgramRef,
        max_move_size: usize,
        state_number: usize,
    ) -> Result<(), Error> {
        debug!("{state_number} accept move {details:?}");
        assert_ne!(
            current_puzzle_args.mover_puzzle_hash,
            new_puzzle_args.mover_puzzle_hash
        );
        assert_eq!(
            current_puzzle_args.mover_puzzle_hash,
            new_puzzle_args.waiter_puzzle_hash
        );
        assert_eq!(
            self.fixed.my_identity.puzzle_hash,
            current_puzzle_args.mover_puzzle_hash
        );
        let new_state = RefereeMakerGameState::AfterOurTurn {
            game_handler: game_handler.clone(),
            my_turn_result,
            create_this_coin: current_puzzle_args,
            spend_this_coin: new_puzzle_args,
            state,
            max_move_size,
        };

        // self.old_states.push(StoredGameState {
        //     state: self.state.clone(),
        //     state_number,
        // });
        // self.state = Rc::new(new_state);
        Ok(())
    }
}
