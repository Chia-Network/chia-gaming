use clvmr::allocator::Allocator;
use crate::common::types::{Aggsig, Amount, ClvmObject, CoinString, PuzzleHash, Hash, Puzzle, Program, Timeout, PrivateKey, Error};
use crate::channel_handler::types::TransactionBundle;

pub struct RefereeMakerMoveResult {
    puzzle_hash_for_unroll: PuzzleHash,
    move_made: Vec<u8>,
    validation_info_hash: Hash,
    max_move_size: usize,
    mover_share: Amount
}

pub struct TheirTurnMoveResult {
    puzzle_hash_for_unroll: PuzzleHash,
    readable_move: ClvmObject,
    message: ClvmObject
}

pub enum TheirTurnCoinSpentResult {
    Timedout {
        my_reward_coin_string: CoinString
    },
    Moved {
        new_coin_string: CoinString,
        readable: ClvmObject
    },
    Slash {
        new_coin_string: CoinString,
        puzzle_reveal: Puzzle,
        solution: ClvmObject,
        aggsig: Aggsig,
        my_reward_coin_string: CoinString
    }
}

pub struct RefereeMaker {
}

impl RefereeMaker {
    pub fn new(_allocator: &mut Allocator, _amount: Amount, _game_handler: Program, _is_my_turn: bool, _timeout: Timeout, _validation_puzzle: Puzzle, _validation_puzzle_hash: PuzzleHash, _initial_state: ClvmObject, _initial_move: &[u8], _initial_move_max_size: usize, _initial_mover_share: Amount, _my_private_key: PrivateKey, _their_puzzle_hash: PuzzleHash, _nonce: usize) -> Self {
        todo!();
    }

    pub fn get_initial_puzzle_hash(&self) -> PuzzleHash {
        todo!();
    }

    pub fn my_turn_make_move(&mut self, _allocator: &mut Allocator, _readable_move: &ClvmObject) -> RefereeMakerMoveResult {
        todo!();
    }

    pub fn get_transaction_for_move(&mut self, _allocator: &mut Allocator, _coin_string: &CoinString) -> (TransactionBundle, CoinString) {
        todo!();
    }

    pub fn get_my_share(&self, _allocator: &mut Allocator) -> Amount {
        todo!();
    }

    pub fn get_timeout_transaction(&self, _allocator: &mut Allocator) -> (TransactionBundle, CoinString) {
        todo!();
    }

    pub fn their_turn_move_off_chain(&mut self, _allocator: &mut Allocator, _their_move: &[u8], _validation_info_hash: &Hash, _max_move_size: usize, _mover_share: &Amount) -> TheirTurnMoveResult {
        todo!();
    }

    pub fn their_turn_coin_spent(&mut self, _allocator: &mut Allocator, _coin_string: &CoinString, _conditions: &ClvmObject) -> Result<TheirTurnCoinSpentResult, Error> {
        todo!();
    }
}
