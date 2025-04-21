use log::debug;

use crate::channel_handler::types::Evidence;
use crate::channel_handler::ReadableMove;
use crate::common::types::{
    AllocEncoder, Amount, CoinCondition, CoinString, Error, GameID, Hash, PuzzleHash,
};
use crate::referee::types::{
    GameMoveDetails, GameMoveWireData, RefereeOnChainTransaction, TheirTurnCoinSpentResult,
    TheirTurnMoveResult,
};
use crate::referee::RefereeMaker;

pub struct LiveGame {
    pub game_id: GameID,
    pub rewind_outcome: Option<usize>,
    pub last_referee_puzzle_hash: PuzzleHash,
    referee_maker: RefereeMaker,
    pub my_contribution: Amount,
    pub their_contribution: Amount,
}

impl LiveGame {
    pub fn new(
        game_id: GameID,
        last_referee_puzzle_hash: PuzzleHash,
        referee_maker: RefereeMaker,
        my_contribution: Amount,
        their_contribution: Amount,
    ) -> LiveGame {
        LiveGame {
            game_id,
            last_referee_puzzle_hash,
            referee_maker,
            my_contribution,
            their_contribution,
            rewind_outcome: None,
        }
    }

    pub fn is_my_turn(&self) -> bool {
        self.referee_maker.is_my_turn()
    }

    pub fn processing_my_turn(&self) -> bool {
        self.referee_maker.processing_my_turn()
    }

    pub fn last_puzzle_hash(&self) -> PuzzleHash {
        self.last_referee_puzzle_hash.clone()
    }

    pub fn current_puzzle_hash(&self, allocator: &mut AllocEncoder) -> Result<PuzzleHash, Error> {
        self.referee_maker.on_chain_referee_puzzle_hash(allocator)
    }

    pub fn outcome_puzzle_hash(&self, allocator: &mut AllocEncoder) -> Result<PuzzleHash, Error> {
        self.referee_maker.outcome_referee_puzzle_hash(allocator)
    }

    pub fn internal_make_move(
        &mut self,
        allocator: &mut AllocEncoder,
        readable_move: &ReadableMove,
        new_entropy: Hash,
        state_number: usize,
    ) -> Result<GameMoveWireData, Error> {
        // assert!(self.referee_maker.is_my_turn());
        let (new_ref, referee_result) = self.referee_maker.my_turn_make_move(
            allocator,
            readable_move,
            new_entropy.clone(),
            state_number,
        )?;
        self.referee_maker = new_ref;
        self.last_referee_puzzle_hash = referee_result.puzzle_hash_for_unroll.clone();
        Ok(referee_result)
    }

    pub fn internal_their_move(
        &mut self,
        allocator: &mut AllocEncoder,
        game_move: &GameMoveDetails,
        state_number: usize,
        coin: Option<&CoinString>,
    ) -> Result<TheirTurnMoveResult, Error> {
        assert!(!self.referee_maker.is_my_turn());
        let (new_ref, their_move_result) = self.referee_maker.their_turn_move_off_chain(
            allocator,
            game_move,
            state_number,
            coin,
        )?;
        if let Some(r) = new_ref {
            self.referee_maker = r;
        }
        if let Some(ph) = &their_move_result.puzzle_hash_for_unroll {
            self.last_referee_puzzle_hash = ph.clone();
        }
        Ok(their_move_result)
    }

    pub fn check_their_turn_for_slash(
        &self,
        allocator: &mut AllocEncoder,
        evidence: Evidence,
        coin_string: &CoinString,
    ) -> Result<Option<TheirTurnCoinSpentResult>, Error> {
        self.referee_maker
            .check_their_turn_for_slash(allocator, evidence, coin_string)
    }

    pub fn get_rewind_outcome(&self) -> Option<usize> {
        self.rewind_outcome
    }

    pub fn get_amount(&self) -> Amount {
        self.referee_maker.get_amount()
    }

    pub fn get_our_current_share(&self) -> Amount {
        self.referee_maker.get_our_current_share()
    }

    pub fn get_transaction_for_move(
        &self,
        allocator: &mut AllocEncoder,
        game_coin: &CoinString,
        on_chain: bool,
    ) -> Result<RefereeOnChainTransaction, Error> {
        // assert!(self.referee_maker.processing_my_turn());
        self.referee_maker
            .get_transaction_for_move(allocator, game_coin, on_chain)
    }

    pub fn receive_readable(
        &mut self,
        allocator: &mut AllocEncoder,
        data: &[u8],
    ) -> Result<ReadableMove, Error> {
        self.referee_maker.receive_readable(allocator, data)
    }

    pub fn their_turn_coin_spent(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_string: &CoinString,
        conditions: &[CoinCondition],
        current_state: usize,
    ) -> Result<TheirTurnCoinSpentResult, Error> {
        // assert!(self.referee_maker.processing_my_turn());
        let (new_ref, res) = self.referee_maker.their_turn_coin_spent(
            allocator,
            coin_string,
            conditions,
            current_state,
        )?;
        if let Some(r) = new_ref {
            self.referee_maker = r;
        }
        self.last_referee_puzzle_hash = self.outcome_puzzle_hash(allocator)?;
        Ok(res)
    }

    /// Regress the live game state to the state we know so that we can generate the puzzle
    /// for that state.  We'll return the move needed to advance it fully.
    pub fn set_state_for_coin(
        &mut self,
        allocator: &mut AllocEncoder,
        want_ph: &PuzzleHash,
        current_state: usize,
    ) -> Result<Option<(bool, usize)>, Error> {
        let referee_puzzle_hash = self.referee_maker.on_chain_referee_puzzle_hash(allocator)?;

        debug!("live game: current state is {referee_puzzle_hash:?} want {want_ph:?}");
        let result = self.referee_maker.rewind(allocator, want_ph)?;
        if let Some((new_ref, current_state)) = result {
            self.referee_maker = new_ref;
            self.rewind_outcome = Some(current_state);
            self.last_referee_puzzle_hash = self.outcome_puzzle_hash(allocator)?;
            return Ok(Some((self.is_my_turn(), current_state)));
        }

        if referee_puzzle_hash == *want_ph {
            self.rewind_outcome = Some(current_state);
            self.last_referee_puzzle_hash = self.outcome_puzzle_hash(allocator)?;
            return Ok(Some((self.is_my_turn(), current_state)));
        }

        Ok(None)
    }

    pub fn get_transaction_for_timeout(
        &mut self,
        allocator: &mut AllocEncoder,
        coin: &CoinString,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
        self.referee_maker
            .get_transaction_for_timeout(allocator, coin)
    }
}
