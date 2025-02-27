pub mod types;
pub mod puzzle_args;
pub mod my_turn;
pub mod their_turn;
pub mod old;

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
use crate::referee::my_turn::MyTurnReferee;
use crate::referee::their_turn::TheirTurnReferee;
use crate::referee::types::{RMFixed, RefereeMakerGameState, StoredGameState, ValidatorResult, OnChainRefereeSolution, RefereeOnChainTransaction, GameMoveStateInfo, GameMoveWireData, GameMoveDetails, TheirTurnMoveResult, TheirTurnCoinSpentResult};
use crate::referee::puzzle_args::{RefereePuzzleArgs, curry_referee_puzzle_hash, curry_referee_puzzle};
use crate::referee::old::OldRefereeMaker;
use crate::utils::proper_list;

#[allow(dead_code)]
pub struct LiveGameReplay {
    #[allow(dead_code)]
    game_id: GameID,
}

#[derive(Clone)]
enum RefereeMachine {
    MyTurn(MyTurnReferee),
    TheirTurn(TheirTurnReferee),
}

// XXX break out state so we can have a previous state and easily swap them.
// Referee coin has two inner puzzles.
// Throughout channel handler, the one that's ours is the standard format puzzle
// to the pubkey of the referee private key (referred to in channel_handler).
#[derive(Clone)]
pub struct RefereeMaker {
    fixed: Rc<RMFixed>,

    old_ref: OldRefereeMaker,

    pub finished: bool,

    pub referee: RefereeMachine,
    old_states: Vec<RefereeMachine>,
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
        let my_turn = game_start_info.game_handler.is_my_turn();
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
        let referee = if my_turn {
            RefereeMachine::MyTurn(MyTurnReferee::new(
                allocator,
                fixed_info.clone(),
                referee_coin_puzzle.clone(),
                referee_coin_puzzle_hash.clone(),
                game_start_info,
                my_identity.clone(),
                their_puzzle_hash,
                nonce,
                agg_sig_me_additional_data
            )?)
        } else {
            RefereeMachine::TheirTurn(TheirTurnReferee::new(
                allocator,
                fixed_info.clone(),
                referee_coin_puzzle.clone(),
                referee_coin_puzzle_hash.clone(),
                game_start_info,
                my_identity.clone(),
                their_puzzle_hash,
                nonce,
                agg_sig_me_additional_data
            )?)
        };

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
            my_turn,
        ));

        let puzzle_hash =
            curry_referee_puzzle_hash(allocator, &referee_coin_puzzle_hash, &ref_puzzle_args)?;

        let (old_ref, old_ph) = OldRefereeMaker::new(
            allocator,
            referee_coin_puzzle,
            referee_coin_puzzle_hash,
            game_start_info,
            my_identity,
            their_puzzle_hash,
            nonce,
            agg_sig_me_additional_data,
        )?;

        assert_eq!(puzzle_hash, old_ph);

        Ok((RefereeMaker {
            fixed: fixed_info,
            finished: false,
            referee,
            old_states: Vec::new(),
            old_ref
        }, puzzle_hash))
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
        matches!(self.referee, RefereeMachine::MyTurn(_))
    }

    pub fn processing_my_turn(&self) -> bool {
        matches!(self.referee, RefereeMachine::TheirTurn(_))
    }

    pub fn get_amount(&self) -> Amount {
        self.fixed.amount.clone()
    }

    pub fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match &self.referee {
            RefereeMachine::MyTurn(r) => r.args_for_this_coin(),
            RefereeMachine::TheirTurn(r) => r.spend_this_coin(),
        }
    }

    pub fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        match &self.referee {
            RefereeMachine::MyTurn(r) => r.spend_this_coin(),
            RefereeMachine::TheirTurn(r) => r.spend_this_coin(),
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

    pub fn get_their_current_share(&self) -> Amount {
        self.fixed.amount.clone() - self.get_our_current_share()
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
        match &mut self.referee {
            RefereeMachine::MyTurn(t) => t.my_turn_make_move(
                allocator,
                readable_move,
                new_entropy,
                state_number
            ),
            RefereeMachine::TheirTurn(t) => {
                Err(Error::StrErr("my turn make move but not our turn".to_string()))
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

    pub fn run_validator_for_move(
        &self,
        allocator: &mut AllocEncoder,
        evidence: NodePtr,
        their_move: bool,
    ) -> Result<ValidatorResult, Error> {
        match &self.referee {
            RefereeMachine::MyTurn(_) => {
                todo!();
            }
            RefereeMachine::TheirTurn(t) => {
                t.run_validator_for_move(allocator, evidence)
            }
        }
    }
}
