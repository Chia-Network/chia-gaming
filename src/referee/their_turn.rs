use std::borrow::Borrow;
use std::rc::Rc;

use serde::{Deserialize, Serialize};

use log::debug;

use crate::channel_handler::game_handler::{
    GameHandler, MessageHandler, MessageInputs, TheirTurnInputs, TheirTurnResult,
};
use crate::channel_handler::game_start_info::GameStartInfo;
use crate::channel_handler::types::{Evidence, ReadableMove, StateUpdateProgram};

use crate::common::standard_coin::ChiaIdentity;
use crate::common::types::{
    u64_from_atom, Aggsig, AllocEncoder, Amount, CoinCondition, CoinSpend, CoinString, Error, Hash,
    Program, ProgramRef, PublicKey, Puzzle, PuzzleHash, Sha256tree, Spend,
};
use crate::referee::my_turn::{MyTurnReferee, MyTurnRefereeGameState};
use crate::referee::referee_initial_setup;
use crate::referee::types::{
    curry_referee_puzzle, curry_referee_puzzle_hash, InternalStateUpdateArgs,
    OnChainRefereeMoveData, OnChainRefereeSlash, OnChainRefereeSolution, RefereePuzzleArgs,
    StateUpdateMoveArgs, StateUpdateResult, REM_CONDITION_FIELDS,
};
use crate::referee::types::{
    GameMoveDetails, GameMoveStateInfo, RMFixed, SlashOutcome, TheirTurnCoinSpentResult,
    TheirTurnMoveResult,
};
use crate::referee::Referee;

// Contains a state of the game for use in currying the coin puzzle or for
// reference when calling the game_handler.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum TheirTurnRefereeGameState {
    Initial {
        initial_state: Rc<Program>,
        initial_validation_program: StateUpdateProgram,
        initial_puzzle_args: Rc<RefereePuzzleArgs>,
        game_handler: GameHandler,
    },
    // We were given a validation program back from the 'our turn' handler
    // as well as a state.
    AfterOurTurn {
        their_turn_game_handler: Option<GameHandler>,
        my_turn_validation_program: StateUpdateProgram,
        state_preceding_our_turn: Rc<Program>,
        their_turn_validation_program: StateUpdateProgram,
        state_after_our_turn: Rc<Program>,
        create_this_coin: Rc<RefereePuzzleArgs>,
        spend_this_coin: Rc<RefereePuzzleArgs>,
        move_spend: Rc<OnChainRefereeMoveData>,
    },
}

impl TheirTurnRefereeGameState {
    pub fn is_my_turn(&self) -> bool {
        match self {
            TheirTurnRefereeGameState::Initial { game_handler, .. } => {
                matches!(game_handler, GameHandler::MyTurnHandler(_))
            }
            TheirTurnRefereeGameState::AfterOurTurn { .. } => false,
        }
    }

    pub fn processing_my_turn(&self) -> bool {
        match self {
            TheirTurnRefereeGameState::Initial { .. } => false,
            TheirTurnRefereeGameState::AfterOurTurn { .. } => true,
        }
    }

    pub fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            TheirTurnRefereeGameState::Initial {
                initial_puzzle_args,
                ..
            } => initial_puzzle_args.clone(),
            TheirTurnRefereeGameState::AfterOurTurn {
                create_this_coin, ..
            } => create_this_coin.clone(),
        }
    }

    pub fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            TheirTurnRefereeGameState::Initial {
                initial_puzzle_args,
                ..
            } => initial_puzzle_args.clone(),
            TheirTurnRefereeGameState::AfterOurTurn {
                spend_this_coin, ..
            } => spend_this_coin.clone(),
        }
    }
}

// Referee coin is curried with two public keys (mover and waiter), which swap
// roles each turn.  See the detailed flow comment on MyTurnReferee.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TheirTurnReferee {
    pub fixed: Rc<RMFixed>,

    pub finished: bool,
    pub message_handler: Option<MessageHandler>,

    pub state: Rc<TheirTurnRefereeGameState>,
    pub state_number: usize,
    pub parent: Option<Rc<MyTurnReferee>>,
}

impl TheirTurnReferee {
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
        nonce: usize,
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

        let state = Rc::new(TheirTurnRefereeGameState::Initial {
            initial_state: game_start_info.initial_state.p(),
            initial_validation_program: game_start_info.initial_validation_program.clone(),
            initial_puzzle_args: setup.ref_puzzle_args,
            game_handler: game_start_info.game_handler.clone(),
        });

        Ok((
            TheirTurnReferee {
                fixed: setup.fixed,
                finished: false,
                message_handler: None,
                state,
                state_number,
                parent: None,
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
        false
    }

    pub fn processing_my_turn(&self) -> bool {
        true
    }

    pub fn get_move_info(&self) -> Option<Rc<OnChainRefereeMoveData>> {
        if let TheirTurnRefereeGameState::AfterOurTurn { move_spend, .. } = self.state.borrow() {
            return Some(move_spend.clone());
        }

        None
    }

    pub fn get_game_handler(&self) -> Option<GameHandler> {
        match self.state.borrow() {
            TheirTurnRefereeGameState::Initial { game_handler, .. } => Some(game_handler.clone()),
            TheirTurnRefereeGameState::AfterOurTurn {
                their_turn_game_handler,
                ..
            } => their_turn_game_handler.clone(),
        }
    }

    pub fn get_validation_program_for_their_move(
        &self,
    ) -> Result<(Rc<Program>, StateUpdateProgram), Error> {
        match self.state.borrow() {
            TheirTurnRefereeGameState::Initial {
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
            TheirTurnRefereeGameState::AfterOurTurn {
                state_after_our_turn,
                their_turn_validation_program,
                ..
            } => Ok((
                state_after_our_turn.clone(),
                their_turn_validation_program.clone(),
            )),
        }
    }

    pub fn slash_infohash_inputs(&self) -> Option<(StateUpdateProgram, Rc<Program>)> {
        if let TheirTurnRefereeGameState::AfterOurTurn {
            my_turn_validation_program,
            state_preceding_our_turn,
            ..
        } = self.state.borrow()
        {
            return Some((
                my_turn_validation_program.clone(),
                state_preceding_our_turn.clone(),
            ));
        }

        None
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
        debug!("accept their move {details:?}");

        let new_state = MyTurnRefereeGameState::AfterTheirTurn {
            game_handler: game_handler.clone(),
            state_after_their_turn: new_state.clone(),
            create_this_coin: old_args,
            spend_this_coin: referee_args,
            move_spend: self.get_move_info(),
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
            TheirTurnRefereeGameState::Initial { initial_state, .. } => initial_state.clone(),
            TheirTurnRefereeGameState::AfterOurTurn {
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
        puzzle_args: Rc<RefereePuzzleArgs>,
        state: Rc<Program>,
        evidence: Evidence,
    ) -> Result<StateUpdateResult, Error> {
        let validator_move_args = InternalStateUpdateArgs {
            validation_program: puzzle_args.validation_program.clone(),
            referee_args: Rc::new(puzzle_args.swap()),
            state_update_args: StateUpdateMoveArgs {
                state: state.clone(),
                evidence: evidence.to_program(),
            },
        };
        validator_move_args.run(allocator)
    }

    pub fn their_turn_move_off_chain(
        &self,
        allocator: &mut AllocEncoder,
        details: &GameMoveDetails,
        state_number: usize,
    ) -> Result<(Option<MyTurnReferee>, TheirTurnMoveResult), Error> {
        // Did we get a slash?

        debug!("do their turn {details:?}");

        let handler = self
            .get_game_handler()
            .ok_or_else(|| Error::StrErr("received their move after our final move".to_string()))?;

        // Run the validation program for the incoming move to get the new state.
        let evidence = Evidence::nil()?;
        let puzzle_args = self.spend_this_coin();
        let ref_puzzle_args: &RefereePuzzleArgs = puzzle_args.borrow();
        let (state, validation_program) = self.get_validation_program_for_their_move()?;
        let pre_state_nodeptr = state.to_nodeptr(allocator)?;
        let is_initial = matches!(
            self.state.borrow(),
            TheirTurnRefereeGameState::Initial { .. }
        );
        let offchain_prev_hash = if is_initial {
            None
        } else {
            puzzle_args.game_move.validation_info_hash.clone()
        };
        let offchain_puzzle_args = Rc::new(RefereePuzzleArgs {
            mover_pubkey: self.fixed.my_identity.public_key.clone(),
            waiter_pubkey: self.fixed.their_referee_pubkey.clone(),
            game_move: details.clone(),
            validation_program: validation_program.clone(),
            previous_validation_info_hash: offchain_prev_hash,
            ..ref_puzzle_args.clone()
        });
        let rc_puzzle_args = Rc::new(RefereePuzzleArgs {
            mover_pubkey: self.fixed.my_identity.public_key.clone(),
            waiter_pubkey: self.fixed.their_referee_pubkey.clone(),
            game_move: details.clone(),
            validation_program: validation_program.clone(),
            previous_validation_info_hash: puzzle_args.game_move.validation_info_hash.clone(),
            ..ref_puzzle_args.clone()
        });
        let state_update = self.run_state_update(
            allocator,
            offchain_puzzle_args.clone(),
            state.clone(),
            evidence,
        )?;

        let new_state: Rc<Program> = match state_update {
            Some(state) => state,
            None => {
                return Ok((
                    None,
                    TheirTurnMoveResult {
                        puzzle_hash_for_unroll: None,
                        readable_move: Program(vec![0x80]).into(),
                        mover_share: details.basic.mover_share.clone(),
                        message: vec![],
                        slash: Some(Evidence::nil()?),
                    },
                ));
            }
        };

        let state_nodeptr = new_state.to_nodeptr(allocator)?;
        let (_old_state, validation_program) = self.get_validation_program_for_their_move()?;
        let validation_program_hash = validation_program.sha256tree(allocator).hash().clone();
        let result = handler.call_their_turn_handler(
            allocator,
            &TheirTurnInputs {
                amount: self.fixed.amount.clone(),
                pre_state: pre_state_nodeptr,
                state: state_nodeptr,

                last_move: &details.basic.move_made,
                last_mover_share: details.basic.mover_share.clone(),

                new_move: GameMoveDetails {
                    validation_info_hash: Some(validation_program_hash),
                    ..details.clone()
                },
            },
        )?;

        let new_self = self.accept_their_move(
            result.next_handler.clone(),
            new_state.clone(),
            puzzle_args.clone(),
            rc_puzzle_args.clone(),
            details,
            state_number,
        )?;

        for evidence in result.slash_evidence.iter() {
            debug!("calling slash for given evidence {evidence:?}");
            if self.run_state_update(
                allocator,
                offchain_puzzle_args.clone(),
                state.clone(),
                evidence.clone(),
            )?.is_none() {
                return Ok((
                    None,
                    TheirTurnMoveResult {
                        puzzle_hash_for_unroll: None,
                        readable_move: result.readable_move.clone(),
                        mover_share: result.mover_share.clone(),
                        message: result.message.clone(),
                        slash: Some(evidence.clone()),
                    },
                ));
            }
        }

        let out_move = self.finish_their_turn(allocator, puzzle_args, &result)?;

        Ok((Some(new_self), out_move))
    }

    pub fn their_turn_coin_spent(
        &self,
        allocator: &mut AllocEncoder,
        referee_coin_string: &CoinString,
        conditions: &[CoinCondition],
        state_number: usize,
        rem_conditions: &[Vec<u8>],
    ) -> Result<(Option<Referee>, TheirTurnCoinSpentResult), Error> {
        if rem_conditions.len() != REM_CONDITION_FIELDS {
            return Err(Error::StrErr(
                "rem condition should have the right number of fields".to_string(),
            ));
        }

        let new_move = &rem_conditions[0];
        let validation_info_hash = if rem_conditions[1].is_empty() {
            None
        } else {
            Some(Hash::from_slice(&rem_conditions[1])?)
        };
        let new_mover_share = if let Some(share) = u64_from_atom(&rem_conditions[2]) {
            let amt = Amount::new(share);
            if amt > self.fixed.amount {
                return Err(Error::StrErr(format!(
                    "on-chain mover_share {} exceeds game amount {}",
                    share,
                    self.fixed.amount.to_u64(),
                )));
            }
            amt
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
            validation_info_hash: validation_info_hash.clone(),
        };

        let (new_self, result) =
            self.their_turn_move_off_chain(allocator, &details, state_number)?;

        if let Some(evidence) = &result.slash {
            let (slash_validation_program, slash_state) =
                if let Some(prev) = self.slash_infohash_inputs() {
                    prev
                } else {
                    return Err(Error::StrErr(
                        "slash: no previous validation info hash inputs available".to_string(),
                    ));
                };

            let spent_ph = if let Some((_, ph, _)) = referee_coin_string.to_parts() {
                ph
            } else {
                return Err(Error::StrErr(
                    "slash: could not extract puzzle hash from referee coin string".to_string(),
                ));
            };
            let to_spend_ph = if let Some(p) = conditions
                .iter()
                .filter_map(|c| {
                    if let CoinCondition::CreateCoin(ph, _) = c {
                        Some(ph.clone())
                    } else {
                        None
                    }
                })
                .next()
            {
                p
            } else {
                return Err(Error::StrErr(
                    "slash: no CREATE_COIN condition found in referee spend".to_string(),
                ));
            };
            let coin_string_to_spend = CoinString::from_parts(
                &referee_coin_string.to_coin_id(),
                &to_spend_ph,
                &self.fixed.amount,
            );

            debug!("their turn: slash specified {:?}", evidence);
            let after_args = self.spend_this_coin();
            let expected_ph = self.outcome_referee_puzzle_hash(allocator)?;
            debug!(
                "slash: outcome_ph={expected_ph:?} spent_ph={spent_ph:?} match={}",
                expected_ph == spent_ph
            );

            let args = Rc::new(RefereePuzzleArgs {
                mover_pubkey: self.fixed.my_identity.public_key.clone(),
                waiter_pubkey: self.fixed.their_referee_pubkey.clone(),
                game_move: details.clone(),
                timeout: self.fixed.timeout.clone(),
                amount: self.fixed.amount.clone(),
                nonce: self.fixed.nonce,
                referee_coin_puzzle_hash: self.fixed.referee_coin_puzzle_hash.clone(),
                validation_program: slash_validation_program.clone(),
                previous_validation_info_hash: after_args.game_move.validation_info_hash.clone(),
            });
            let puzzle = curry_referee_puzzle(allocator, &self.fixed.referee_coin_puzzle, &args)?;
            let new_puzzle_hash =
                curry_referee_puzzle_hash(allocator, &self.fixed.referee_coin_puzzle_hash, &args)?;
            game_assert_eq!(
                new_puzzle_hash,
                to_spend_ph,
                "their_turn_coin_spent: curried puzzle hash mismatch"
            );
            let slash = self.make_slash_for_their_turn(
                allocator,
                slash_validation_program,
                slash_state,
                &coin_string_to_spend,
                &puzzle,
                evidence.clone(),
                new_mover_share.clone(),
            )?;
            return Ok((None, slash));
        }

        let new_self = if let Some(new_self) = new_self {
            new_self
        } else {
            return Err(Error::StrErr(
                "we didn't slash but also didn't return a new state".to_string(),
            ));
        };

        let args = new_self.spend_this_coin();

        let new_puzzle_hash =
            curry_referee_puzzle_hash(allocator, &self.fixed.referee_coin_puzzle_hash, &args)?;
        debug!("THEIR TURN MOVE OFF CHAIN SUCCEEDED {new_puzzle_hash:?}");

        let adjusted_self = match new_self.state.as_ref() {
            MyTurnRefereeGameState::AfterTheirTurn {
                game_handler,
                state_after_their_turn,
                spend_this_coin,
                move_spend,
                ..
            } => {
                let adjusted_state = Rc::new(MyTurnRefereeGameState::AfterTheirTurn {
                    game_handler: game_handler.clone(),
                    state_after_their_turn: state_after_their_turn.clone(),
                    create_this_coin: args.clone(),
                    spend_this_coin: spend_this_coin.clone(),
                    move_spend: move_spend.clone(),
                });
                MyTurnReferee {
                    state: adjusted_state,
                    ..new_self
                }
            }
            _ => new_self,
        };

        let final_move = TheirTurnCoinSpentResult::Moved {
            new_coin_string: CoinString::from_parts(
                &referee_coin_string.to_coin_id(),
                &new_puzzle_hash,
                &self.fixed.amount,
            ),
            state_number,
            readable: ReadableMove::from_program(result.readable_move.p()),
            mover_share: args.game_move.basic.mover_share.clone(),
        };

        Ok((Some(Referee::MyTurn(Rc::new(adjusted_self))), final_move))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn make_slash_for_their_turn(
        &self,
        allocator: &mut AllocEncoder,
        validation_program: StateUpdateProgram,
        state: Rc<Program>,
        coin_string: &CoinString,
        puzzle: &Puzzle,
        evidence: Evidence,
        cheating_move_mover_share: Amount,
    ) -> Result<TheirTurnCoinSpentResult, Error> {
        debug!(
            "slash spend: parent coin is {coin_string:?} => {:?}",
            self.fixed.reward_puzzle_hash
        );

        let signature = self.fixed.my_reward_payout_signature.clone();

        let solution = OnChainRefereeSolution::Slash(Rc::new(OnChainRefereeSlash {
            validation_program,
            state,
            evidence,
            reward_puzzle_hash: self.fixed.reward_puzzle_hash.clone(),
            signature: signature.clone(),
        }));
        let slashing_coin_solution = solution.to_nodeptr(allocator, &self.fixed)?;

        let reward_amount = self.fixed.amount.clone();
        let coin_string_of_output_coin = CoinString::from_parts(
            &coin_string.to_coin_id(),
            &self.fixed.reward_puzzle_hash,
            &reward_amount,
        );

        Ok(TheirTurnCoinSpentResult::Slash(Box::new(
            SlashOutcome::Reward {
                transaction: Box::new(CoinSpend {
                    coin: coin_string.clone(),
                    bundle: Spend {
                        puzzle: puzzle.clone(),
                        solution: Program::from_nodeptr(allocator, slashing_coin_solution)?.into(),
                        signature,
                    },
                }),
                my_reward_coin_string: coin_string_of_output_coin,
                cheating_move_mover_share,
            },
        )))
    }

    pub fn finish_their_turn(
        &self,
        allocator: &mut AllocEncoder,
        puzzle_args: Rc<RefereePuzzleArgs>,
        result: &TheirTurnResult,
    ) -> Result<TheirTurnMoveResult, Error> {
        let puzzle_hash_for_unroll = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            &puzzle_args,
        )?;

        Ok(TheirTurnMoveResult {
            puzzle_hash_for_unroll: Some(puzzle_hash_for_unroll),
            readable_move: result.readable_move.clone(),
            mover_share: result.mover_share.clone(),
            message: result.message.clone(),
            slash: None,
        })
    }
}
