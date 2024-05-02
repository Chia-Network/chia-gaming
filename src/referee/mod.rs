use clvmr::allocator::NodePtr;
use crate::common::types::{Aggsig, Amount, CoinString, PuzzleHash, Hash, Puzzle, Program, Timeout, PrivateKey, Error, AllocEncoder};
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
    readable_move: NodePtr,
    message: NodePtr
}

pub enum TheirTurnCoinSpentResult {
    Timedout {
        my_reward_coin_string: CoinString
    },
    Moved {
        new_coin_string: CoinString,
        readable: NodePtr
    },
    Slash {
        new_coin_string: CoinString,
        puzzle_reveal: Puzzle,
        solution: NodePtr,
        aggsig: Aggsig,
        my_reward_coin_string: CoinString
    }
}

pub struct RefereeMaker {
}

impl RefereeMaker {
    pub fn new(_allocator: &mut AllocEncoder, _amount: Amount, _game_handler: Program, _is_my_turn: bool, _timeout: Timeout, _validation_puzzle: Puzzle, _validation_puzzle_hash: PuzzleHash, _initial_state: NodePtr, _initial_move: &[u8], _initial_move_max_size: usize, _initial_mover_share: Amount, _my_private_key: PrivateKey, _their_puzzle_hash: PuzzleHash, _nonce: usize) -> Self {
        todo!();
    }

    pub fn get_initial_puzzle_hash(&self) -> PuzzleHash {
        todo!();
    }

    pub fn my_turn_make_move(&mut self, _allocator: &mut AllocEncoder, _readable_move: &NodePtr) -> RefereeMakerMoveResult {
        todo!();
    }

    pub fn get_transaction_for_move(&mut self, _allocator: &mut AllocEncoder, _coin_string: &CoinString) -> (TransactionBundle, CoinString) {
        todo!();
    }

    pub fn get_my_share(&self, _allocator: &mut AllocEncoder) -> Amount {
        todo!();
    }

    pub fn get_timeout_transaction(&self, _allocator: &mut AllocEncoder) -> (TransactionBundle, CoinString) {
        todo!();
    }

    pub fn their_turn_move_off_chain(&mut self, _allocator: &mut AllocEncoder, _their_move: &[u8], _validation_info_hash: &Hash, _max_move_size: usize, _mover_share: &Amount) -> TheirTurnMoveResult {
        todo!();
    }

    pub fn their_turn_coin_spent(&mut self, _allocator: &mut AllocEncoder, _coin_string: &CoinString, _conditions: &NodePtr) -> Result<TheirTurnCoinSpentResult, Error> {
        todo!();
    }
}
