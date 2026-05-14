use std::borrow::Borrow;
use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::channel_handler::game_handler::{
    GameHandler, MessageHandler, MyTurnInputs, MyTurnResult,
};
use crate::channel_handler::game_start_info::GameStartInfo;
use crate::channel_handler::types::{Evidence, ReadableMove, ValidationInfo};

use crate::common::standard_coin::ChiaIdentity;
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, Error, Hash, Program, ProgramRef, PublicKey, Puzzle, PuzzleHash,
    Sha256tree,
};
use crate::referee::referee_initial_setup;
use crate::referee::their_turn::{TheirTurnReferee, TheirTurnRefereeGameState};
use crate::referee::types::{
    canonical_atom_from_usize, GameMoveDetails, GameMoveStateInfo, GameMoveWireData, RMFixed,
    ValidationInfoHash,
};
use crate::referee::types::{
    curry_referee_puzzle, curry_referee_puzzle_hash, InternalStateUpdateArgs,
    OnChainRefereeMoveData, RefereePuzzleArgs, StateUpdateMoveArgs,
};
use crate::referee::Referee;

// Contains a state of the game for use in currying the coin puzzle or for
// reference when calling the game_handler.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum MyTurnRefereeGameState {
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
        move_spend: Option<Rc<OnChainRefereeMoveData>>,
    },
}

impl MyTurnRefereeGameState {
    pub fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            MyTurnRefereeGameState::Initial {
                initial_puzzle_args,
                ..
            } => initial_puzzle_args.clone(),
            MyTurnRefereeGameState::AfterTheirTurn {
                create_this_coin, ..
            } => create_this_coin.clone(),
        }
    }

    pub fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            MyTurnRefereeGameState::Initial {
                initial_puzzle_args,
                ..
            } => initial_puzzle_args.clone(),
            MyTurnRefereeGameState::AfterTheirTurn {
                spend_this_coin, ..
            } => spend_this_coin.clone(),
        }
    }
}

/// Referee coin is curried with two public keys (mover and waiter), which swap
/// roles each turn.  The mover signs moves via AGG_SIG_ME; the waiter can
/// claim via timeout.
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
/// On-chain, the validation programs form a single chain of events:
///
///   a.clsp -> b.clsp -> c.clsp -> d.clsp -> e.clsp -> lambda from e.
///
/// Off-chain (on the players' machines), there are two progressions, one on
/// each side:
///
/// alice: alice handler 0 -> move 0
/// bob: move 0 -> a.clsp with state initial_state
/// bob: bob handler 0 -> move 1
/// alice: move 1 -> b.clsp
/// ...
///
/// On-chain there's no difference between move 0 _leaving_ alice and
/// _arriving_ at bob, so we need to ensure that an outgoing move uses the
/// same validation program as the incoming move that follows.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MyTurnReferee {
    pub fixed: Rc<RMFixed>,

    pub finished: bool,
    pub enable_cheating: Option<(Vec<u8>, Amount)>,

    pub state: Rc<MyTurnRefereeGameState>,
    pub state_number: usize,
    pub parent: Option<Rc<TheirTurnReferee>>,
}

impl MyTurnReferee {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        allocator: &mut AllocEncoder,
        referee_coin_puzzle: Puzzle,
        referee_coin_puzzle_hash: PuzzleHash,
        game_start_info: &Rc<GameStartInfo>,
        my_identity: ChiaIdentity,
        their_pubkey: &PublicKey,
        their_reward_puzzle_hash: &PuzzleHash,
        their_reward_payout_signature: &Aggsig,
        reward_puzzle_hash: &PuzzleHash,
        nonce: u64,
        agg_sig_me_additional_data: &Hash,
        state_number: usize,
    ) -> Result<(Self, PuzzleHash), Error> {
        let setup = referee_initial_setup(
            allocator,
            referee_coin_puzzle,
            referee_coin_puzzle_hash,
            game_start_info,
            my_identity,
            their_pubkey,
            their_reward_puzzle_hash,
            their_reward_payout_signature,
            reward_puzzle_hash,
            nonce,
            agg_sig_me_additional_data,
        )?;

        let state = Rc::new(MyTurnRefereeGameState::Initial {
            initial_state: game_start_info.initial_state.p(),
            initial_puzzle_args: setup.ref_puzzle_args,
            game_handler: game_start_info.game_handler.clone(),
        });

        Ok((
            MyTurnReferee {
                fixed: setup.fixed,
                finished: false,
                state,
                state_number,
                parent: None,
                enable_cheating: None,
            },
            setup.puzzle_hash,
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
        true
    }

    pub fn processing_my_turn(&self) -> bool {
        false
    }

    pub fn enable_cheating(&self, make_move: &[u8], mover_share: Amount) -> MyTurnReferee {
        MyTurnReferee {
            enable_cheating: Some((make_move.to_vec(), mover_share)),
            ..self.clone()
        }
    }

    pub fn get_game_handler(&self) -> Option<GameHandler> {
        match self.state.borrow() {
            MyTurnRefereeGameState::Initial { game_handler, .. } => Some(game_handler.clone()),
            MyTurnRefereeGameState::AfterTheirTurn { game_handler, .. } => game_handler.clone(),
        }
    }

    pub fn get_move_info(&self) -> Option<Rc<OnChainRefereeMoveData>> {
        match self.state.borrow() {
            MyTurnRefereeGameState::Initial { .. } => None,
            MyTurnRefereeGameState::AfterTheirTurn { move_spend, .. } => move_spend.clone(),
        }
    }

    pub fn get_amount(&self) -> Amount {
        self.fixed.amount.clone()
    }

    pub fn get_our_current_share(&self) -> Result<Amount, Error> {
        let args = self.spend_this_coin();
        if self.processing_my_turn() {
            self.fixed
                .amount
                .checked_sub(&args.game_move.basic.mover_share)
        } else {
            Ok(args.game_move.basic.mover_share.clone())
        }
    }

    pub fn get_their_current_share(&self) -> Result<Amount, Error> {
        self.fixed
            .amount
            .checked_sub(&self.get_our_current_share()?)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn accept_this_move(
        &self,
        game_handler: Option<GameHandler>,
        new_state: Rc<Program>,
        current_state: Rc<Program>,
        current_puzzle_args: Rc<RefereePuzzleArgs>,
        new_puzzle_args: Rc<RefereePuzzleArgs>,
        my_turn_result: Rc<MyTurnResult>,
        message_handler: Option<MessageHandler>,
        state_number: usize,
    ) -> Result<TheirTurnReferee, Error> {
        let move_spend = Rc::new(OnChainRefereeMoveData {
            validation_program: my_turn_result.outgoing_move_state_update_program.clone(),
            state: current_state.clone(),
            new_move: new_puzzle_args.game_move.clone(),
            before_args: current_puzzle_args.clone(),
            after_args: new_puzzle_args.clone(),
        });

        let new_state = TheirTurnRefereeGameState {
            game_handler: game_handler.clone(),
            their_turn_validation_program: my_turn_result
                .incoming_move_state_update_program
                .clone(),
            slash_validation_program: my_turn_result.outgoing_move_state_update_program.clone(),
            current_state: new_state.clone(),
            slash_state: current_state.clone(),
            create_this_coin: current_puzzle_args,
            spend_this_coin: new_puzzle_args,
            move_spend: Some(move_spend),
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
    ) -> Result<(Referee, GameMoveWireData), Error> {
        game_assert!(
            self.is_my_turn(),
            "my_turn_make_move called when not my turn"
        );

        let game_handler = if let Some(gh) = self.get_game_handler() {
            gh
        } else {
            return Err(Error::StrErr(
                "move made but we passed the final move".to_string(),
            ));
        };

        let args = self.spend_this_coin();

        let state_to_update = match self.state.borrow() {
            MyTurnRefereeGameState::Initial { initial_state, .. } => initial_state.clone(),
            MyTurnRefereeGameState::AfterTheirTurn {
                state_after_their_turn,
                ..
            } => state_after_their_turn.clone(),
        };

        let result = if let Some((ref fake_move, ref cheat_share)) = self.enable_cheating {
            Rc::new(MyTurnResult {
                name: "cheat".to_string(),
                move_bytes: fake_move.clone(),
                mover_share: cheat_share.clone(),
                max_move_size: args.game_move.basic.max_move_size,
                outgoing_move_state_update_program: args.validation_program.clone(),
                outgoing_move_state_update_program_hash: args
                    .validation_program
                    .sha256tree(allocator)
                    .hash()
                    .clone(),
                incoming_move_state_update_program: args.validation_program.clone(),
                incoming_move_state_update_program_hash: args
                    .validation_program
                    .sha256tree(allocator)
                    .hash()
                    .clone(),
                waiting_handler: Some(game_handler.clone()),
                message_parser: None,
            })
        } else {
            Rc::new(game_handler.call_my_turn_handler(
                allocator,
                &MyTurnInputs {
                    readable_new_move: readable_move.clone(),
                    amount: self.fixed.amount.clone(),
                    last_mover_share: args.game_move.basic.mover_share.clone(),
                    entropy: new_entropy.clone(),
                    state: ProgramRef::new(state_to_update.clone()),
                },
            )?)
        };

        let puzzle_args = self.spend_this_coin();
        let ref_puzzle_args: &RefereePuzzleArgs = puzzle_args.borrow();
        let v = ValidationInfo::new_state_update(
            allocator,
            result.outgoing_move_state_update_program.clone(),
            state_to_update.clone(),
        );
        let validation_program_hash = if result.waiting_handler.is_some() {
            ValidationInfoHash::Hash(v.hash().clone())
        } else {
            ValidationInfoHash::None
        };
        let game_move_details = GameMoveDetails {
            basic: GameMoveStateInfo {
                move_made: result.move_bytes.clone(),
                mover_share: result.mover_share.clone(),
                max_move_size_raw: canonical_atom_from_usize(result.max_move_size),
                max_move_size: result.max_move_size,
            },
            validation_program_hash,
        };
        let prev_hash = ref_puzzle_args.game_move.validation_program_hash.clone();
        let offchain_puzzle_args = Rc::new(RefereePuzzleArgs {
            mover_pubkey: self.fixed.their_referee_pubkey.clone(),
            waiter_pubkey: self.fixed.my_identity.public_key.clone(),
            game_move: game_move_details.clone(),
            validation_program: result.outgoing_move_state_update_program.clone(),
            previous_validation_info_hash: prev_hash.clone(),
            ..ref_puzzle_args.clone()
        });
        let new_state_following_my_move = if result.waiting_handler.is_some() {
            self.run_validator_for_my_move(
                allocator,
                offchain_puzzle_args,
                state_to_update.clone(),
                Evidence::nil()?,
            )?
        } else {
            state_to_update.clone()
        };

        let rc_puzzle_args = Rc::new(RefereePuzzleArgs {
            mover_pubkey: self.fixed.their_referee_pubkey.clone(),
            waiter_pubkey: self.fixed.my_identity.public_key.clone(),
            game_move: game_move_details.clone(),
            validation_program: result.outgoing_move_state_update_program.clone(),
            previous_validation_info_hash: prev_hash,
            ..ref_puzzle_args.clone()
        });

        let new_self = self.accept_this_move(
            result.waiting_handler.clone(),
            new_state_following_my_move,
            state_to_update,
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
        let new_curried_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            ref_puzzle_args,
        )?;

        let new_self = Referee::TheirTurn(Rc::new(new_self));
        Ok((
            new_self,
            GameMoveWireData {
                puzzle_hash_for_unroll: new_curried_referee_puzzle_hash,
                details: game_move_details,
            },
        ))
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

    pub fn run_validator_for_my_move(
        &self,
        allocator: &mut AllocEncoder,
        referee_args: Rc<RefereePuzzleArgs>,
        state: Rc<Program>,
        evidence: Evidence,
    ) -> Result<Rc<Program>, Error> {
        let validator_move_args = InternalStateUpdateArgs {
            validation_program: referee_args.validation_program.clone(),
            referee_args: Rc::new(referee_args.swap()),
            state_update_args: StateUpdateMoveArgs {
                evidence: evidence.to_program(),
                state: state.clone(),
            },
        };
        let result = validator_move_args.run(allocator);
        match result {
            Err(e) => {
                if self.enable_cheating.is_some() {
                    Ok(state.clone())
                } else {
                    Err(e)
                }
            }
            Ok(None) => {
                if self.enable_cheating.is_some() {
                    Ok(state.clone())
                } else {
                    Err(Error::StrErr(format!(
                        "pre-send validation rejected our move: nonce={}, move_len={}, mover_share={:?}, state={:?}",
                        referee_args.nonce,
                        referee_args.game_move.basic.move_made.len(),
                        referee_args.game_move.basic.mover_share,
                        state,
                    )))
                }
            }
            Ok(Some(new_state)) => Ok(new_state.clone()),
        }
    }
}
