use std::borrow::Borrow;
use std::rc::Rc;

use clvm_traits::ToClvm;
use clvmr::allocator::NodePtr;
use clvmr::run_program;

use log::debug;

use crate::channel_handler::game_handler::{
    GameHandler, MessageHandler, MessageInputs, MyTurnInputs, MyTurnResult, TheirTurnMoveData,
    TheirTurnResult,
};
use crate::channel_handler::types::{Evidence, GameStartInfo, ReadableMove, StateUpdateProgram, ValidationInfo};
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{standard_solution_partial, ChiaIdentity};
use crate::common::types::{
    chia_dialect, AllocEncoder, Amount, BrokenOutCoinSpendInfo, CoinCondition, CoinSpend,
    CoinString, Error, Hash, IntoErr, Node, Program, Puzzle, PuzzleHash, RcNode, Sha256Input,
    Sha256tree, Spend,
};
use crate::referee::their_turn::{TheirTurnReferee, TheirTurnRefereeMakerGameState};
use crate::referee::types::{
    curry_referee_puzzle, curry_referee_puzzle_hash, GameMoveDetails, GameMoveStateInfo,
    GameMoveWireData, InternalStateUpdateArgs, OnChainRefereeSolution, RMFixed,
    RefereeOnChainTransaction, RefereePuzzleArgs, SlashOutcome, TheirTurnCoinSpentResult,
    TheirTurnMoveResult, StateUpdateMoveArgs, StateUpdateResult,
};
use crate::referee::RefereeByTurn;

// Contains a state of the game for use in currying the coin puzzle or for
// reference when calling the game_handler.
#[derive(Clone, Debug)]
pub enum MyTurnRefereeMakerGameState {
    Initial {
        initial_state: Rc<Program>,
        initial_puzzle_args: Rc<RefereePuzzleArgs>,
        game_handler: GameHandler,
    },
    AfterTheirTurn {
        // Live information for this turn.
        game_handler: GameHandler,
        state_after_their_turn: Rc<Program>,

        // Stored info for referee args
        create_this_coin: Rc<RefereePuzzleArgs>,
        spend_this_coin: Rc<RefereePuzzleArgs>,
    },
}

impl MyTurnRefereeMakerGameState {
    pub fn is_my_turn(&self) -> bool {
        match self {
            MyTurnRefereeMakerGameState::Initial { game_handler, .. } => {
                matches!(game_handler, GameHandler::MyTurnHandler(_))
            }
            MyTurnRefereeMakerGameState::AfterTheirTurn { .. } => true,
        }
    }

    pub fn processing_my_turn(&self) -> bool {
        match self {
            MyTurnRefereeMakerGameState::Initial { .. } => false,
            MyTurnRefereeMakerGameState::AfterTheirTurn { .. } => false,
        }
    }

    pub fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            MyTurnRefereeMakerGameState::Initial {
                initial_puzzle_args,
                ..
            } => initial_puzzle_args.clone(),
            MyTurnRefereeMakerGameState::AfterTheirTurn {
                create_this_coin, ..
            } => create_this_coin.clone(),
        }
    }

    pub fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            MyTurnRefereeMakerGameState::Initial {
                initial_puzzle_args,
                ..
            } => initial_puzzle_args.clone(),
            MyTurnRefereeMakerGameState::AfterTheirTurn {
                spend_this_coin, ..
            } => spend_this_coin.clone(),
        }
    }
}

/// Referee coin has two inner puzzles.
/// Throughout channel handler, the one that's ours is the standard format puzzle
/// to the pubkey of the referee private key (referred to in channel_handler).
///
/// change step 1:
///
/// The flow of things:
///
/// our turn 0th move, we do not call the initial validation program
/// but instead use initial state for the game state.  We pass that state to the game
/// handler along with the local move to get a serialized move and send it.
/// We'll produce a state update by applying the local move and the initial_state to the
/// initial validation program.
///
/// their turn 0th move: we received a serialized move, so we'll use the initial_state with
/// the their turn handler and the serialized move to produce a remote move.  we'll give the
/// remote move to the initial validation program with the initial state and get the next
/// state.
///
/// Each side needs two validation phases in a standard turn.
///
/// The last turn needs to leave behind 2 validation programs.
///
/// The first uses the local move along with the state output from the most recent validation
/// program and produces a new state.
///
/// In the second case, we run the their turn handler with the most recent state and the
/// serialized move, yielding a remove move.  We use the remote move and the most recent
/// state to generate a new state from the their turn validation program.
///
/// The remote side never sees our entropy, that's the main thing that cannot be represented
/// in the game state, as the game state must be shared.
///
/// Anything we must hide from the entropy must be curried into the game handler for use
/// later.
///
/// The flow of a successful subsequent turn is:
///
/// my turn:                                   ┌-------------------------------------------┐
///                                            v                                           |
/// ┌-> my_turn_handler(local_move, state_after_their_turn0) ->                            |
/// |            { serialized_our_move, ------------┐    |                                 |
/// |   ┌--------- their_turn_handler,              |    |                                 |
/// |   |          local_readable_move,             |    |                                 |
/// |   |   ┌----- their_turn_validation_program,   |    |                                 |
/// |   |   |    }                                  |    └------------┐                    |
/// |   |   |                                       |                 |                    |
/// |   |   |                                       v                 v                    |
/// | ┌-|---|->my_turn_validation_program(serialized_our_move, state_after_their_turn0) -> |
/// | | |   |    state_after_our_turn --------------------------------┐                    |
/// | | |   |                                                         |                    |
/// | | |   | their turn:                                             |                    |
/// | | |   v                                                         v                    |
/// | | |   their_turn_validation_program(serialized_their_move, state_after_our_turn) ->  |
/// | | |     state_after_their_turn1 -┐                              |                    |
/// | | |                              |                              |                    |
/// | | v                              |                              |                    |
/// | | their_turn_handler(            ├---------------------------------------------------┘
/// | |   serialized_their_move,       |                              |
/// | |   state_after_their_turn1 <----┘                              |
/// | |   state_after_our_turn, <-------------------------------------┘
/// | | ) ->
/// | |   { remote_readable_move,
/// | └---- my_turn_validation_program,
/// └------ my_turn_handler,
///         evidence, --------------> try these with their_turn_validation_program
///       }
///
/// This assumes an "out of time" aspect to the validation programs.
///
/// In bram's mind the validation programs are a single chain of events:
///
///   a.clsp -> b.clsp -> c.clsp -> d.clsp -> e.clsp -> lambda from e.
///
/// In reality, there are two progressions, one on each side:
///
/// alice: alice handler 0 -> move 0
/// bob: move 0 -> a.clsp with state initial_state
/// bob: bob handler 0 -> move 1
/// alice: move 1 -> b.clsp
/// ...
///
/// In bram's mind, there's no difference between move 0 _leaving_ alice and _arriving_
/// at bob, so we need to ensure that an outgoing move uses the same validation program
/// as the incoming move that follows.
#[derive(Clone, Debug)]
pub struct MyTurnReferee {
    pub fixed: Rc<RMFixed>,

    pub finished: bool,

    pub message_handler: Option<MessageHandler>,

    pub state: Rc<MyTurnRefereeMakerGameState>,
    pub state_number: usize,
    pub parent: Option<Rc<TheirTurnReferee>>,
}

impl MyTurnReferee {
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
        let state = Rc::new(MyTurnRefereeMakerGameState::Initial {
            initial_state: game_start_info.initial_state.p(),
            initial_puzzle_args: ref_puzzle_args.clone(),
            game_handler: game_start_info.game_handler.clone(),
        });
        let puzzle_hash =
            curry_referee_puzzle_hash(allocator, &referee_coin_puzzle_hash, &ref_puzzle_args)?;

        Ok((
            MyTurnReferee {
                fixed: fixed_info,
                finished: false,
                state,
                state_number,
                message_handler: None,
                parent: None,
            },
            puzzle_hash,
        ))
    }

    pub fn state(&self) -> Rc<MyTurnRefereeMakerGameState> {
        self.state.clone()
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
        true
    }

    pub fn processing_my_turn(&self) -> bool {
        false
    }

    pub fn get_game_handler(&self) -> GameHandler {
        match self.state.borrow() {
            MyTurnRefereeMakerGameState::Initial { game_handler, .. }
            | MyTurnRefereeMakerGameState::AfterTheirTurn { game_handler, .. } => {
                game_handler.clone()
            }
        }
    }

    pub fn get_game_state(&self) -> Rc<Program> {
        match self.state.borrow() {
            MyTurnRefereeMakerGameState::Initial { initial_state, .. } => initial_state.clone(),
            MyTurnRefereeMakerGameState::AfterTheirTurn {
                state_after_their_turn,
                ..
            } => state_after_their_turn.clone(),
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

    pub fn accept_this_move(
        &self,
        game_handler: &GameHandler,
        current_puzzle_args: Rc<RefereePuzzleArgs>,
        new_puzzle_args: Rc<RefereePuzzleArgs>,
        new_state: Rc<Program>,
        my_turn_result: Rc<MyTurnResult>,
        details: &GameMoveStateInfo,
        validation_info_hash: &ValidationInfo,
        message_handler: Option<MessageHandler>,
        state_number: usize,
    ) -> Result<TheirTurnReferee, Error> {
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
        let new_state = TheirTurnRefereeMakerGameState::AfterOurTurn {
            their_turn_game_handler: game_handler.clone(),
            their_turn_validation_program: my_turn_result.incoming_move_state_update_program.clone(),
            state_after_our_turn: new_state.clone(),
            create_this_coin: current_puzzle_args,
            spend_this_coin: new_puzzle_args,
        };

        let new_parent = MyTurnReferee {
            state_number,
            ..self.clone()
        };
        Ok(TheirTurnReferee {
            fixed: self.fixed.clone(),
            finished: self.finished,
            message_handler,
            state: Rc::new(new_state),
            state_number,
            parent: Some(Rc::new(new_parent)),
        })
    }

    // Since we may need to know new_entropy at a higher layer, we'll need to ensure it
    // gets passed in rather than originating it here.
    pub fn my_turn_make_move(
        &self,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove,
        new_entropy: Hash,
        state_number: usize,
    ) -> Result<(RefereeByTurn, GameMoveWireData), Error> {
        assert!(self.is_my_turn());

        let game_handler = self.get_game_handler();
        let args = self.spend_this_coin();

        debug!("my turn state {:?}", self.state);
        debug!("entropy {state_number} {new_entropy:?}");
        let result = Rc::new(game_handler.call_my_turn_driver(
            allocator,
            &MyTurnInputs {
                readable_new_move: readable_move.clone(),
                amount: self.fixed.amount.clone(),
                last_move: &args.game_move.basic.move_made,
                last_mover_share: args.game_move.basic.mover_share.clone(),
                last_max_move_size: args.game_move.basic.max_move_size,
                entropy: new_entropy.clone(),
            },
        )?);
        debug!("referee my turn referee move details {:?}", result);
        debug!("my turn result {result:?}");

        let state_to_update =
            match self.state.borrow() {
                MyTurnRefereeMakerGameState::Initial {
                    initial_state,
                    ..
                } => {
                    initial_state.clone()
                },
                MyTurnRefereeMakerGameState::AfterTheirTurn {
                    state_after_their_turn,
                    ..
                } => {
                    state_after_their_turn.clone()
                }
            };

        let (new_state_following_my_move, validation_info_hash) = self.run_validator_for_my_move(
            allocator,
            &args.game_move.basic.move_made,
            result.outgoing_move_state_update_program.clone(),
            state_to_update,
            Evidence::nil()?,
        )?;
        debug!("new_state_for_my_move {new_state_following_my_move:?}");
        let ref_puzzle_args = Rc::new(RefereePuzzleArgs::new(
            &self.fixed,
            &result.game_move,
            Some(&args.game_move.validation_info_hash),
            &validation_info_hash.hash(),
            None,
            false,
        ));

        let new_self = self.accept_this_move(
            &result.waiting_driver,
            args.clone(),
            ref_puzzle_args.clone(),
            new_state_following_my_move,
            result.clone(),
            &result.game_move,
            &validation_info_hash,
            result.message_parser.clone(),
            state_number,
        )?;

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

        Ok((
            RefereeByTurn::TheirTurn(Rc::new(new_self)),
            GameMoveWireData {
                puzzle_hash_for_unroll: new_curried_referee_puzzle_hash,
                details: GameMoveDetails {
                    basic: result.game_move.clone(),
                    validation_info_hash: validation_info_hash.hash().clone(),
                },
            },
        ))
    }

    pub fn receive_readable(
        &self,
        allocator: &mut AllocEncoder,
        message: &[u8],
    ) -> Result<ReadableMove, Error> {
        // Do stuff with message handler.
        let (state, move_data, mover_share) = match self.state.borrow() {
            MyTurnRefereeMakerGameState::Initial {
                game_handler,
                initial_state,
                initial_puzzle_args,
                ..
            } => (
                initial_state,
                initial_puzzle_args.game_move.basic.move_made.clone(),
                if matches!(game_handler, GameHandler::MyTurnHandler(_)) {
                    initial_puzzle_args.game_move.basic.mover_share.clone()
                } else {
                    self.fixed.amount.clone()
                        - initial_puzzle_args.game_move.basic.mover_share.clone()
                },
            ),
            MyTurnRefereeMakerGameState::AfterTheirTurn {
                state_after_their_turn,
                create_this_coin,
                ..
            } => (
                state_after_their_turn,
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

    pub fn run_validator_for_my_move(
        &self,
        allocator: &mut AllocEncoder,
        serialized_move: &[u8],
        outgoing_state_update_program: StateUpdateProgram,
        state: Rc<Program>,
        evidence: Evidence,
    ) -> Result<(Rc<Program>, ValidationInfo), Error> {
        let puzzle_args = self.args_for_this_coin();
        let new_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            &puzzle_args
        )?;

        let solution = self.fixed.my_identity.standard_solution(
            allocator,
            &[(
                self.fixed.my_identity.puzzle_hash.clone(),
                Amount::default(),
            )],
        )?;
        let solution_program = Rc::new(Program::from_nodeptr(allocator, solution)?);
        let validator_move_args = InternalStateUpdateArgs {
            move_made: serialized_move.to_vec(),
            turn: false,
            // Unused by validator, present for the referee.
            new_validation_info_hash: Default::default(),
            mover_share: puzzle_args.game_move.basic.mover_share.clone(),
            previous_validation_info_hash: Default::default(),
            mover_puzzle_hash: puzzle_args.mover_puzzle_hash.clone(),
            waiter_puzzle_hash: puzzle_args.waiter_puzzle_hash.clone(),
            amount: self.fixed.amount.clone(),
            timeout: self.fixed.timeout.clone(),
            max_move_size: puzzle_args.game_move.basic.max_move_size,
            referee_hash: new_puzzle_hash.clone(),
            move_args: StateUpdateMoveArgs {
                evidence: evidence.to_program(),
                state: state.clone(),
                mover_puzzle: self.fixed.my_identity.puzzle.to_program(),
                solution: solution_program,
            },
        };
        let outgoing_state_update_program_mod_hash = outgoing_state_update_program.hash();
        debug!("state_update_program_mod_hash {outgoing_state_update_program_mod_hash:?}");
        let validation_program_nodeptr = outgoing_state_update_program.to_nodeptr(allocator)?;
        let validator_full_args_node = validator_move_args.to_nodeptr(
            allocator,
            validation_program_nodeptr,
            PuzzleHash::from_hash(outgoing_state_update_program_mod_hash.clone()),
        )?;
        let validator_full_args = Program::from_nodeptr(allocator, validator_full_args_node)?;

        debug!("validator program {:?}", outgoing_state_update_program);
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
        let result = StateUpdateResult::from_nodeptr(allocator, raw_result.1)?;

        match result {
            StateUpdateResult::Slash(_) => {
                Err(Error::StrErr("our own move was slashed by us".to_string()))
            }
            StateUpdateResult::MoveOk(state) => {
                let state_nodeptr = state.to_nodeptr(allocator)?;
                Ok((state.clone(), ValidationInfo::new(
                    allocator,
                    outgoing_state_update_program.clone(),
                    state_nodeptr,
                )))
            }
        }
    }

    pub fn run_validator_for_their_move(
        &self,
        allocator: &mut AllocEncoder,
        outgoing_move_state_update_program: StateUpdateProgram,
        state: Rc<Program>,
        evidence: Evidence,
    ) -> Result<StateUpdateResult, Error> {
        let previous_puzzle_args = self.args_for_this_coin();
        let puzzle_args = self.spend_this_coin();
        let new_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            &puzzle_args,
        )?;

        let solution = self.fixed.my_identity.standard_solution(
            allocator,
            &[(
                self.fixed.my_identity.puzzle_hash.clone(),
                Amount::default(),
            )],
        )?;
        let solution_program = Rc::new(Program::from_nodeptr(allocator, solution)?);
        let validator_move_args = InternalStateUpdateArgs {
            move_made: puzzle_args.game_move.basic.move_made.clone(),
            turn: true,
            new_validation_info_hash: puzzle_args.game_move.validation_info_hash.clone(),
            mover_share: puzzle_args.game_move.basic.mover_share.clone(),
            previous_validation_info_hash: previous_puzzle_args
                .game_move
                .validation_info_hash
                .clone(),
            mover_puzzle_hash: puzzle_args.mover_puzzle_hash.clone(),
            waiter_puzzle_hash: puzzle_args.waiter_puzzle_hash.clone(),
            amount: self.fixed.amount.clone(),
            timeout: self.fixed.timeout.clone(),
            max_move_size: puzzle_args.game_move.basic.max_move_size,
            referee_hash: new_puzzle_hash.clone(),
            move_args: StateUpdateMoveArgs {
                evidence: evidence.to_program(),
                state: state.clone(),
                mover_puzzle: self.fixed.my_identity.puzzle.to_program(),
                solution: solution_program,
            },
        };

        debug!("getting validation program");
        debug!("my turn {}", self.is_my_turn());
        debug!("state {:?}", self.state);
        debug!("outgoing_move_state_update_program {outgoing_move_state_update_program:?}");
        let validation_program_mod_hash = outgoing_move_state_update_program.hash();
        debug!("validation_program_mod_hash {validation_program_mod_hash:?}");
        let validation_program_nodeptr = outgoing_move_state_update_program.to_nodeptr(allocator)?;

        let validator_full_args_node = validator_move_args.to_nodeptr(
            allocator,
            validation_program_nodeptr,
            PuzzleHash::from_hash(validation_program_mod_hash.clone()),
        )?;
        let validator_full_args = Program::from_nodeptr(allocator, validator_full_args_node)?;

        debug!("validator program {:?}", outgoing_move_state_update_program);
        debug!("validator args {:?}", validator_full_args);

        // Error means validation should not work.
        // It should be handled later.
        let raw_result = run_program(
            allocator.allocator(),
            &chia_dialect(),
            validation_program_nodeptr,
            validator_full_args_node,
            0,
        ).into_gen()?;

        let result_prog = Program::from_nodeptr(allocator, raw_result.1)?;
        debug!("their turn validator result {result_prog:?}");

        StateUpdateResult::from_nodeptr(allocator, raw_result.1)
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
}
