use std::borrow::Borrow;
use std::rc::Rc;

use clvm_traits::ToClvm;

use log::debug;

use crate::channel_handler::types::{Evidence, ReadableMove, ValidationInfo};
use crate::channel_handler::v1::game_handler::{
    GameHandler, MessageHandler, MyTurnInputs, MyTurnResult,
};
use crate::channel_handler::v1::game_start_info::GameStartInfo;
use crate::common::standard_coin::ChiaIdentity;
use crate::common::types::{
    AllocEncoder, Amount, CoinString, Error, Hash, IntoErr, Program, Puzzle, PuzzleHash,
    Sha256tree, Spend,
};
use crate::referee::types::{
    GameMoveDetails, GameMoveStateInfo, GameMoveWireData, RefereeOnChainTransaction, IdentityCoinAndSolution,
};
use crate::referee::v1::their_turn::{TheirTurnReferee, TheirTurnRefereeMakerGameState};
use crate::referee::v1::types::{
    curry_referee_puzzle, curry_referee_puzzle_hash, InternalStateUpdateArgs,
    OnChainRefereeSolution, RMFixed, RefereePuzzleArgs, StateUpdateMoveArgs, StateUpdateResult,
    OnChainRefereeMoveData, OnChainRefereeSlashData,
};
use crate::referee::v1::RefereeByTurn;

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
        game_handler: Option<GameHandler>,
        state_after_their_turn: Rc<Program>,

        // Stored info for referee args
        create_this_coin: Rc<RefereePuzzleArgs>,
        spend_this_coin: Rc<RefereePuzzleArgs>,

        // How to spend
        slash_spend: Rc<OnChainRefereeSlashData>,
    },
}

#[allow(dead_code)]
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

    pub fn max_move_size(&self) -> usize {
        match self {
            MyTurnRefereeMakerGameState::Initial {
                initial_puzzle_args,
                ..
            } => initial_puzzle_args.game_move.basic.max_move_size,
            MyTurnRefereeMakerGameState::AfterTheirTurn {
                spend_this_coin, ..
            } => spend_this_coin.game_move.basic.max_move_size,
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
    pub enable_cheating: Option<Vec<u8>>,

    #[allow(dead_code)]
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
                enable_cheating: None,
            },
            puzzle_hash,
        ))
    }

    #[allow(dead_code)]
    pub fn parent(&self) -> Option<Rc<TheirTurnReferee>> {
        self.parent.clone()
    }

    #[allow(dead_code)]
    pub fn state(&self) -> Rc<MyTurnRefereeMakerGameState> {
        self.state.clone()
    }

    #[allow(dead_code)]
    pub fn state_number(&self) -> usize {
        self.state_number
    }

    #[allow(dead_code)]
    pub fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        self.state.args_for_this_coin()
    }

    #[allow(dead_code)]
    pub fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        self.state.spend_this_coin()
    }

    #[allow(dead_code)]
    pub fn is_my_turn(&self) -> bool {
        true
    }

    #[allow(dead_code)]
    pub fn processing_my_turn(&self) -> bool {
        false
    }

    #[allow(dead_code)]
    pub fn enable_cheating(&self, make_move: &[u8]) -> MyTurnReferee {
        MyTurnReferee {
            enable_cheating: Some(make_move.to_vec()),
            ..self.clone()
        }
    }

    #[allow(dead_code)]
    pub fn get_game_handler(&self) -> Option<GameHandler> {
        match self.state.borrow() {
            MyTurnRefereeMakerGameState::Initial { game_handler, .. } => Some(game_handler.clone()),
            MyTurnRefereeMakerGameState::AfterTheirTurn { game_handler, .. } => {
                game_handler.clone()
            }
        }
    }

    #[allow(dead_code)]
    pub fn get_game_state(&self) -> Rc<Program> {
        match self.state.borrow() {
            MyTurnRefereeMakerGameState::Initial { initial_state, .. } => initial_state.clone(),
            MyTurnRefereeMakerGameState::AfterTheirTurn {
                state_after_their_turn,
                ..
            } => state_after_their_turn.clone(),
        }
    }

    #[allow(dead_code)]
    pub fn get_amount(&self) -> Amount {
        self.fixed.amount.clone()
    }

    #[allow(dead_code)]
    pub fn get_our_current_share(&self) -> Amount {
        let args = self.spend_this_coin();
        if self.processing_my_turn() {
            self.fixed.amount.clone() - args.game_move.basic.mover_share.clone()
        } else {
            args.game_move.basic.mover_share.clone()
        }
    }

    #[allow(dead_code)]
    pub fn get_their_current_share(&self) -> Amount {
        self.fixed.amount.clone() - self.get_our_current_share()
    }

    #[allow(clippy::too_many_arguments)]
    #[allow(dead_code)]
    pub fn accept_this_move(
        &self,
        game_handler: GameHandler,
        new_state: Rc<Program>,
        current_puzzle_args: Rc<RefereePuzzleArgs>,
        new_puzzle_args: Rc<RefereePuzzleArgs>,
        my_turn_result: Rc<MyTurnResult>,
        message_handler: Option<MessageHandler>,
        state_number: usize,
    ) -> Result<TheirTurnReferee, Error> {
        let move_spend = Rc::new(OnChainRefereeMoveData {
            validation_program: my_turn_result.outgoing_move_state_update_program.clone(),
            state: new_state.clone(),
            new_move: new_puzzle_args.game_move.clone(),
            puzzle_args: current_puzzle_args.clone(),
        });

        debug!(
            "MY TURN FINISHED WITH STATE {new_state:?} REPLACING {:?}",
            self.get_game_state()
        );
        let new_state = TheirTurnRefereeMakerGameState::AfterOurTurn {
            their_turn_game_handler: game_handler.clone(),
            their_turn_validation_program: my_turn_result
                .incoming_move_state_update_program
                .clone(),
            state_after_our_turn: new_state.clone(),
            create_this_coin: current_puzzle_args,
            spend_this_coin: new_puzzle_args,
            move_spend,
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
    #[allow(dead_code)]
    pub fn my_turn_make_move(
        &self,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove,
        new_entropy: Hash,
        state_number: usize,
    ) -> Result<(RefereeByTurn, GameMoveWireData), Error> {
        assert!(self.is_my_turn());

        let game_handler = if let Some(gh) = self.get_game_handler() {
            gh
        } else {
            return Err(Error::StrErr(
                "move made but we passed the final move".to_string(),
            ));
        };

        let args = self.spend_this_coin();

        debug!("my turn state {:?}", self.state);
        debug!("entropy {state_number} {new_entropy:?}");
        let mut result = Rc::new(game_handler.call_my_turn_driver(
            allocator,
            &MyTurnInputs {
                readable_new_move: readable_move.clone(),
                amount: self.fixed.amount.clone(),
                last_mover_share: args.game_move.basic.mover_share.clone(),
                entropy: new_entropy.clone(),
            },
        )?);

        if let Some(fake_move) = &self.enable_cheating {
            let result_borrow: &MyTurnResult = result.borrow();
            debug!("my_turn_make_move: cheating with move bytes {fake_move:?}");
            result = Rc::new(MyTurnResult {
                move_bytes: fake_move.clone(),
                ..result_borrow.clone()
            });
        }

        debug!("my turn result {result:?}");

        let state_to_update = match self.state.borrow() {
            MyTurnRefereeMakerGameState::Initial { initial_state, .. } => initial_state.clone(),
            MyTurnRefereeMakerGameState::AfterTheirTurn {
                state_after_their_turn,
                ..
            } => state_after_their_turn.clone(),
        };

        debug!("my turn start with state {state_to_update:?}");
        debug!(
            "about to call my validator for my move with move bytes {:?}",
            result.move_bytes
        );
        let puzzle_args = self.spend_this_coin();
        let ref_puzzle_args: &RefereePuzzleArgs = puzzle_args.borrow();
        let v = ValidationInfo::new_state_update(
            allocator,
            result.outgoing_move_state_update_program.clone(),
            state_to_update.clone(),
        );
        let game_move_details = GameMoveDetails {
            basic: GameMoveStateInfo {
                move_made: result.move_bytes.clone(),
                mover_share: result.mover_share.clone(),
                max_move_size: result.max_move_size,
            },
            validation_info_hash: v.hash().clone(),
        };
        let rc_puzzle_args = Rc::new(RefereePuzzleArgs {
            mover_puzzle_hash: self.fixed.their_referee_puzzle_hash.clone(),
            waiter_puzzle_hash: self.fixed.my_identity.puzzle_hash.clone(),
            game_move: game_move_details.clone(),
            validation_program: result.outgoing_move_state_update_program.clone(),
            previous_validation_info_hash: if matches!(
                *self.state,
                MyTurnRefereeMakerGameState::Initial { .. }
            ) {
                None
            } else {
                Some(ref_puzzle_args.game_move.validation_info_hash.clone())
            },
            ..ref_puzzle_args.clone()
        });
        debug!(
            "running validator program {:?}",
            rc_puzzle_args.validation_program.to_program()
        );
        let new_state_following_my_move = self.run_validator_for_my_move(
            allocator,
            rc_puzzle_args.clone(),
            state_to_update,
            Evidence::nil()?,
        )?;

        debug!("state following my turn {new_state_following_my_move:?}");
        debug!(
            "corresponding new validation program {:?}",
            result
                .incoming_move_state_update_program
                .sha256tree(allocator)
        );

        let new_self = self.accept_this_move(
            result.waiting_driver.clone(),
            new_state_following_my_move,
            args.clone(),
            rc_puzzle_args.clone(),
            result.clone(),
            result.message_parser.clone(),
            state_number,
        )?;

        // To make a puzzle hash for unroll: curry the correct parameters into
        // the referee puzzle.
        //
        // Validation_info_hash is hashed together the state and the validation
        // puzzle.
        debug!("<W> {ref_puzzle_args:?}");
        let new_curried_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            ref_puzzle_args,
        )?;

        debug!("new_curried_referee_puzzle_hash (our turn) {new_curried_referee_puzzle_hash:?}");

        let new_self = RefereeByTurn::TheirTurn(Rc::new(new_self));
        debug!("final inputs {:?}", new_self.spend_this_coin());
        Ok((
            new_self,
            GameMoveWireData {
                puzzle_hash_for_unroll: new_curried_referee_puzzle_hash,
                details: game_move_details,
            },
        ))
    }

    #[allow(dead_code)]
    pub fn on_chain_referee_puzzle(&self, allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
        let args = self.args_for_this_coin();
        curry_referee_puzzle(allocator, &self.fixed.referee_coin_puzzle, &args)
    }

    #[allow(dead_code)]
    pub fn outcome_referee_puzzle(&self, allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
        let args = self.spend_this_coin();
        curry_referee_puzzle(allocator, &self.fixed.referee_coin_puzzle, &args)
    }

    #[allow(dead_code)]
    pub fn on_chain_referee_puzzle_hash(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error> {
        let args = self.args_for_this_coin();
        curry_referee_puzzle_hash(allocator, &self.fixed.referee_coin_puzzle_hash, &args)
    }

    #[allow(dead_code)]
    pub fn outcome_referee_puzzle_hash(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error> {
        let args = self.spend_this_coin();
        curry_referee_puzzle_hash(allocator, &self.fixed.referee_coin_puzzle_hash, &args)
    }

    #[allow(dead_code)]
    pub fn run_validator_for_my_move(
        &self,
        allocator: &mut AllocEncoder,
        referee_args: Rc<RefereePuzzleArgs>,
        state: Rc<Program>,
        evidence: Evidence,
    ) -> Result<Rc<Program>, Error> {
        let solution = self.fixed.my_identity.standard_solution(
            allocator,
            &[(
                self.fixed.my_identity.puzzle_hash.clone(),
                Amount::default(),
            )],
        )?;
        let solution_program = Rc::new(Program::from_nodeptr(allocator, solution)?);
        debug!("my turn update using state {state:?}");
        let validator_move_args = InternalStateUpdateArgs {
            validation_program: referee_args.validation_program.clone(),
            referee_args: Rc::new(referee_args.swap()),
            state_update_args: StateUpdateMoveArgs {
                evidence: evidence.to_program(),
                state: state.clone(),
                mover_puzzle: self.fixed.my_identity.puzzle.to_program(),
                solution: solution_program,
            },
        };
        let result = validator_move_args.run(allocator)?;
        match result {
            StateUpdateResult::Slash(_) => {
                if self.enable_cheating.is_some() {
                    Ok(state.clone())
                } else {
                    Err(Error::StrErr("our own move was slashed by us".to_string()))
                }
            }
            StateUpdateResult::MoveOk(new_state) => {
                debug!(
                    "<V> new state for my move {:?} {new_state:?}",
                    referee_args.validation_program.sha256tree(allocator)
                );
                Ok(new_state.clone())
            }
        }
    }
}
