use clvmr::allocator::NodePtr;
use crate::common::types::{Aggsig, Amount, CoinString, PuzzleHash, Hash, Puzzle, Program, Timeout, PrivateKey, Error, AllocEncoder};
use crate::common::types::TransactionBundle;
use crate::channel_handler::types::{GameStartInfo, ReadableMove};

pub struct RefereeMakerMoveResult {
    pub puzzle_hash_for_unroll: PuzzleHash,
    pub move_made: Vec<u8>,
    pub validation_info_hash: Hash,
    pub max_move_size: usize,
    pub mover_share: Amount
}

pub struct TheirTurnMoveResult {
    pub puzzle_hash_for_unroll: PuzzleHash,
    pub readable_move: NodePtr,
    pub message: NodePtr
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
    pub referee_puzzle_hash: PuzzleHash,
    pub amount: Amount,
}

impl RefereeMaker {
    pub fn new(
        allocator: &mut AllocEncoder,
        game_start_info: &GameStartInfo,
        my_private_key: &PrivateKey,
        their_puzzle_hash: &PuzzleHash,
        nonce: usize
    ) -> Self {
        todo!();
    }

    pub fn get_amount(&self) -> Amount {
        self.amount.clone()
    }

    pub fn get_current_puzzle(&self) -> Puzzle {
        todo!()
    }

    pub fn get_current_puzzle_hash(&self) -> PuzzleHash {
        self.referee_puzzle_hash.clone()
    }

    pub fn my_turn_make_move(
        &mut self,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove
    ) -> Result<RefereeMakerMoveResult, Error> {
        todo!();
    }

    pub fn get_transaction_for_accept(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString
    ) -> Result<(TransactionBundle, CoinString), Error> {
        todo!();
    }

    pub fn get_transaction_for_move(
        &self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString
    ) -> Result<(TransactionBundle, CoinString), Error> {
        todo!();
    }

    pub fn get_my_share(&self, _allocator: &mut AllocEncoder) -> Amount {
        todo!();
    }

    pub fn get_timeout_transaction(&self, _allocator: &mut AllocEncoder) -> (TransactionBundle, CoinString) {
        todo!();
    }

    pub fn their_turn_move_off_chain(
        &mut self,
        _allocator: &mut AllocEncoder,
        _their_move: &[u8],
        _validation_info_hash: &Hash,
        _max_move_size: usize,
        _mover_share: &Amount
    ) -> Result<TheirTurnMoveResult, Error> {
        todo!();
    }

    pub fn their_turn_coin_spent(&mut self, _allocator: &mut AllocEncoder, _coin_string: &CoinString, _conditions: &NodePtr) -> Result<TheirTurnCoinSpentResult, Error> {
        todo!();
    }
}
