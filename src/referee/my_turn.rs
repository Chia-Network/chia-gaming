use std::borrow::Borrow;
use std::rc::Rc;

use clvm_traits::ToClvm;
use clvmr::allocator::NodePtr;
use clvmr::run_program;

use log::debug;

use serde::{Deserialize, Serialize};

use crate::channel_handler::game_handler::{
    GameHandler, MessageHandler, MessageInputs, MyTurnInputs, MyTurnResult, TheirTurnMoveData,
    TheirTurnResult,
};
use crate::channel_handler::types::{Evidence, GameStartInfo, ReadableMove, ValidationProgram};
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
    GameMoveWireData, InternalValidatorArgs, RMFixed, RefereePuzzleArgs, SlashOutcome,
    TheirTurnCoinSpentResult, TheirTurnMoveResult, ValidatorMoveArgs, ValidatorResult,
};
use crate::referee::RefereeByTurn;

// Contains a state of the game for use in currying the coin puzzle or for
// reference when calling the game_handler.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum MyTurnRefereeMakerGameState {
    Initial {
        initial_state: Rc<Program>,
        initial_validation_program: ValidationProgram,
        initial_puzzle_args: Rc<RefereePuzzleArgs>,
        game_handler: GameHandler,
    },
    AfterTheirTurn {
        game_handler: GameHandler,
        #[allow(dead_code)]
        our_turn_game_handler: GameHandler,
        most_recent_our_validation_program: ValidationProgram,
        most_recent_our_state_result: Rc<Program>,
        create_this_coin: Rc<RefereePuzzleArgs>,
        spend_this_coin: Rc<RefereePuzzleArgs>,
    },
}

impl MyTurnRefereeMakerGameState {
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

// XXX break out state so we can have a previous state and easily swap them.
// Referee coin has two inner puzzles.
// Throughout channel handler, the one that's ours is the standard format puzzle
// to the pubkey of the referee private key (referred to in channel_handler).
#[derive(Clone, Debug, Serialize, Deserialize)]
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
        reward_puzzle_hash: &PuzzleHash,
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
            reward_puzzle_hash: reward_puzzle_hash.clone(),
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
            initial_validation_program: game_start_info.initial_validation_program.clone(),
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
                most_recent_our_state_result,
                ..
            } => most_recent_our_state_result.clone(),
        }
    }

    pub fn get_validation_program_for_their_move(
        &self,
    ) -> Result<(&Program, ValidationProgram), Error> {
        match self.state.borrow() {
            MyTurnRefereeMakerGameState::Initial {
                game_handler,
                initial_state,
                initial_validation_program,
                ..
            } => {
                if game_handler.is_my_turn() {
                    return Err(Error::StrErr("no moves have been made yet".to_string()));
                }
                Ok((initial_state, initial_validation_program.clone()))
            }
            MyTurnRefereeMakerGameState::AfterTheirTurn {
                most_recent_our_validation_program,
                most_recent_our_state_result,
                ..
            } => Ok((
                most_recent_our_state_result,
                most_recent_our_validation_program.clone(),
            )),
        }
    }

    pub fn get_our_current_share(&self) -> Amount {
        let args = self.spend_this_coin();
        if self.processing_my_turn() {
            self.fixed.amount.clone() - args.game_move.basic.mover_share.clone()
        } else {
            args.game_move.basic.mover_share.clone()
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn accept_this_move(
        &self,
        game_handler: &GameHandler,
        current_puzzle_args: Rc<RefereePuzzleArgs>,
        new_puzzle_args: Rc<RefereePuzzleArgs>,
        my_turn_result: Rc<MyTurnResult>,
        details: &GameMoveDetails,
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
            game_handler: game_handler.clone(),
            my_turn_result,
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
        debug!("new state {:?}", result.state);

        let ref_puzzle_args = Rc::new(RefereePuzzleArgs::new(
            &self.fixed,
            &result.game_move.basic,
            Some(&args.game_move.validation_info_hash),
            &result.game_move.validation_info_hash,
            None,
            false,
        ));
        assert_eq!(
            Some(&args.game_move.validation_info_hash),
            ref_puzzle_args.previous_validation_info_hash.as_ref()
        );

        let new_self = self.accept_this_move(
            &result.waiting_driver,
            args.clone(),
            ref_puzzle_args.clone(),
            result.clone(),
            &result.game_move,
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
                details: result.game_move.clone(),
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
                most_recent_our_state_result,
                create_this_coin,
                ..
            } => (
                most_recent_our_state_result,
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

    pub fn run_validator_for_their_move(
        &self,
        allocator: &mut AllocEncoder,
        state: Rc<Program>,
        evidence: Evidence,
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
            move_made: puzzle_args.game_move.basic.move_made.clone(),
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
            move_args: ValidatorMoveArgs {
                evidence: evidence.to_program(),
                state: state.clone(),
                mover_puzzle: self.fixed.my_identity.puzzle.to_program(),
                solution: solution_program,
            },
        };

        debug!("getting validation program");
        debug!("my turn {}", self.is_my_turn());
        debug!("state {:?}", self.state);
        let (_state, validation_program) = self.get_validation_program_for_their_move()?;
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
        );

        Ok(match result {
            Ok(res) => ValidatorResult::Slash(res.1),
            Err(_) => ValidatorResult::MoveOk,
        })
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
                self.fixed.reward_puzzle_hash.clone(),
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

    pub fn check_their_turn_for_slash(
        &self,
        allocator: &mut AllocEncoder,
        state: Rc<Program>,
        evidence: Evidence,
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
        // my_inner_solution maker is just in charge of making aggsigs from
        // conditions.
        debug!("run validator for their move");
        let full_slash_result =
            self.run_validator_for_their_move(allocator, state, evidence.clone())?;
        match full_slash_result {
            ValidatorResult::Slash(_slash) => {
                // result is NodePtr containing solution and aggsig.
                // The aggsig for the nil slash is the same as the slash
                // below, having been created for the reward coin by using
                // the standard solution signer.
                let slash_spend = self.make_slash_spend(allocator, coin_string)?;
                self.make_slash_for_their_turn(
                    allocator,
                    coin_string,
                    new_puzzle,
                    &new_puzzle_hash,
                    &slash_spend,
                    evidence,
                )
                .map(Some)
            }
            ValidatorResult::MoveOk => Ok(None),
        }
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

    pub fn check_their_turn_coin_spent(
        &self,
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

        if !repeat {
            return Err(Error::StrErr("their turn move when in our move state, and it wasn't a fast forward to our current state".to_string()));
        }

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
        debug!("repeat: current state {:?}", self.state);

        // This state was the state of our parent, a their turn handler.
        let (state, spend_args) = if let Some(p) = self.parent.as_ref() {
            (p.get_game_state(), p.spend_this_coin())
        } else {
            return Err(Error::StrErr("my turn asked to replay a their turn fast forward but it is the first move in the game".to_string()));
        };

        let nil_evidence = Evidence::nil()?;
        if let Some(result) =
            self.check_their_turn_for_slash(allocator, state.clone(), nil_evidence, &created_coin)?
        {
            // A repeat means that we tried a move but went on chain.
            // if the move is slashable, then we should do that here.
            return Ok(result);
        }

        let nil_readable = ReadableMove::from_program(Program::from_hex("80")?.into());
        Ok(TheirTurnCoinSpentResult::Moved {
            new_coin_string: CoinString::from_parts(
                &coin_string.to_coin_id(),
                &after_puzzle_hash,
                &self.fixed.amount,
            ),
            readable: nil_readable,
            state_number: state_number,
            mover_share: spend_args.game_move.basic.mover_share.clone(),
        })
    }

    pub fn finish_their_turn(
        &self,
        allocator: &mut AllocEncoder,
        move_data: &TheirTurnMoveData,
        puzzle_args: Rc<RefereePuzzleArgs>,
        result: TheirTurnResult,
        coin: Option<&CoinString>,
    ) -> Result<TheirTurnMoveResult, Error> {
        // If specified, check for slash.
        if let Some(coin_string) = coin {
            for evidence in move_data.slash_evidence.iter() {
                debug!("calling slash for given evidence");
                if self
                    .check_their_turn_for_slash(
                        allocator,
                        self.get_game_state(),
                        evidence.clone(),
                        coin_string,
                    )?
                    .is_some()
                {
                    // Slash isn't allowed in off chain, we'll go on chain via error.
                    debug!("slash was allowed");
                    return Err(Error::StrErr("slashable when off chain".to_string()));
                }
            }
        }

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
