use std::borrow::Borrow;
use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::channel_state::game_handler::{
    GameHandler, MessageHandler, MyTurnInputs, MyTurnResult, PreparedMove,
};
use crate::channel_state::game_start_info::GameStartInfo;
use crate::channel_state::types::{Evidence, ReadableMove, StateUpdateProgram};

use crate::common::standard_coin::ChiaIdentity;
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, Error, Hash, Program, ProgramRef, PublicKey, Puzzle, PuzzleHash,
};
use crate::referee::referee_initial_setup;
use crate::referee::their_turn::{TheirTurnReferee, TheirTurnRefereeGameState};
use crate::referee::types::{
    curry_referee_puzzle, curry_referee_puzzle_hash, InternalStateUpdateArgs,
    OnChainRefereeMoveData, ParsedValidatorResult, RefereePuzzleArgs, StateUpdateMoveArgs,
};
use crate::referee::types::{
    GameMoveDetails, GameMoveStateInfo, GameMoveWireData, RefereeFixedContext, StateUpdateResult,
    ValidationInfoHash,
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
        validation_program: StateUpdateProgram,
    },
    AfterTheirTurn {
        // Live information for this turn.
        game_handler: Option<GameHandler>,
        validation_program: Option<StateUpdateProgram>,
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
/// The factory registry supplies the initial validation program and every
/// program that can follow it. For each move, both peers run the same current
/// validator. Its returned hash selects the next program from that registry,
/// so handlers never choose or transport on-chain code. Entropy-derived
/// private state remains curried only into off-chain handlers.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MyTurnReferee {
    pub fixed: Rc<RefereeFixedContext>,

    pub finished: bool,
    pub enable_cheating: Option<(Vec<u8>, Amount)>,

    pub state: Rc<MyTurnRefereeGameState>,
    pub state_number: usize,
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
            validation_program: game_start_info.initial_validation_program(),
        });

        Ok((
            MyTurnReferee {
                fixed: setup.fixed,
                finished: false,
                state,
                state_number,
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

    fn get_validation_program_for_my_move(&self) -> Result<StateUpdateProgram, Error> {
        match self.state.borrow() {
            MyTurnRefereeGameState::Initial {
                validation_program, ..
            } => Ok(validation_program.clone()),
            MyTurnRefereeGameState::AfterTheirTurn {
                validation_program, ..
            } => validation_program.clone().ok_or_else(|| {
                Error::StrErr("move attempted after terminal validator transition".to_string())
            }),
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
        current_validation_program: StateUpdateProgram,
        next_validation_program: Option<StateUpdateProgram>,
        message_handler: Option<MessageHandler>,
        state_number: usize,
    ) -> Result<TheirTurnReferee, Error> {
        let move_spend = Rc::new(OnChainRefereeMoveData {
            validation_program: current_validation_program,
            state: current_state.clone(),
            new_move: new_puzzle_args.game_move.clone(),
            before_args: current_puzzle_args.clone(),
            after_args: new_puzzle_args.clone(),
        });

        let new_state = TheirTurnRefereeGameState {
            game_handler: game_handler.clone(),
            their_turn_validation_program: next_validation_program,
            current_state: new_state.clone(),
            create_this_coin: current_puzzle_args,
            spend_this_coin: new_puzzle_args,
            move_spend: Some(move_spend),
        };

        Ok(TheirTurnReferee {
            fixed: self.fixed.clone(),
            finished: self.finished,
            message_handler,
            state: Rc::new(new_state),
            state_number,
        })
    }

    pub fn prepare_my_turn_move(
        &self,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<PreparedMove, Error> {
        game_assert!(
            self.is_my_turn(),
            "prepare_my_turn_move called when not my turn"
        );

        // A move attempted after a terminal move is a clear error: the prior
        // move carried a nil validation program, which consumed the game
        // handler, so there is nothing left to advance. This happens, e.g.,
        // when the frontend fires a phantom extra move past the terminal one.
        // Assert-fail loudly in debug/test builds; in release this returns an
        // error that surfaces to the frontend as a notification pop-up.
        game_assert!(
            self.get_game_handler().is_some(),
            "my_turn_make_move: move attempted after a terminal move (nil validation program); the game is already over"
        );
        let game_handler = self
            .get_game_handler()
            .ok_or_else(|| Error::StrErr("move made but we passed the final move".to_string()))?;

        let args = self.spend_this_coin();

        let state_to_update = match self.state.borrow() {
            MyTurnRefereeGameState::Initial { initial_state, .. } => initial_state.clone(),
            MyTurnRefereeGameState::AfterTheirTurn {
                state_after_their_turn,
                ..
            } => state_after_their_turn.clone(),
        };

        let result = if let Some((ref fake_move, ref cheat_share)) = self.enable_cheating {
            MyTurnResult {
                name: "cheat".to_string(),
                move_bytes: fake_move.clone(),
                mover_share: cheat_share.clone(),
                waiting_handler: Some(game_handler.clone()),
                message_parser: None,
            }
        } else {
            game_handler.call_my_turn_handler(
                allocator,
                &MyTurnInputs {
                    readable_new_move: readable_move.clone(),
                    amount: self.fixed.amount.clone(),
                    last_mover_share: args.game_move.basic.mover_share.clone(),
                    entropy: new_entropy.clone(),
                    state: ProgramRef::new(state_to_update.clone()),
                },
            )?
        };

        if self.enable_cheating.is_none()
            && result.move_bytes.len() > args.game_move.basic.max_move_size as usize
        {
            return Err(Error::StrErr(format!(
                "local move exceeds max_move_size: nonce={}, move_len={}, max_move_size={}",
                args.nonce,
                result.move_bytes.len(),
                args.game_move.basic.max_move_size,
            )));
        }

        Ok(result.into())
    }

    pub fn apply_prepared_move(
        &self,
        allocator: &mut AllocEncoder,
        result: PreparedMove,
        state_number: usize,
    ) -> Result<(Referee, GameMoveWireData), Error> {
        game_assert!(
            self.is_my_turn(),
            "apply_prepared_move called when not my turn"
        );
        game_assert!(
            self.get_game_handler().is_some(),
            "apply_prepared_move: prepared move became stale for this game"
        );

        let args = self.spend_this_coin();
        let state_to_update = match self.state.borrow() {
            MyTurnRefereeGameState::Initial { initial_state, .. } => initial_state.clone(),
            MyTurnRefereeGameState::AfterTheirTurn {
                state_after_their_turn,
                ..
            } => state_after_their_turn.clone(),
        };
        let result = Rc::new(result);
        let puzzle_args = self.spend_this_coin();
        let ref_puzzle_args: &RefereePuzzleArgs = puzzle_args.borrow();
        let outgoing = self.get_validation_program_for_my_move()?;
        let mut basic = GameMoveStateInfo {
            move_made: result.move_bytes.clone(),
            mover_share: result.mover_share.clone(),
            max_move_size: 0,
        };
        let prev_hash = ref_puzzle_args.game_move.validation_info_hash.clone();
        let placeholder = GameMoveDetails {
            basic: basic.clone(),
            validation_info_hash: ValidationInfoHash::None,
            validation_program_hash: None,
        };
        let extract_args = Rc::new(RefereePuzzleArgs {
            mover_pubkey: self.fixed.their_referee_pubkey.clone(),
            waiter_pubkey: self.fixed.my_identity.public_key.clone(),
            game_move: placeholder,
            validation_program: outgoing.clone(),
            previous_validation_info_hash: prev_hash.clone(),
            ..ref_puzzle_args.clone()
        });
        let parsed = match self.run_validator_for_my_move_parsed(
            allocator,
            extract_args,
            state_to_update.clone(),
            Evidence::nil()?,
        ) {
            Ok(parsed) => parsed,
            Err(e) => {
                if self.enable_cheating.is_some() {
                    ParsedValidatorResult {
                        new_state: Some(state_to_update.clone()),
                        next_validator_hash: None,
                        next_max_move_size: 0,
                    }
                } else {
                    return Err(e);
                }
            }
        };
        if parsed.new_state.is_none() && self.enable_cheating.is_none() {
            return Err(Error::StrErr(format!(
                "pre-send validation rejected our move: nonce={}, move_len={}, mover_share={:?}, state={:?}",
                args.nonce,
                result.move_bytes.len(),
                result.mover_share,
                state_to_update,
            )));
        }
        let new_state_following_my_move = parsed
            .new_state
            .clone()
            .unwrap_or_else(|| state_to_update.clone());
        basic.max_move_size = parsed.next_max_move_size;
        let next_validation_program = if self.enable_cheating.is_some() {
            Some(outgoing.clone())
        } else {
            parsed
                .next_validator_hash
                .as_ref()
                .map(|hash| self.fixed.validation_programs.resolve(hash))
                .transpose()?
        };
        if self.enable_cheating.is_none() {
            game_assert_eq!(
                result.waiting_handler.is_some(),
                next_validation_program.is_some(),
                "my-turn handler continuation disagrees with validator transition"
            );
        }
        let game_move_details = crate::referee::game_move_details_from_transition(
            allocator,
            basic,
            parsed.next_validator_hash,
            &new_state_following_my_move,
        );

        let rc_puzzle_args = Rc::new(RefereePuzzleArgs {
            mover_pubkey: self.fixed.their_referee_pubkey.clone(),
            waiter_pubkey: self.fixed.my_identity.public_key.clone(),
            game_move: game_move_details.clone(),
            validation_program: outgoing.clone(),
            previous_validation_info_hash: prev_hash,
            ..ref_puzzle_args.clone()
        });

        let new_self = self.accept_this_move(
            result.waiting_handler.clone(),
            new_state_following_my_move,
            state_to_update,
            args.clone(),
            rc_puzzle_args.clone(),
            outgoing,
            next_validation_program,
            result.message_parser.clone(),
            state_number,
        )?;

        // The signed unroll leaf is the new virtual coin (roles swapped, new
        // move/share/max, computed infohash_c, current INFOHASH_B as previous).
        let new_curried_referee_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            rc_puzzle_args.as_ref(),
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
        let result = self.run_validator_for_my_move_raw(
            allocator,
            referee_args.clone(),
            state.clone(),
            evidence,
        );
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

    fn run_validator_for_my_move_parsed(
        &self,
        allocator: &mut AllocEncoder,
        referee_args: Rc<RefereePuzzleArgs>,
        state: Rc<Program>,
        evidence: Evidence,
    ) -> Result<ParsedValidatorResult, Error> {
        let validator_move_args = InternalStateUpdateArgs {
            validation_program: referee_args.validation_program.clone(),
            referee_args,
            state_update_args: StateUpdateMoveArgs {
                evidence: evidence.to_program(),
                state: state.clone(),
            },
        };
        validator_move_args.run_parsed(allocator)
    }

    fn run_validator_for_my_move_raw(
        &self,
        allocator: &mut AllocEncoder,
        referee_args: Rc<RefereePuzzleArgs>,
        state: Rc<Program>,
        evidence: Evidence,
    ) -> Result<StateUpdateResult, Error> {
        Ok(self
            .run_validator_for_my_move_parsed(allocator, referee_args, state, evidence)?
            .new_state)
    }
}
