use std::borrow::Borrow;
use std::rc::Rc;

use clvmr::{NodePtr, run_program};
use clvm_traits::{ClvmEncoder, ToClvm};
use log::debug;

use crate::common::constants::CREATE_COIN;
use crate::common::types::{AllocEncoder, Amount, CoinCondition, CoinString, CoinSpend, Error, Hash, IntoErr, Node, RcNode, Program, ProgramRef, Puzzle, PuzzleHash, Sha256Input, Sha256tree, Spend, chia_dialect, u64_from_atom, usize_from_atom, BrokenOutCoinSpendInfo};
use crate::common::standard_coin::{ChiaIdentity, standard_solution_partial};
use crate::channel_handler::types::{ValidationProgram, Evidence, ReadableMove, GameStartInfo};
use crate::channel_handler::game_handler::{TheirTurnInputs, TheirTurnResult, TheirTurnMoveData, GameHandler};
use crate::referee::types::{RMFixed, ValidatorResult, InternalValidatorArgs, ValidatorMoveArgs, TheirTurnMoveResult, TheirTurnCoinSpentResult, SlashOutcome, REM_CONDITION_FIELDS, RefereeOnChainTransaction, OnChainRefereeSolution, RefereeMakerGameState, StoredGameState, GameMoveDetails, GameMoveStateInfo};
use crate::referee::puzzle_args::{RefereePuzzleArgs, curry_referee_puzzle_hash, curry_referee_puzzle};

pub struct TheirTurnReferee {
    fixed: Rc<RMFixed>,
    first_move: bool,
    game_start_info: GameStartInfo,
    validation_program_to_judge_their_move: ValidationProgram,
    validation_program_stored_to_generate_our_state_for_our_move: ValidationProgram,
    state_from_our_move: ProgramRef,
}

pub struct TheirTurnCarryData {
    validation_program_to_generate_our_state_for_our_move: ValidationProgram,
    state_from_our_move_generated_by_our_turn_handler: ProgramRef,
    mover_share_generated_by_their_turn_handler: Amount,
    max_move_size_generated_by_validation_of_their_turn: usize,
}

impl TheirTurnReferee {
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
            false,
        ));
        // If this reflects my turn, then we will spend the next parameter set.
        assert_eq!(
            fixed_info.their_referee_puzzle_hash,
            ref_puzzle_args.mover_puzzle_hash
        );
        let puzzle_hash =
            curry_referee_puzzle_hash(allocator, &referee_coin_puzzle_hash, &ref_puzzle_args)?;

        Ok(TheirTurnReferee {
            fixed: fixed_info,
            first_move: true,
            game_start_info: game_start_info.clone(),
            state_from_our_move: game_start_info.initial_state.clone(),
            validation_program_to_judge_their_move: game_start_info.initial_validation_program.clone(),
            validation_program_stored_to_generate_our_state_for_our_move: game_start_info.initial_validation_program.clone(),
        })
    }

    fn get_our_current_share(&self) -> Amount {
        todo!();
    }

    pub fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        todo!();
    }

    pub fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        todo!();
    }

    pub fn get_game_state(&self) -> Rc<Program> {
        todo!();
    }

    pub fn get_validation_program_for_move(
        &self,
        their_move: bool,
    ) -> Result<(&Program, ValidationProgram), Error> {
        todo!();
    }

    pub fn run_validator_for_move(
        &self,
        allocator: &mut AllocEncoder,
        evidence: NodePtr,
        their_move: bool,
    ) -> Result<ValidatorResult, Error> {
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
        let validator_move_args = InternalValidatorArgs {
            referee_args: RefereePuzzleArgs {
                nonce: self.fixed.nonce,
                game_move: GameMoveDetails {
                    basic: GameMoveStateInfo {
                        move_made: puzzle_args.game_move.basic.move_made.clone(),
                        mover_share: puzzle_args.game_move.basic.mover_share.clone(),
                        max_move_size: puzzle_args.game_move.basic.max_move_size,
                    },
                    validation_info_hash: puzzle_args.game_move.validation_info_hash.clone(),
                },
                previous_validation_info_hash: Some(
                    previous_puzzle_args.game_move.validation_info_hash.clone(),
                ),
                mover_puzzle_hash: puzzle_args.mover_puzzle_hash.clone(),
                waiter_puzzle_hash: puzzle_args.waiter_puzzle_hash.clone(),
                amount: self.fixed.amount.clone(),
                timeout: self.fixed.timeout.clone(),
            },
            referee_hash: new_puzzle_hash.clone(),
            move_args: ValidatorMoveArgs {
                evidence: Rc::new(Program::from_nodeptr(allocator, evidence)?),
                state: self.get_game_state(),
                mover_puzzle: self.fixed.my_identity.puzzle.to_program(),
                solution: solution_program,
            },
        };

        debug!("getting validation program");
        // debug!("my turn {}", self.is_my_turn());
        // debug!("state {:?}", self.state);
        // if !self.old_states.is_empty() {
        //     debug!(
        //         "last stored {:?}",
        //     self.old_states[self.old_states.len() - 1]
        //     );
        // }
        let (_state, validation_program) = self.get_validation_program_for_move(their_move)?;
        debug!("validation_program {validation_program:?}");
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

        // Error means validation should not work.
        // It should be handled later.
        let result = run_program(
            allocator.allocator(),
            &chia_dialect(),
            validation_program_nodeptr,
            validator_full_args_node,
            0,
        ).into_gen()?;

        ValidatorResult::from_nodeptr(allocator, result.1)
    }

    pub fn their_turn_move_off_chain(
        &mut self,
        allocator: &mut AllocEncoder,
        details: &GameMoveDetails,
        state_number: usize,
        coin: Option<&CoinString>,
    ) -> Result<TheirTurnMoveResult, Error> {
        debug!("do their turn {details:?}");

        // let original_state = self.state.clone();
        // let handler = self.get_game_handler();
        // let last_state = self.get_game_state();
        // let args = self.spend_this_coin();

        // // Retrieve evidence from their turn handler.
        // let state_nodeptr = last_state.to_nodeptr(allocator)?;
        // assert!(
        //     args.game_move.basic.move_made.len()
        //         <= self.args_for_this_coin().game_move.basic.max_move_size
        // );
        // let result = handler.call_their_turn_driver(
        //     allocator,
        //     &TheirTurnInputs {
        //         amount: self.fixed.amount.clone(),
        //         last_state: state_nodeptr,

        //         last_move: &args.game_move.basic.move_made,
        //         last_mover_share: args.game_move.basic.mover_share.clone(),

        //         new_move: details.clone(),

        //         #[cfg(test)]
        //         run_debug: self.run_debug,
        //     },
        // )?;

        // let (handler, move_data) = match &result {
        //     TheirTurnResult::FinalMove(move_data) => (None, move_data.clone()),
        //     TheirTurnResult::MakeMove(handler, _, move_data) => {
        //         (Some(handler.clone()), move_data.clone())
        //     }

        //     // Slash can't be used when we're off chain.
        //     TheirTurnResult::Slash(_evidence) => {
        //         return Ok(TheirTurnMoveResult {
        //             puzzle_hash_for_unroll: None,
        //             original: result.clone(),
        //         })
        //     }
        // };

        // let puzzle_args = Rc::new(RefereePuzzleArgs::new(
        //     &self.fixed,
        //     &details.basic,
        //     Some(&args.game_move.validation_info_hash),
        //     &details.validation_info_hash,
        //     Some(&move_data.mover_share),
        //     true,
        // ));

        // self.accept_their_move(
        //     allocator,
        //     handler,
        //     args.clone(),
        //     puzzle_args.clone(),
        //     details,
        //     state_number,
        // )?;

        // // If specified, check for slash.
        // if let Some(coin_string) = coin {
        //     for evidence in move_data.slash_evidence.iter() {
        //         debug!("calling slash for given evidence");
        //         if self
        //             .check_their_turn_for_slash(allocator, *evidence, coin_string)?
        //             .is_some()
        //         {
        //             // Slash isn't allowed in off chain, we'll go on chain via error.
        //             debug!("slash was allowed");
        //             self.state = original_state;
        //             return Err(Error::StrErr("slashable when off chain".to_string()));
        //         }
        //     }
        // }

        // let puzzle_hash_for_unroll = curry_referee_puzzle_hash(
        //     allocator,
        //     &self.fixed.referee_coin_puzzle_hash,
        //     &puzzle_args,
        // )?;
        // debug!(
        //     "new_curried_referee_puzzle_hash (their turn): {:?}",
        //     puzzle_hash_for_unroll
        // );

        // // Coin calculated off the new new state.
        // Ok(TheirTurnMoveResult {
        //     puzzle_hash_for_unroll: Some(puzzle_hash_for_unroll),
        //     original: result,
        // })

        todo!();
    }

    // It me.
    fn target_puzzle_hash_for_slash(&self) -> PuzzleHash {
        self.fixed.my_identity.puzzle_hash.clone()
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
        let my_mover_share = self.fixed.amount.clone() - targs.game_move.basic.mover_share.clone();

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
                        (Node(slash_solution), (Node(evidence.to_nodeptr()), ())),
                    ),
                ),
            ),
        )
            .to_clvm(allocator)
            .into_gen()
    }

    #[allow(clippy::too_many_arguments)]
    fn make_slash_for_their_turn(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        new_puzzle: Puzzle,
        new_puzzle_hash: &PuzzleHash,
        slash_spend: &BrokenOutCoinSpendInfo,
        evidence: Evidence,
        ignore_zero_value: bool,
    ) -> Result<TheirTurnCoinSpentResult, Error> {
        // Probably readable_info overlaps solution.
        // Moving driver in that context is the signature.
        // My reward coin string is the coin that we'll make
        // after the transaction below has been spent so its
        // parent is the coin id of that coin.
        let current_mover_share = self.get_our_current_share();

        let (state, validation_program) = self.get_validation_program_for_move(true)?;
        let reward_amount = self.fixed.amount.clone() - current_mover_share;
        if reward_amount == Amount::default() && !ignore_zero_value {
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

    fn make_slash_spend(
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

    pub fn check_their_turn_for_slash(
        &self,
        allocator: &mut AllocEncoder,
        evidence: NodePtr,
        coin_string: &CoinString,
    ) -> Result<Option<TheirTurnCoinSpentResult>, Error> {
        let puzzle_args = self.spend_this_coin();
        let new_puzzle = curry_referee_puzzle(
            allocator,
            &self.fixed.referee_coin_puzzle,
            &self.fixed.referee_coin_puzzle_hash,
            &puzzle_args,
        )?;

        let new_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed.referee_coin_puzzle_hash,
            &puzzle_args,
        )?;

        // First step of checking for slash:
        // run the referee coin with the nil slash and see if it succeeds.  If so,
        // leave via Some(TheirTurnCoinSpentResult), otherwise run the validator separately
        // here and leave via the same route if slash is indicated.  Later we'll have a state
        // result that we feed into the game handler.
        let slash_spend = self.make_slash_spend(allocator, coin_string)?;
        let nil = allocator
            .encode_atom(clvm_traits::Atom::Borrowed(&[]))
            .into_gen()?;
        let potential_slash_for_their_turn = self.make_slash_for_their_turn(
            allocator,
            coin_string,
            new_puzzle,
            &new_puzzle_hash,
            &slash_spend,
            Evidence::from_nodeptr(nil),
            true,
        )?;

        let mut check_allowed_slash = || {
            if let TheirTurnCoinSpentResult::Slash(slash_for_their_turn) =
                &potential_slash_for_their_turn
            {
                let slash_ref: &SlashOutcome = slash_for_their_turn.borrow();
                if let SlashOutcome::Reward { transaction, .. } = &slash_ref {
                    // Run the program and solution.
                    let program_node = transaction.bundle.puzzle.to_clvm(allocator).into_gen()?;
                    let solution_node =
                        transaction.bundle.solution.to_clvm(allocator).into_gen()?;
                    let result = run_program(
                        allocator.allocator(),
                        &chia_dialect(),
                        program_node,
                        solution_node,
                        0,
                    );

                    debug!("slash result from first slash check was ok {}", result.is_ok());
                    return Ok(result.is_ok());
                }
            }

            Ok(false)
        };

        let allowed_slash = check_allowed_slash()?;

        if !allowed_slash {
            return Ok(None);
        }

        // my_inner_solution maker is just in charge of making aggsigs from
        // conditions.
        debug!("run validator for their move");

        let full_slash_result = self.run_validator_for_move(allocator, evidence, true)?;
        match full_slash_result {
            ValidatorResult::Slash(_slash) => {
                // result is NodePtr containing solution and aggsig.
                // The aggsig for the nil slash is the same as the slash
                // below, having been created for the reward coin by using
                // the standard solution signer.
                Ok(Some(potential_slash_for_their_turn))
            }
            ValidatorResult::MoveOk(_,_,_) => Ok(None),
        }
    }

    pub fn their_turn_coin_spent(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        conditions: &[CoinCondition],
        state_number: usize,
    ) -> Result<TheirTurnCoinSpentResult, Error> {
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

        if repeat {
            let nil = allocator.allocator().nil();
            // debug!("repeat: current state {:?}", self.state);

            return Ok(TheirTurnCoinSpentResult::Moved {
                new_coin_string: CoinString::from_parts(
                    &coin_string.to_coin_id(),
                    &after_puzzle_hash,
                    &self.fixed.amount,
                ),
                readable: ReadableMove::from_nodeptr(allocator, nil)?,
                mover_share: self.spend_this_coin().game_move.basic.mover_share.clone(),
            });
        }

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
            return Ok(TheirTurnCoinSpentResult::Timedout {
                my_reward_coin_string: Some(my_reward_coin_string),
            });
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
                max_move_size: new_max_move_size,
                mover_share: new_mover_share.clone(),
            },
            validation_info_hash,
        };

        let result = self.their_turn_move_off_chain(allocator, &details, state_number, None)?;

        let args = self.spend_this_coin();

        let new_puzzle = curry_referee_puzzle(
            allocator,
            &self.fixed.referee_coin_puzzle,
            &self.fixed.referee_coin_puzzle_hash,
            &args,
        )?;
        let new_puzzle_hash =
            curry_referee_puzzle_hash(allocator, &self.fixed.referee_coin_puzzle_hash, &args)?;
        debug!("THEIR TURN MOVE OFF CHAIN SUCCEEDED {new_puzzle_hash:?}");

        let check_and_report_slash =
            |allocator: &mut AllocEncoder, move_data: &TheirTurnMoveData| {
                for evidence in move_data.slash_evidence.iter() {
                    debug!("check their turn for slash");
                    if let Some(result) =
                        self.check_their_turn_for_slash(allocator, *evidence, &created_coin)?
                    {
                        return Ok(result);
                    }
                }

                Ok(TheirTurnCoinSpentResult::Moved {
                    new_coin_string: CoinString::from_parts(
                        &coin_string.to_coin_id(),
                        &new_puzzle_hash,
                        &self.fixed.amount,
                    ),
                    readable: ReadableMove::from_nodeptr(allocator, move_data.readable_move)?,
                    mover_share: args.game_move.basic.mover_share.clone(),
                })
            };

        debug!("referee move details {details:?}");
        match result.original {
            TheirTurnResult::Slash(evidence) => {
                let slash_spend = self.make_slash_spend(allocator, coin_string)?;
                self.make_slash_for_their_turn(
                    allocator,
                    coin_string,
                    new_puzzle,
                    &new_puzzle_hash,
                    &slash_spend,
                    evidence,
                    false,
                )
            }
            TheirTurnResult::FinalMove(move_data) => check_and_report_slash(allocator, &move_data),
            TheirTurnResult::MakeMove(_, _, move_data) => {
                check_and_report_slash(allocator, &move_data)
            }
        }
    }

    /// Output coin_string:
    /// Parent is hash of current_coin
    /// Puzzle hash is my_referee_puzzle_hash.
    ///
    /// Timeout unlike other actions applies to the current ph, not the one at the
    /// start of a turn proper.
    pub fn get_transaction_for_timeout(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
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

    pub fn accept_their_move(
        &mut self,
        allocator: &mut AllocEncoder,
        game_handler: Option<GameHandler>,
        old_args: Rc<RefereePuzzleArgs>,
        referee_args: Rc<RefereePuzzleArgs>,
        details: &GameMoveDetails,
        state_number: usize,
    ) -> Result<(), Error> {
        assert_ne!(old_args.mover_puzzle_hash, referee_args.mover_puzzle_hash);
        assert_eq!(old_args.mover_puzzle_hash, referee_args.waiter_puzzle_hash);
        assert_eq!(
            self.fixed.my_identity.puzzle_hash,
            referee_args.mover_puzzle_hash
        );
        debug!("accept their move {details:?}");

        // An empty handler if the game ended.
        let raw_game_handler = if let Some(g) = game_handler.as_ref() {
            g.clone()
        } else {
            let nil = allocator
                .encode_atom(clvm_traits::Atom::Borrowed(&[]))
                .into_gen()?;
            GameHandler::MyTurnHandler(Program::from_nodeptr(allocator, nil)?.into())
        };

        // let new_state = match self.state.borrow() {
        //     RefereeMakerGameState::Initial {
        //         initial_validation_program,
        //         initial_state,
        //         ..
        //     } => {
        //         let is_hash = initial_state.sha256tree(allocator).hash().clone();
        //         let ip_hash = initial_validation_program
        //             .sha256tree(allocator)
        //             .hash()
        //             .clone();
        //         let vi_hash = Sha256Input::Array(vec![
        //             Sha256Input::Hash(&is_hash),
        //             Sha256Input::Hash(&ip_hash),
        //         ])
        //         .hash();
        //         debug!("accept their move: state hash   {is_hash:?}");
        //         debug!("accept their move: valprog hash {ip_hash:?}");
        //         debug!("accept their move: validation info hash {vi_hash:?}");
        //         RefereeMakerGameState::AfterTheirTurn {
        //             game_handler: raw_game_handler.clone(),
        //             our_turn_game_handler: raw_game_handler.clone(),
        //             most_recent_our_state_result: initial_state.clone(),
        //             most_recent_our_validation_program: initial_validation_program.clone(),
        //             create_this_coin: old_args,
        //             spend_this_coin: referee_args,
        //         }
        //     }
        //     RefereeMakerGameState::AfterOurTurn { state, my_turn_result, .. } => {
        //         let is_hash = state.sha256tree(allocator).hash().clone();
        //         let ip_hash = my_turn_result
        //             .validation_program
        //             .sha256tree(allocator)
        //             .hash()
        //             .clone();
        //         let vi_hash = Sha256Input::Array(vec![
        //             Sha256Input::Hash(&is_hash),
        //             Sha256Input::Hash(&ip_hash),
        //         ])
        //         .hash();
        //         debug!("accept their move: state hash   {is_hash:?}");
        //         debug!("accept their move: valprog hash {ip_hash:?}");
        //         debug!("accept their move: validation info hash {vi_hash:?}");
        //         RefereeMakerGameState::AfterTheirTurn {
        //             game_handler: raw_game_handler.clone(),
        //             most_recent_our_state_result: state.p(),
        //             most_recent_our_validation_program: my_turn_result.validation_program.clone(),
        //             our_turn_game_handler: raw_game_handler.clone(),
        //             create_this_coin: old_args,
        //             spend_this_coin: referee_args,
        //         }
        //     }
        //     RefereeMakerGameState::AfterTheirTurn { .. } => {
        //         return Err(Error::StrErr(
        //             "accept their move when it's already past their turn".to_string(),
        //         ));
        //     }
        // };

        // if game_handler.is_none() {
        //     self.finished = true;
        // }

        // debug!("accept their move: {new_state:?}");
        // self.old_states.push(StoredGameState {
        //     state: self.state.clone(),
        //     state_number,
        // });
        // self.state = Rc::new(new_state);
        // Ok(())
        todo!();
    }
}
