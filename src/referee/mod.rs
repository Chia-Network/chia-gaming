pub mod types;
pub mod puzzle_args;
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
    Node, Program, ProgramRef, Puzzle, PuzzleHash, RcNode, Sha256Input, Sha256tree, Spend, Timeout, atom_from_clvm,
};
use crate::referee::types::{RMFixed, RefereeMakerGameState, StoredGameState, ValidatorResult, OnChainRefereeSolution, RefereeOnChainTransaction, GameMoveStateInfo, GameMoveWireData, GameMoveDetails, TheirTurnMoveResult, TheirTurnCoinSpentResult};
use crate::referee::puzzle_args::{RefereePuzzleArgs, curry_referee_puzzle_hash, curry_referee_puzzle};
use crate::utils::proper_list;

#[allow(dead_code)]
pub struct LiveGameReplay {
    #[allow(dead_code)]
    game_id: GameID,
}

// XXX break out state so we can have a previous state and easily swap them.
// Referee coin has two inner puzzles.
// Throughout channel handler, the one that's ours is the standard format puzzle
// to the pubkey of the referee private key (referred to in channel_handler).
#[derive(Clone)]
pub struct RefereeMaker {
    fixed: Rc<RMFixed>,

    pub finished: bool,

    #[cfg(test)]
    pub run_debug: bool,

    pub message_handler: Option<MessageHandler>,

    state: Rc<RefereeMakerGameState>,
    old_states: Vec<StoredGameState>,
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
        let state = Rc::new(RefereeMakerGameState::Initial {
            initial_state: game_start_info.initial_state.p(),
            initial_validation_program: game_start_info.initial_validation_program.clone(),
            initial_max_move_size: game_start_info.initial_max_move_size,
            initial_puzzle_args: ref_puzzle_args.clone(),
            game_handler: game_start_info.game_handler.clone(),
        });
        let puzzle_hash =
            curry_referee_puzzle_hash(allocator, &referee_coin_puzzle_hash, &ref_puzzle_args)?;

        Ok((
            RefereeMaker {
                fixed: fixed_info,
                finished: false,
                state,
                old_states: Vec::new(),
                message_handler: None,
                #[cfg(test)]
                run_debug: false,
            },
            puzzle_hash,
        ))
    }

    fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        self.state.args_for_this_coin()
    }

    fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        self.state.spend_this_coin()
    }

    pub fn rewind(
        &mut self,
        allocator: &mut AllocEncoder,
        puzzle_hash: &PuzzleHash,
    ) -> Result<Option<usize>, Error> {
        // debug!("REWIND: find a way to proceed from {puzzle_hash:?}");
        // for old_state in self.old_states.iter().skip(1).rev() {
        //     let start_args = old_state.state.args_for_this_coin();
        //     let end_args = old_state.state.spend_this_coin();
        //     debug!(
        //         "end   puzzle hash {:?}",
        //         curry_referee_puzzle_hash(
        //             allocator,
        //             &self.fixed.referee_coin_puzzle_hash,
        //             &end_args
        //         )
        //     );
        //     debug!(
        //         "state {} is_my_turn {}",
        //         old_state.state_number,
        //         old_state.state.is_my_turn()
        //     );
        //     debug!(
        //         "start puzzle hash {:?}",
        //         curry_referee_puzzle_hash(
        //             allocator,
        //             &self.fixed.referee_coin_puzzle_hash,
        //             &start_args
        //         )
        //     );
        // }

        // for old_state in self.old_states.iter().skip(1).rev() {
        //     let have_puzzle_hash = curry_referee_puzzle_hash(
        //         allocator,
        //         &self.fixed.referee_coin_puzzle_hash,
        //         &old_state.state.args_for_this_coin(),
        //     )?;
        //     debug!(
        //         "referee rewind: {} my turn {} try state {have_puzzle_hash:?} want {puzzle_hash:?}",
        //         old_state.state.is_my_turn(),
        //         old_state.state_number
        //     );
        //     if *puzzle_hash == have_puzzle_hash && old_state.state.is_my_turn() {
        //         self.state = old_state.state.clone();
        //         debug!("referee rewind my turn: reassume state {:?}", self.state);
        //         return Ok(Some(old_state.state_number));
        //     }
        // }

        // debug!("referee rewind: no matching state");
        // debug!("still in state {:?}", self.state);
        // Ok(None)
        todo!();
    }

    pub fn is_my_turn(&self) -> bool {
        self.state.is_my_turn()
    }

    pub fn processing_my_turn(&self) -> bool {
        self.state.processing_my_turn()
    }

    pub fn get_game_handler(&self) -> GameHandler {
        match self.state.borrow() {
            RefereeMakerGameState::Initial { game_handler, .. }
            | RefereeMakerGameState::AfterOurTurn { game_handler, .. }
            | RefereeMakerGameState::AfterTheirTurn { game_handler, .. } => game_handler.clone(),
        }
    }

    pub fn get_game_state(&self) -> Rc<Program> {
        match self.state.borrow() {
            RefereeMakerGameState::Initial { initial_state, .. } => initial_state.clone(),
            RefereeMakerGameState::AfterOurTurn { state, .. } => {
                state.p()
            }
            RefereeMakerGameState::AfterTheirTurn {
                most_recent_our_state_result,
                ..
            } => most_recent_our_state_result.clone(),
        }
    }

    pub fn get_validation_program_for_move(
        &self,
        their_move: bool,
    ) -> Result<(&Program, ValidationProgram), Error> {
        todo!();
        match self.state.borrow() {
            RefereeMakerGameState::Initial {
                initial_state,
                initial_validation_program,
                ..
            } => {
                Ok((initial_state, initial_validation_program.clone()))
            }
            RefereeMakerGameState::AfterOurTurn { .. } => {
                todo!();
            }
            RefereeMakerGameState::AfterTheirTurn {
                most_recent_our_validation_program,
                most_recent_our_state_result,
                ..
            } => Ok((
                most_recent_our_state_result,
                most_recent_our_validation_program.clone(),
            )),
        }
    }

    #[cfg(test)]
    pub fn enable_debug_run(&mut self, ena: bool) {
        self.run_debug = ena;
    }

    pub fn get_validation_program(&self) -> Result<Rc<Program>, Error> {
        match self.state.borrow() {
            RefereeMakerGameState::Initial {
                initial_validation_program,
                ..
            } => Ok(initial_validation_program.to_program().clone()),
            RefereeMakerGameState::AfterOurTurn { my_turn_result, .. } => {
                Ok(my_turn_result.validation_program.to_program())
            }
            RefereeMakerGameState::AfterTheirTurn { .. } => Err(Error::StrErr(
                "we already accepted their turn so it can't be validated".to_string(),
            )),
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

    fn get_our_state_for_handler(
        &mut self,
        allocator: &mut AllocEncoder,
    ) -> Result<(Hash, ProgramRef, usize), Error> {
        let nil = allocator.allocator().nil();
        if let RefereeMakerGameState::Initial { initial_state, initial_validation_program, initial_max_move_size, .. } = self.state.borrow() {
            return Ok((initial_validation_program.hash().clone(), initial_state.clone().into(), *initial_max_move_size));
        }

        todo!();
        // if let ValidatorResult::MoveOk(hash, state, max_move_size) = self.run_validator_for_move(
        //     allocator,
        //     nil,
        //     false
        // )? {
        //     Ok((hash, state, max_move_size))
        // } else {
        //     Err(Error::StrErr("slash indicated on our turn".to_string()))
        // }
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

    // Since we may need to know new_entropy at a higher layer, we'll need to ensure it
    // gets passed in rather than originating it here.
    pub fn my_turn_make_move(
        &mut self,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove,
        new_entropy: Hash,
        state_number: usize,
    ) -> Result<GameMoveWireData, Error> {
        todo!();
    }

    pub fn their_turn_move_off_chain(
        &mut self,
        allocator: &mut AllocEncoder,
        details: &GameMoveDetails,
        state_number: usize,
        coin: Option<&CoinString>,
    ) -> Result<TheirTurnMoveResult, Error> {
        todo!();
    }

    pub fn check_their_turn_for_slash(
        &self,
        allocator: &mut AllocEncoder,
        evidence: NodePtr,
        coin_string: &CoinString,
    ) -> Result<Option<TheirTurnCoinSpentResult>, Error> {
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
        todo!();
    }

    pub fn receive_readable(
        &mut self,
        allocator: &mut AllocEncoder,
        message: &[u8],
    ) -> Result<ReadableMove, Error> {
        todo!();
    }

    pub fn their_turn_coin_spent(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        conditions: &[CoinCondition],
        state_number: usize,
    ) -> Result<TheirTurnCoinSpentResult, Error> {
        todo!();
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
        todo!();
    }
}
