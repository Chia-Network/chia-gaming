use clvm_traits::{clvm_curried_args, ClvmEncoder, ToClvm, ToClvmError};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;
use rand::distributions::Standard;
use rand::prelude::*;

use crate::channel_handler::game_handler::GameHandler;
use crate::common::standard_coin::read_hex_puzzle;
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinID, CoinString, Error, GameID, Hash, IntoErr, PrivateKey,
    PublicKey, Puzzle, PuzzleHash, Sha256tree, SpecificTransactionBundle, Timeout,
};
use crate::referee::{GameMoveDetails, RefereeMaker};

#[derive(Default)]
pub struct ChannelHandlerPrivateKeys {
    pub my_channel_coin_private_key: PrivateKey,
    pub my_unroll_coin_private_key: PrivateKey,
    pub my_referee_private_key: PrivateKey,
}

impl Distribution<ChannelHandlerPrivateKeys> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> ChannelHandlerPrivateKeys {
        ChannelHandlerPrivateKeys {
            my_channel_coin_private_key: rng.gen(),
            my_unroll_coin_private_key: rng.gen(),
            my_referee_private_key: rng.gen(),
        }
    }
}

pub struct ChannelHandlerInitiationData {
    pub launcher_coin_id: CoinID,
    pub we_start_with_potato: bool,
    pub their_channel_pubkey: PublicKey,
    pub their_unroll_pubkey: PublicKey,
    pub their_referee_puzzle_hash: PuzzleHash,
    pub my_contribution: Amount,
    pub their_contribution: Amount,
}

pub struct ChannelHandlerInitiationResult {
    pub channel_puzzle_hash_up: PuzzleHash,
    pub my_initial_channel_half_signature_peer: Aggsig,
}

pub struct PotatoSignatures {
    // Half signed thing signing to the new state.
    pub my_channel_half_signature_peer: Aggsig,
    // Half signed thing allowing you to supercede an earlier state to this one.
    pub my_unroll_half_signature_peer: Aggsig,
}

#[derive(Debug, Clone)]
pub struct GameStartInfo {
    pub game_id: GameID,
    pub amount: Amount,
    pub game_handler: GameHandler,
    pub timeout: Timeout,
    pub is_my_turn: bool,
    pub initial_validation_puzzle: NodePtr,
    pub initial_validation_puzzle_hash: PuzzleHash,
    pub initial_state: NodePtr,
    pub initial_move: Vec<u8>,
    pub initial_max_move_size: usize,
    pub initial_mover_share: Amount,
}

#[derive(Clone)]
pub struct ReadableMove(NodePtr);

impl ReadableMove {
    pub fn from_nodeptr(n: NodePtr) -> Self {
        ReadableMove(n)
    }
}

impl ToClvm<NodePtr> for ReadableMove {
    fn to_clvm(
        &self,
        _encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        Ok(self.0)
    }
}

#[derive(Clone)]
pub struct ReadableUX(NodePtr);

pub struct MoveResult {
    pub signatures: PotatoSignatures,
    pub game_move: GameMoveDetails,
}

pub struct OnChainGameCoin<'a> {
    pub game_id_up: GameID,
    pub coin_string_up: Option<CoinString>,
    pub referee_up: &'a RefereeMaker,
}

#[derive(Clone)]
pub struct CoinSpentMoveUp {
    pub game_id: GameID,
    pub spend_before_game_coin: SpecificTransactionBundle,
    pub after_update_game_coin: CoinString,
}

#[derive(Clone)]
pub struct CoinSpentAccept {
    pub game_id: GameID,
    pub spend: SpecificTransactionBundle,
    pub reward_coin: CoinString,
}

// Disposition
#[derive(Clone)]
pub enum CoinSpentDisposition {
    CancelledUX(Vec<GameID>),
    Move(CoinSpentMoveUp),
    Accept(CoinSpentAccept),
}

pub struct DispositionResult {
    pub skip_game: Vec<GameID>,
    pub skip_coin_id: Option<GameID>,
    pub our_contribution_adjustment: Amount,
    pub disposition: CoinSpentDisposition,
}

pub struct CoinSpentResult<'a> {
    pub my_clean_reward_coin_string_up: CoinString,
    // New coins that now exist.
    pub new_game_coins_on_chain: Vec<OnChainGameCoin<'a>>,
    pub disposition: Option<CoinSpentDisposition>,
}

pub struct UnrollCoinSignatures {
    pub to_create_unroll_coin: Aggsig,
    pub to_spend_unroll_coin: Aggsig,
}

pub fn read_unroll_metapuzzle(allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
    read_hex_puzzle(allocator, "resources/unroll_meta_puzzle.hex")
}

pub fn read_unroll_puzzle(allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
    read_hex_puzzle(
        allocator,
        "resources/unroll_puzzle_state_channel_unrolling.hex",
    )
}

pub struct ChannelHandlerEnv<'a, R: Rng> {
    pub allocator: &'a mut AllocEncoder,
    pub rng: &'a mut R,
    pub unroll_metapuzzle: Puzzle,
    pub unroll_puzzle: Puzzle,

    pub referee_coin_puzzle: Puzzle,
    pub referee_coin_puzzle_hash: PuzzleHash,

    pub agg_sig_me_additional_data: Hash,
}

impl<'a, R: Rng> ChannelHandlerEnv<'a, R> {
    pub fn new(
        allocator: &'a mut AllocEncoder,
        rng: &'a mut R,
        unroll_metapuzzle: Puzzle,
        unroll_puzzle: Puzzle,
        referee_coin_puzzle: Puzzle,
        agg_sig_me_additional_data: Hash,
    ) -> ChannelHandlerEnv<'a, R> {
        let referee_coin_puzzle_hash = referee_coin_puzzle.sha256tree(allocator);
        ChannelHandlerEnv {
            allocator,
            rng,
            referee_coin_puzzle,
            referee_coin_puzzle_hash,
            unroll_metapuzzle,
            unroll_puzzle,
            agg_sig_me_additional_data,
        }
    }

    pub fn curried_unroll_puzzle(
        &mut self,
        old_seq_number: u64,
        default_conditions_hash: PuzzleHash,
    ) -> Result<Puzzle, Error> {
        let curried_program = CurriedProgram {
            program: self.unroll_puzzle.clone(),
            args: clvm_curried_args!(
                self.unroll_metapuzzle.clone(),
                old_seq_number,
                default_conditions_hash
            ),
        };
        let nodeptr = curried_program.to_clvm(self.allocator).into_gen()?;
        Ok(Puzzle::from_nodeptr(nodeptr))
    }
}

pub struct LiveGame {
    pub game_id: GameID,
    pub referee_maker: Box<RefereeMaker>,
}

pub struct PotatoAcceptCachedData {
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub live_game: LiveGame,
    pub at_stake_amount: Amount,
    pub our_share_amount: Amount,
}

pub struct PotatoMoveCachedData {
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub amount: Amount,
}

pub enum CachedPotatoRegenerateLastHop {
    PotatoCreatedGame(Vec<GameID>, Amount, Amount),
    PotatoAccept(PotatoAcceptCachedData),
    PotatoMoveHappening(PotatoMoveCachedData),
}
