pub mod types;
pub mod old;
pub mod my_turn;
pub mod their_turn;

use std::borrow::Borrow;
use std::rc::Rc;

use clvm_traits::{clvm_curried_args, ClvmEncoder, ToClvm, ToClvmError};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;
use clvmr::run_program;

use log::debug;

use serde::{Deserialize, Serialize};

use crate::channel_handler::game_handler::{
    GameHandler, MessageHandler, MessageInputs, MyTurnInputs, MyTurnResult, TheirTurnInputs,
    TheirTurnMoveData, TheirTurnResult,
};
use crate::channel_handler::types::{
    Evidence, GameStartInfo, ReadableMove, ValidationInfo, ValidationProgram,
};
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    calculate_hash_of_quoted_mod_hash, curry_and_treehash, standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{
    chia_dialect, u64_from_atom, usize_from_atom, Aggsig, AllocEncoder, Amount,
    BrokenOutCoinSpendInfo, CoinCondition, CoinSpend, CoinString, Error, GameID, Hash, IntoErr,
    Node, Program, Puzzle, PuzzleHash, RcNode, Sha256Input, Sha256tree, Spend, Timeout,
};
use crate::referee::types::{RefereePuzzleArgs, RMFixed, GameMoveStateInfo, curry_referee_puzzle_hash, GameMoveDetails, GameMoveWireData, curry_referee_puzzle, OnChainRefereeSolution, RefereeOnChainTransaction, OnChainRefereeMove, IdentityCoinAndSolution, ValidatorResult, InternalValidatorArgs, ValidatorMoveArgs, TheirTurnMoveResult, TheirTurnCoinSpentResult, SlashOutcome, REM_CONDITION_FIELDS};
use crate::referee::old::{OldRefereeMaker, RefereeMakerGameState, StoredGameState};
use crate::referee::my_turn::{MyTurnReferee, MyTurnRefereeMakerGameState};
use crate::referee::their_turn::{TheirTurnReferee, TheirTurnRefereeMakerGameState};

#[derive(Clone, Debug)]
pub enum RefereeByTurn {
    MyTurn(MyTurnReferee),
    TheirTurn(TheirTurnReferee),
}

impl RefereeByTurn {
    fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            RefereeByTurn::MyTurn(t) => t.args_for_this_coin(),
            RefereeByTurn::TheirTurn(t) => t.args_for_this_coin()
        }
    }

    fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match self {
            RefereeByTurn::MyTurn(t) => t.spend_this_coin(),
            RefereeByTurn::TheirTurn(t) => t.spend_this_coin()
        }
    }

    fn get_game_handler(&self) -> GameHandler {
        match self {
            RefereeByTurn::MyTurn(t) => t.get_game_handler(),
            RefereeByTurn::TheirTurn(t) => t.get_game_handler()
        }
    }

    fn get_game_state(&self) -> Rc<Program> {
        match self {
            RefereeByTurn::MyTurn(t) => t.get_game_state(),
            RefereeByTurn::TheirTurn(t) => t.get_game_state()
        }
    }

    pub fn get_validation_program_for_their_move(
        &self,
    ) -> Result<(&Program, ValidationProgram), Error> {
        match self {
            RefereeByTurn::MyTurn(t) => t.get_validation_program_for_their_move(),
            RefereeByTurn::TheirTurn(t) => {
                todo!();
            }
        }
    }

    pub fn is_my_turn(&self) -> bool {
        match self {
            RefereeByTurn::MyTurn(t) => true,
            RefereeByTurn::TheirTurn(t) => false,
        }
    }

    pub fn processing_my_turn(&self) -> bool {
        matches!(self, RefereeByTurn::TheirTurn(_))
    }

    pub fn state_number(&self) -> usize {
        match self {
            RefereeByTurn::MyTurn(t) => t.state_number(),
            RefereeByTurn::TheirTurn(t) => t.state_number()
        }
    }

    pub fn fixed(&self) -> Rc<RMFixed> {
        match self {
            RefereeByTurn::MyTurn(t) => t.fixed.clone(),
            RefereeByTurn::TheirTurn(t) => t.fixed.clone()
        }
    }

    pub fn get_validation_program(&self) -> Result<Rc<Program>, Error> {
        match self {
            RefereeByTurn::MyTurn(t) => t.get_validation_program(),
            RefereeByTurn::TheirTurn(t) => t.get_validation_program()
        }
    }

    pub fn stored_versions(&self) -> Vec<(Rc<RefereePuzzleArgs>, Rc<RefereePuzzleArgs>, usize)> {
        let mut alist = vec![];
        self.generate_ancestor_list(&mut alist);
        let mut res: Vec<_> = alist.into_iter().rev().map(|a| {
            (a.args_for_this_coin(), a.spend_this_coin(), a.state_number())
        }).collect();
        res
    }

    pub fn my_turn_make_move(
        &mut self,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove,
        new_entropy: Hash,
        state_number: usize,
    ) -> Result<GameMoveWireData, Error> {
        let (replacement, result) =
            match self {
                RefereeByTurn::MyTurn(t) => t.my_turn_make_move(
                    allocator,
                    readable_move,
                    new_entropy,
                    state_number
                )?,
                RefereeByTurn::TheirTurn(t) => {
                    todo!();
                }
            };
        *self = replacement;
        Ok(result)
    }

    pub fn receive_readable(
        &mut self,
        allocator: &mut AllocEncoder,
        message: &[u8],
    ) -> Result<ReadableMove, Error> {
        match self {
            RefereeByTurn::MyTurn(t) => t.receive_readable(allocator, message),
            RefereeByTurn::TheirTurn(t) => t.receive_readable(allocator, message),
        }
    }

    pub fn get_transaction_for_move(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        on_chain: bool,
    ) -> Result<RefereeOnChainTransaction, Error> {
        match self {
            RefereeByTurn::MyTurn(t) => {
                todo!();
            }
            RefereeByTurn::TheirTurn(t) => t.get_transaction_for_move(
                allocator,
                coin_string,
                on_chain
            )
        }
    }

    pub fn run_validator_for_their_move(
        &self,
        allocator: &mut AllocEncoder,
        evidence: Evidence,
    ) -> Result<ValidatorResult, Error> {
        match self {
            RefereeByTurn::MyTurn(t) => {
                t.run_validator_for_their_move(
                    allocator,
                    t.get_game_state(),
                    evidence,
                )
            },
            RefereeByTurn::TheirTurn(t) => {
                todo!();
            }
        }
    }

    pub fn their_turn_move_off_chain(
        &mut self,
        allocator: &mut AllocEncoder,
        details: &GameMoveDetails,
        state_number: usize,
        coin: Option<&CoinString>,
    ) -> Result<TheirTurnMoveResult, Error> {
        let (new_self, result) =
            match self {
                RefereeByTurn::MyTurn(t) => {
                    todo!();
                }
                RefereeByTurn::TheirTurn(t) => {
                    t.their_turn_move_off_chain(
                        allocator,
                        details,
                        state_number,
                        coin,
                    )?
                }
            };

        if let Some(new_self) = new_self {
            *self = RefereeByTurn::MyTurn(new_self);
        }
        Ok(result)
    }

    pub fn their_turn_coin_spent(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        conditions: &[CoinCondition],
        state_number: usize,
    ) -> Result<TheirTurnCoinSpentResult, Error> {
        match self {
            // We could be called on to fast forward the most recent transaction
            // we ourselves took.  check_their_turn_coin_spent will return an
            // error if it was asked to do a non-fast-forward their turn spend.
            RefereeByTurn::MyTurn(t) => t.check_their_turn_coin_spent(
                allocator,
                coin_string,
                conditions,
                state_number,
            ),
            RefereeByTurn::TheirTurn(t) => {
                let (new_self, result) =
                    t.their_turn_coin_spent(
                        allocator,
                        coin_string,
                        conditions,
                        state_number,
                    )?;

                *self = new_self;
                Ok(result)
            }
        }
    }

    pub fn generate_ancestor_list(&self, ref_list: &mut Vec<RefereeByTurn>) {
        match self {
            RefereeByTurn::MyTurn(t) => {
                if let Some(p) = t.parent.as_ref() {
                    let p_ref: &TheirTurnReferee = p.borrow();
                    let their_turn = RefereeByTurn::TheirTurn(p_ref.clone());
                    ref_list.push(their_turn.clone());
                    their_turn.generate_ancestor_list(ref_list);
                }
            }
            RefereeByTurn::TheirTurn(t) => {
                if let Some(p) = t.parent.as_ref() {
                    let p_ref: &MyTurnReferee = p.borrow();
                    let my_turn = RefereeByTurn::MyTurn(p_ref.clone());
                    ref_list.push(my_turn.clone());
                    my_turn.generate_ancestor_list(ref_list);
                }
            }
        }
    }

    pub fn rewind(
        &mut self,
        allocator: &mut AllocEncoder,
        puzzle_hash: &PuzzleHash,
    ) -> Result<Option<usize>, Error> {
        let mut ancestors = vec![];
        self.generate_ancestor_list(&mut ancestors);

        for old_referee in ancestors.iter() {
            let start_args = old_referee.args_for_this_coin();
            let end_args = old_referee.spend_this_coin();
            debug!(
                "end   puzzle hash {:?}",
                curry_referee_puzzle_hash(
                    allocator,
                    &old_referee.fixed().referee_coin_puzzle_hash,
                    &end_args
                )
            );
            debug!(
                "state {} is_my_turn {}",
                old_referee.state_number(),
                old_referee.is_my_turn()
            );
            debug!(
                "start puzzle hash {:?}",
                curry_referee_puzzle_hash(
                    allocator,
                    &old_referee.fixed().referee_coin_puzzle_hash,
                    &start_args
                )
            );
        }

        for old_referee in ancestors.iter() {
            let have_puzzle_hash = curry_referee_puzzle_hash(
                allocator,
                &old_referee.fixed().referee_coin_puzzle_hash,
                &old_referee.args_for_this_coin(),
            )?;
            debug!(
                "{} referee rewind: {} my turn {} try state {have_puzzle_hash:?} want {puzzle_hash:?}",
                old_referee.state_number(),
                old_referee.is_my_turn(),
                old_referee.state_number()
            );
            if *puzzle_hash == have_puzzle_hash && old_referee.is_my_turn() {
                let state_number = old_referee.state_number();
                self.clone_from(old_referee);
                return Ok(Some(state_number));
            }
        }

        debug!("referee rewind: no matching state");
        debug!("still in state {:?}", self.state_number());
        Ok(None)
    }

    pub fn check_their_turn_for_slash(
        &self,
        allocator: &mut AllocEncoder,
        evidence: Evidence,
        coin_string: &CoinString,
    ) -> Result<Option<TheirTurnCoinSpentResult>, Error> {
        let puzzle_args = self.spend_this_coin();
        let new_puzzle = curry_referee_puzzle(
            allocator,
            &self.fixed().referee_coin_puzzle,
            &self.fixed().referee_coin_puzzle_hash,
            &puzzle_args,
        )?;

        let new_puzzle_hash = curry_referee_puzzle_hash(
            allocator,
            &self.fixed().referee_coin_puzzle_hash,
            &puzzle_args,
        )?;
        // my_inner_solution maker is just in charge of making aggsigs from
        // conditions.
        debug!("run validator for their move");
        let full_slash_result = self.run_validator_for_their_move(allocator, evidence.clone())?;
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

    fn make_slash_conditions(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        [(
            CREATE_COIN,
            (
                self.target_puzzle_hash_for_slash(),
                (self.fixed().amount.clone(), ()),
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
            &self.fixed().my_identity.synthetic_private_key,
            &coin_id.to_coin_id(),
            slash_conditions,
            &self.fixed().my_identity.synthetic_public_key,
            &self.fixed().agg_sig_me_additional_data,
            false,
        )
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
    ) -> Result<TheirTurnCoinSpentResult, Error> {
        // Probably readable_info overlaps solution.
        // Moving driver in that context is the signature.
        // My reward coin string is the coin that we'll make
        // after the transaction below has been spent so its
        // parent is the coin id of that coin.
        let current_mover_share = self.get_our_current_share();

        let (state, validation_program) = self.get_validation_program_for_their_move()?;
        let reward_amount = self.fixed().amount.clone() - current_mover_share;
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

    // It me.
    fn target_puzzle_hash_for_slash(&self) -> PuzzleHash {
        self.fixed().my_identity.puzzle_hash.clone()
    }

    pub fn get_our_current_share(&self) -> Amount {
        let args = self.spend_this_coin();
        if self.processing_my_turn() {
            self.fixed().amount.clone() - args.game_move.basic.mover_share.clone()
        } else {
            args.game_move.basic.mover_share.clone()
        }
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
                        RcNode::new(self.fixed().my_identity.puzzle.to_program()),
                        (Node(slash_solution), (evidence, ())),
                    ),
                ),
            ),
        )
            .to_clvm(allocator)
            .into_gen()
    }
}

#[derive(Clone)]
pub enum StateByTurn {
    MyTurn(Rc<MyTurnRefereeMakerGameState>),
    TheirTurn(Rc<TheirTurnRefereeMakerGameState>),
}

// XXX break out state so we can have a previous state and easily swap them.
// Referee coin has two inner puzzles.
// Throughout channel handler, the one that's ours is the standard format puzzle
// to the pubkey of the referee private key (referred to in channel_handler).
#[derive(Clone)]
pub struct RefereeMaker {
    fixed: Rc<RMFixed>,

    old_ref: OldRefereeMaker,
    referee: RefereeByTurn,
}

impl RefereeMaker {
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
            referee_coin_puzzle: referee_coin_puzzle.clone(),
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
        let state = Rc::new(RefereeMakerGameState::Initial {
            initial_state: game_start_info.initial_state.p(),
            initial_validation_program: game_start_info.initial_validation_program.clone(),
            initial_puzzle_args: ref_puzzle_args.clone(),
            game_handler: game_start_info.game_handler.clone(),
        });
        let puzzle_hash =
            curry_referee_puzzle_hash(allocator, &referee_coin_puzzle_hash, &ref_puzzle_args)?;

        let (old_ref, or_ph) = OldRefereeMaker::new(
            allocator,
            referee_coin_puzzle.clone(),
            referee_coin_puzzle_hash.clone(),
            game_start_info,
            my_identity.clone(),
            their_puzzle_hash,
            nonce,
            agg_sig_me_additional_data
        )?;
        let (turn, t_ph) = if my_turn {
            let tr = MyTurnReferee::new(
                allocator,
                referee_coin_puzzle.clone(),
                referee_coin_puzzle_hash.clone(),
                game_start_info,
                my_identity.clone(),
                their_puzzle_hash,
                nonce,
                agg_sig_me_additional_data,
                state_number,
            )?;
            (RefereeByTurn::MyTurn(tr.0), tr.1)
        } else {
            let tr = TheirTurnReferee::new(
                allocator,
                referee_coin_puzzle,
                referee_coin_puzzle_hash,
                game_start_info,
                my_identity,
                their_puzzle_hash,
                nonce,
                agg_sig_me_additional_data,
                state_number,
            )?;
            (RefereeByTurn::TheirTurn(tr.0), tr.1)
        };
        assert_eq!(or_ph, t_ph);
        Ok((
            RefereeMaker {
                fixed: fixed_info,
                old_ref,
                referee: turn,
            },
            puzzle_hash,
        ))
    }

    fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        let old_args = self.old_ref.args_for_this_coin();
        let new_args = self.referee.args_for_this_coin();
        assert_eq!(old_args, new_args);
        new_args
    }

    fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        let old_args = self.old_ref.spend_this_coin();
        let new_args = self.referee.spend_this_coin();
        assert_eq!(old_args, new_args);
        new_args
    }

    pub fn rewind(
        &mut self,
        allocator: &mut AllocEncoder,
        puzzle_hash: &PuzzleHash,
    ) -> Result<Option<usize>, Error> {
        assert_eq!(self.old_ref.args_for_this_coin(), self.referee.args_for_this_coin());
        assert_eq!(self.old_ref.spend_this_coin(), self.referee.spend_this_coin());
        debug!("REWIND: old find a way to proceed from {puzzle_hash:?}");
        let old_result = self.old_ref.rewind(allocator, puzzle_hash)?;
        debug!("REWIND: new find a way to proceed from {puzzle_hash:?}");
        let new_result = self.referee.rewind(allocator, puzzle_hash)?;
        assert_eq!(old_result, new_result);
        assert_eq!(self.old_ref.args_for_this_coin(), self.referee.args_for_this_coin());
        assert_eq!(self.old_ref.spend_this_coin(), self.referee.spend_this_coin());
        assert_eq!(self.old_ref.is_my_turn(), self.referee.is_my_turn());
        assert_eq!(self.old_ref.get_game_handler(), self.referee.get_game_handler());
        assert_eq!(self.old_ref.get_game_state(), self.referee.get_game_state());
        Ok(new_result)
    }

    pub fn is_my_turn(&self) -> bool {
        matches!(self.referee, RefereeByTurn::MyTurn(_))
    }

    pub fn processing_my_turn(&self) -> bool {
        matches!(self.referee, RefereeByTurn::TheirTurn(_))
    }

    pub fn get_game_handler(&self) -> GameHandler {
        let old_handler = self.old_ref.get_game_handler();
        let new_handler = self.referee.get_game_handler();
        assert_eq!(old_handler, new_handler);
        new_handler
    }

    pub fn get_game_state(&self) -> Rc<Program> {
        let old_state = self.old_ref.get_game_state();
        let new_state = self.referee.get_game_state();
        assert_eq!(old_state, new_state);
        new_state
    }

    pub fn get_validation_program_for_their_move(
        &self,
    ) -> Result<(&Program, ValidationProgram), Error> {
        let old_vp = self.old_ref.get_validation_program_for_their_move()?;
        let new_vp = self.referee.get_validation_program_for_their_move()?;
        assert_eq!(old_vp, new_vp);
        Ok(new_vp)
    }

    pub fn get_validation_program(&self) -> Result<Rc<Program>, Error> {
        let old_res = self.old_ref.get_validation_program()?;
        let new_res = self.referee.get_validation_program()?;
        assert_eq!(old_res, new_res);
        Ok(new_res)
    }

    pub fn get_amount(&self) -> Amount {
        self.fixed.amount.clone()
    }

    pub fn get_our_current_share(&self) -> Amount {
        self.referee.get_our_current_share()
    }

    pub fn get_their_current_share(&self) -> Amount {
        self.fixed.amount.clone() - self.get_our_current_share()
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
        assert_eq!(self.old_ref.args_for_this_coin(), self.referee.args_for_this_coin());
        assert_eq!(self.old_ref.spend_this_coin(), self.referee.spend_this_coin());
        let old_res = self.old_ref.my_turn_make_move(
            allocator,
            readable_move,
            new_entropy.clone(),
            state_number
        )?;
        let new_res = self.referee.my_turn_make_move(
            allocator,
            readable_move,
            new_entropy.clone(),
            state_number
        )?;
        assert_eq!(old_res, new_res);
        assert_eq!(self.old_ref.stored_versions(), self.referee.stored_versions());
        Ok(new_res)
    }

    pub fn receive_readable(
        &mut self,
        allocator: &mut AllocEncoder,
        message: &[u8],
    ) -> Result<ReadableMove, Error> {
        assert_eq!(self.old_ref.args_for_this_coin(), self.referee.args_for_this_coin());
        assert_eq!(self.old_ref.spend_this_coin(), self.referee.spend_this_coin());
        let old_res = self.old_ref.receive_readable(allocator, message)?;
        let new_res = self.referee.receive_readable(allocator, message)?;
        assert_eq!(old_res, new_res);
        Ok(new_res)
    }

    pub fn on_chain_referee_puzzle(&self, allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
        assert_eq!(self.old_ref.args_for_this_coin(), self.referee.args_for_this_coin());
        assert_eq!(self.old_ref.spend_this_coin(), self.referee.spend_this_coin());
        let args = self.args_for_this_coin();
        curry_referee_puzzle(
            allocator,
            &self.fixed.referee_coin_puzzle,
            &self.fixed.referee_coin_puzzle_hash,
            &args,
        )
    }

    pub fn outcome_referee_puzzle(&self, allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
        assert_eq!(self.old_ref.args_for_this_coin(), self.referee.args_for_this_coin());
        assert_eq!(self.old_ref.spend_this_coin(), self.referee.spend_this_coin());
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
        assert_eq!(self.old_ref.args_for_this_coin(), self.referee.args_for_this_coin());
        assert_eq!(self.old_ref.spend_this_coin(), self.referee.spend_this_coin());
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
        &mut self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
        assert_eq!(self.old_ref.args_for_this_coin(), self.referee.args_for_this_coin());
        assert_eq!(self.old_ref.spend_this_coin(), self.referee.spend_this_coin());
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
        assert_eq!(self.old_ref.args_for_this_coin(), self.referee.args_for_this_coin());
        assert_eq!(self.old_ref.spend_this_coin(), self.referee.spend_this_coin());
        let old_tx = self.old_ref.get_transaction_for_move(allocator, coin_string, on_chain)?;
        let new_tx = self.referee.get_transaction_for_move(allocator, coin_string, on_chain)?;
        assert_eq!(old_tx, new_tx);
        Ok(new_tx)
    }

    pub fn run_validator_for_their_move(
        &self,
        allocator: &mut AllocEncoder,
        evidence: Evidence,
    ) -> Result<ValidatorResult, Error> {
        assert_eq!(self.old_ref.args_for_this_coin(), self.referee.args_for_this_coin());
        assert_eq!(self.old_ref.spend_this_coin(), self.referee.spend_this_coin());
        let old_val = self.old_ref.run_validator_for_their_move(allocator, evidence.clone());
        let new_val = self.referee.run_validator_for_their_move(allocator, evidence);
        if old_val.is_err() {
            assert!(new_val.is_err());
            return new_val;
        }
        assert!(!new_val.is_err());
        new_val
    }

    pub fn their_turn_move_off_chain(
        &mut self,
        allocator: &mut AllocEncoder,
        details: &GameMoveDetails,
        state_number: usize,
        coin: Option<&CoinString>,
    ) -> Result<TheirTurnMoveResult, Error> {
        assert_eq!(self.old_ref.args_for_this_coin(), self.referee.args_for_this_coin());
        assert_eq!(self.old_ref.spend_this_coin(), self.referee.spend_this_coin());
        let old_val = self.old_ref.their_turn_move_off_chain(
            allocator,
            details,
            state_number,
            coin
        );
        let new_val = self.referee.their_turn_move_off_chain(
            allocator,
            details,
            state_number,
            coin,
        );
        debug!("their_turn_move_off_chain old_val {old_val:?}");
        debug!("their_turn_move_off_chain new_val {new_val:?}");
        if old_val.is_err() {
            assert!(new_val.is_err());
            return new_val;
        }
        assert!(!new_val.is_err());
        assert_eq!(new_val.as_ref().unwrap(), old_val.as_ref().unwrap());
        assert_eq!(self.old_ref.args_for_this_coin(), self.referee.args_for_this_coin());
        assert_eq!(self.old_ref.spend_this_coin(), self.referee.spend_this_coin());
        assert_eq!(self.old_ref.stored_versions(), self.referee.stored_versions());
        new_val
    }

    // It me.
    fn target_puzzle_hash_for_slash(&self) -> PuzzleHash {
        self.referee.target_puzzle_hash_for_slash()
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
        self.referee.slashing_coin_solution(
            allocator,
            state,
            my_validation_info_hash,
            validation_program_clvm,
            slash_solution,
            evidence
        )
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
    ) -> Result<TheirTurnCoinSpentResult, Error> {
        self.referee.make_slash_for_their_turn(
            allocator,
            coin_string,
            new_puzzle,
            new_puzzle_hash,
            slash_spend,
            evidence
        )
    }

    fn make_slash_conditions(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        self.referee.make_slash_conditions(allocator)
    }

    fn make_slash_spend(
        &self,
        allocator: &mut AllocEncoder,
        coin_id: &CoinString,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        self.referee.make_slash_spend(allocator, coin_id)
    }

    pub fn check_their_turn_for_slash(
        &self,
        allocator: &mut AllocEncoder,
        evidence: Evidence,
        coin_string: &CoinString,
    ) -> Result<Option<TheirTurnCoinSpentResult>, Error> {
        self.referee.check_their_turn_for_slash(
            allocator,
            evidence,
            coin_string
        )
    }

    pub fn their_turn_coin_spent(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        conditions: &[CoinCondition],
        state_number: usize,
    ) -> Result<TheirTurnCoinSpentResult, Error> {
        debug!("their turn coin spent is_my_turn {}", self.referee.is_my_turn());
        assert_eq!(self.old_ref.is_my_turn(), self.referee.is_my_turn());
        let old_res = self.old_ref.their_turn_coin_spent(
            allocator,
            coin_string,
            conditions,
            state_number
        );
        debug!("referee is {:?}", self.referee);
        let new_res = self.referee.their_turn_coin_spent(
            allocator,
            coin_string,
            conditions,
            state_number,
        );
        if old_res.is_err() {
            assert!(new_res.is_err());
            return new_res;
        }
        assert!(!new_res.is_err());
        assert_eq!(old_res.as_ref().unwrap(), new_res.as_ref().unwrap());
        new_res
    }
}
