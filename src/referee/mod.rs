pub mod types;

use std::rc::Rc;

use crate::channel_handler::types::{GameStartInfo, ReadableMove, StateUpdateProgram};
use crate::common::standard_coin::ChiaIdentity;
use crate::common::types::{
    AllocEncoder, Amount, CoinCondition, CoinString, Error, Hash, Puzzle, PuzzleHash,
};
use crate::referee::types::{
    GameMoveDetails, GameMoveWireData, OnChainRefereeSolution, RMFixed, RefereeOnChainTransaction,
    RefereePuzzleArgs, TheirTurnCoinSpentResult, TheirTurnMoveResult,
};

#[derive(Clone, Debug)]
pub struct RefereeByTurn {}

pub type StateUpdateProgramRef = Rc<RefereePuzzleArgs>;

pub trait RefereeInterface {
    /// args for this coin from when it was spent (in the past)
    fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs>;

    fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs>;

    fn is_my_turn(&self) -> bool;

    fn processing_my_turn(&self) -> bool;

    fn state_number(&self) -> usize;

    fn get_amount(&self) -> Amount;

    fn get_their_current_share(&self) -> Amount;

    fn fixed(&self) -> Rc<RMFixed>;

    fn enable_cheating(&self, _make_move: &[u8]) -> Option<Rc<dyn RefereeInterface>>;

    fn stored_versions(&self) -> Vec<(StateUpdateProgramRef, StateUpdateProgramRef, usize)>;

    fn my_turn_make_move(
        &self,
        _allocator: &mut AllocEncoder,
        _readable_move: &ReadableMove,
        _new_entropy: Hash,
        _state_number: usize,
    ) -> Result<(Rc<dyn RefereeInterface>, GameMoveWireData), Error>;

    fn receive_readable(
        &self,
        _allocator: &mut AllocEncoder,
        _message: &[u8],
    ) -> Result<ReadableMove, Error>;

    fn their_turn_move_off_chain(
        &self,
        _allocator: &mut AllocEncoder,
        _details: &GameMoveDetails,
        _state_number: usize,
        _coin: Option<&CoinString>,
    ) -> Result<(Option<Rc<dyn RefereeInterface>>, TheirTurnMoveResult), Error>;

    fn their_turn_coin_spent(
        &self,
        _allocator: &mut AllocEncoder,
        _referee_coin_string: &CoinString,
        _conditions: &[CoinCondition],
        _state_number: usize,
    ) -> Result<(Option<Rc<dyn RefereeInterface>>, TheirTurnCoinSpentResult), Error>;

    fn generate_ancestor_list(&self, _ref_list: &mut Vec<RefereeByTurn>);

    fn rewind(
        &self,
        _allocator: &mut AllocEncoder,
        _puzzle_hash: &PuzzleHash,
    ) -> Result<Option<(Rc<dyn RefereeInterface>, usize)>, Error>;

    fn get_our_current_share(&self) -> Amount;

    /// Output coin_string:
    /// Parent is hash of current_coin
    /// Puzzle hash is my_referee_puzzle_hash.
    ///
    /// Timeout unlike other actions applies to the current ph, not the one at the
    /// start of a turn proper.
    fn get_transaction_for_timeout(
        &self,
        _allocator: &mut AllocEncoder,
        _coin_string: &CoinString,
    ) -> Result<Option<RefereeOnChainTransaction>, Error>;

    fn on_chain_referee_puzzle(&self, _allocator: &mut AllocEncoder) -> Result<Puzzle, Error>;

    fn outcome_referee_puzzle(&self, _allocator: &mut AllocEncoder) -> Result<Puzzle, Error>;

    fn on_chain_referee_puzzle_hash(
        &self,
        _allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error>;

    fn outcome_referee_puzzle_hash(
        &self,
        _allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error>;

    // Ensure this returns
    fn get_transaction(
        &self,
        _allocator: &mut AllocEncoder,
        _coin_string: &CoinString,
        _always_produce_transaction: bool,
        _puzzle: Puzzle,
        _targs: &RefereePuzzleArgs,
        _args: &OnChainRefereeSolution,
    ) -> Result<Option<RefereeOnChainTransaction>, Error>;

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
    fn get_transaction_for_move(
        &self,
        _allocator: &mut AllocEncoder,
        _coin_string: &CoinString,
        _on_chain: bool,
    ) -> Result<RefereeOnChainTransaction, Error>;
}

impl RefereeByTurn {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        _allocator: &mut AllocEncoder,
        _referee_coin_puzzle: Puzzle,
        _referee_coin_puzzle_hash: PuzzleHash,
        _game_start_info: &GameStartInfo,
        _my_identity: ChiaIdentity,
        _their_puzzle_hash: &PuzzleHash,
        _nonce: usize,
        _agg_sig_me_additional_data: &Hash,
        _state_number: usize,
    ) -> Result<(Self, PuzzleHash), Error> {
        todo!();
    }
}

pub type RefereeAndStateNumber = (Rc<dyn RefereeInterface>, usize);

impl RefereeInterface for RefereeByTurn {
    /// ph at the beginning of the turn that this move
    /// ph_we will turn into
    /// will be used for spend_this_coin
    fn args_for_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        todo!();
    }

    fn spend_this_coin(&self) -> Rc<RefereePuzzleArgs> {
        todo!();
    }

    fn is_my_turn(&self) -> bool {
        /// We are working on an "our" move
        todo!();
    }

    fn processing_my_turn(&self) -> bool {
        todo!();
    }

    fn state_number(&self) -> usize {
        todo!();
    }

    fn get_amount(&self) -> Amount {
        self.fixed().amount.clone()
    }

    fn get_their_current_share(&self) -> Amount {
        todo!();
    }

    /// Access constant referee properties
    fn fixed(&self) -> Rc<RMFixed> {
        todo!();
    }

    fn enable_cheating(&self, _make_move: &[u8]) -> Option<Rc<dyn RefereeInterface>> {
        todo!();
    }

    /// List of referee objects from the past that can be rewound to
    fn stored_versions(&self) -> Vec<(StateUpdateProgramRef, StateUpdateProgramRef, usize)> {
        todo!();
    }

    fn my_turn_make_move(
        &self,
        _allocator: &mut AllocEncoder,
        _readable_move: &ReadableMove,
        _new_entropy: Hash,
        _state_number: usize,
    ) -> Result<(Rc<dyn RefereeInterface>, GameMoveWireData), Error> {
        todo!();
    }

    fn receive_readable(
        &self,
        _allocator: &mut AllocEncoder,
        _message: &[u8],
    ) -> Result<ReadableMove, Error> {
        todo!();
    }

    fn their_turn_move_off_chain(
        &self,
        _allocator: &mut AllocEncoder,
        _details: &GameMoveDetails,
        _state_number: usize,
        _coin: Option<&CoinString>,
    ) -> Result<(Option<Rc<dyn RefereeInterface>>, TheirTurnMoveResult), Error> {
        todo!();
    }

    fn their_turn_coin_spent(
        &self,
        _allocator: &mut AllocEncoder,
        _referee_coin_string: &CoinString,
        _conditions: &[CoinCondition],
        _state_number: usize,
    ) -> Result<(Option<Rc<dyn RefereeInterface>>, TheirTurnCoinSpentResult), Error> {
        todo!();
    }

    fn generate_ancestor_list(&self, _ref_list: &mut Vec<RefereeByTurn>) {
        todo!();
    }

    fn rewind(
        &self,
        _allocator: &mut AllocEncoder,
        _puzzle_hash: &PuzzleHash,
    ) -> Result<Option<RefereeAndStateNumber>, Error> {
        todo!();
    }

    fn get_our_current_share(&self) -> Amount {
        todo!();
    }

    /// Output coin_string:
    /// Parent is hash of current_coin
    /// Puzzle hash is my_referee_puzzle_hash.
    ///
    /// Timeout unlike other actions applies to the current ph, not the one at the
    /// start of a turn proper.
    fn get_transaction_for_timeout(
        &self,
        _allocator: &mut AllocEncoder,
        _coin_string: &CoinString,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
        todo!();
    }

    fn on_chain_referee_puzzle(&self, _allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
        todo!();
    }

    fn outcome_referee_puzzle(&self, _allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
        todo!();
    }

    fn on_chain_referee_puzzle_hash(
        &self,
        _allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error> {
        todo!();
    }

    fn outcome_referee_puzzle_hash(
        &self,
        _allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error> {
        todo!();
    }

    // Ensure this returns
    fn get_transaction(
        &self,
        _allocator: &mut AllocEncoder,
        _coin_string: &CoinString,
        _always_produce_transaction: bool,
        _puzzle: Puzzle,
        _targs: &RefereePuzzleArgs,
        _args: &OnChainRefereeSolution,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
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
    fn get_transaction_for_move(
        &self,
        _allocator: &mut AllocEncoder,
        _coin_string: &CoinString,
        _on_chain: bool,
    ) -> Result<RefereeOnChainTransaction, Error> {
        todo!();
    }
}

pub type RefereeMaker = RefereeByTurn;