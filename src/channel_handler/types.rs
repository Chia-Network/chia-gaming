use rand::prelude::*;
use rand::distributions::Standard;
use clvmr::allocator::Allocator;

use crate::common::types::{Amount, CoinString, PrivateKey, PublicKey, Aggsig, GameID, RefereeID, Program, Puzzle, PuzzleHash, Error, GameHandler, Timeout, ClvmObject, Hash};

#[derive(Default)]
pub struct ChannelHandlerPrivateKeys {
    my_channel_coin_private_key: PrivateKey,
    my_unroll_coin_private_key: PrivateKey,
    my_referee_private_key: PrivateKey,
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
    launcher_coin_string: CoinString,
    we_start_with_potato: bool,
    their_state_pubkey: PublicKey,
    their_unroll_pubkey: PublicKey,
    their_referee_puzzle_hash: PuzzleHash,
    my_contribution: Amount,
    their_contribution: Amount,
}

pub struct ChannelHandlerInitiationResult {
    initial_puzzle_hash_up: PuzzleHash,
    my_initial_channel_half_signature_peer: Aggsig
}

pub struct PotatoSignatures {
    my_channel_half_signature_peer: Aggsig,
    my_unroll_half_signature_peer: Aggsig,
}

pub struct GameStartInfo {
    game_id: GameID,
    amount: Amount,
    game_handler: GameHandler,
    timeout: Timeout,
    initial_validation_puzzle: ClvmObject,
    initial_validation_puzzle_hash: PuzzleHash,
    initial_state: ClvmObject,
    initial_move: Vec<u8>,
    initial_max_move_size: usize,
    initial_mover_share: Amount
}

pub struct ReadableMove(ClvmObject);

pub struct ReadableUX(ClvmObject);

pub struct MoveResult {
    signatures: PotatoSignatures,
    move_peer: Vec<u8>,
    validation_info_hash_peer: Hash,
    max_move_size_peer: usize,
    mover_share_peer: Amount
}

pub struct TransactionBundle {
    puzzle: Puzzle,
    solution: ClvmObject,
    signature: Aggsig
}

pub struct SpentResult {
    transaction_bundle: TransactionBundle,
    unroll_coin_string_up: CoinString,
    transaction_up: TransactionBundle,
    whether_has_timeout_up: bool
}

pub struct OnChainGameCoin<'a> {
    game_id_up: GameID,
    coin_string_up: CoinString,
    referee_up: &'a mut RefereeMaker
}

pub struct SpendRewardResult {
    coins_with_solutions: Vec<TransactionBundle>,
    result_coin_string_up: CoinString
}

pub struct CoinSpentResult<'a> {
    my_clean_reward_coin_string_up: CoinString,
    // New coins that now exist.
    new_game_coins_on_chain: Vec<OnChainGameCoin<'a>>,
    game_id_cancelled_ux: ClvmObject,
    game_id_to_move_up: GameID,
    game_id_of_accept_up: GameID
}

/// A channel handler runs the game by facilitating the phases of game startup
/// and passing on move information as well as termination to other layers.
#[derive(Default)]
pub struct ChannelHandler {
    private_keys: ChannelHandlerPrivateKeys,

    their_channel_coin_public_key: PublicKey,
    their_unroll_coin_public_key: PublicKey,
    their_referee_puzzle_hash: PuzzleHash,
    state_channel_coin_string: Option<CoinString>,
    my_out_of_game_balance: Amount,
    their_out_of_game_balance: Amount,
    have_potato: bool,
    current_state_number: usize,
    next_nonce_number: usize,

    last_channel_aggsig: Aggsig,
    last_unroll_aggsig: Aggsig,
    game_id_of_most_recent_move: Option<GameID>,
    game_id_of_most_recent_created_game: Option<GameID>,
    game_id_of_most_recent_accepted_game: Option<GameID>,
    referee_of_most_recent_accepted_game: Option<RefereeID>,
}

impl ChannelHandler {
    pub fn new(private_keys: ChannelHandlerPrivateKeys) -> Self {
        ChannelHandler {
            private_keys,
            .. ChannelHandler::default()
        }
    }

    pub fn construct_with_rng<R: Rng>(rng: &mut R) -> ChannelHandler {
        ChannelHandler::new(rng.gen())
    }

    pub fn initiate(&mut self, allocator: &mut Allocator, initiation: &ChannelHandlerInitiationData) -> ChannelHandlerInitiationResult {
        self.state_channel_coin_string = Some(initiation.launcher_coin_string.clone());
        self.have_potato = initiation.we_start_with_potato;
        self.their_channel_coin_public_key = initiation.their_state_pubkey.clone();
        self.their_unroll_coin_public_key = initiation.their_unroll_pubkey.clone();
        self.their_referee_puzzle_hash = initiation.their_referee_puzzle_hash.clone();
        self.my_out_of_game_balance = initiation.my_contribution.clone();
        self.their_out_of_game_balance = initiation.their_contribution.clone();
        todo!();
    }

    pub fn finish_handshake(&mut self, allocator: &mut Allocator, their_initial_channel_hash_signature: &Aggsig) -> Result<(), Error> {
        todo!();
    }

    pub fn send_empty_potato(&mut self, allocator: &mut Allocator) -> PotatoSignatures {
        todo!();
    }

    pub fn received_empty_potato(&mut self, allocator: &mut Allocator, signatures: &PotatoSignatures) -> Result<(), Error> {
        todo!();
    }

    pub fn send_potato_start_game(&mut self, allocator: &mut Allocator, my_contribution_this_game: Amount, their_contribution_this_game: Amount, start_info_list: &[GameStartInfo]) -> PotatoSignatures {
        todo!();
    }

    pub fn received_potato_start_game(&mut self, allocator: &mut Allocator, signatures: &PotatoSignatures, start_info_list: &[GameStartInfo]) -> Result<(), Error> {
        todo!();
    }

    pub fn send_potato_move(&mut self, allocator: &mut Allocator, game_id: &GameID, reable_move: &ReadableMove) -> MoveResult {
        todo!();
    }

    pub fn received_potato_move(&mut self, allocator: &mut Allocator, signatures: &PotatoSignatures, game_id: &GameID, their_move: &[u8], validation_info_hash: &Hash, max_move_size: usize, mover_share: &Amount) -> Result<(), Error> {
        todo!();
    }

    pub fn received_message(&mut self, allocator: &mut Allocator, game_id: &GameID, message: &ClvmObject) -> Result<ReadableUX, Error> {
        todo!();
    }

    pub fn send_potato_accept(&mut self, allocator: &mut Allocator, game_id: &GameID) -> (PotatoSignatures, Amount) {
        todo!();
    }

    pub fn received_potato_accept(&mut self, allocator: &mut Allocator, signautures: &PotatoSignatures, game_id: &GameID) -> Result<(), Error> {
        todo!();
    }

    pub fn send_potato_clean_shutdown(&self, allocator: &mut Allocator, conditions: &ClvmObject) -> TransactionBundle {
        todo!();
    }

    pub fn received_potato_clean_shutdown(&self, allocator: &mut Allocator, their_channel_half_signature: &Aggsig, conditions: &ClvmObject) -> Result<(), Error> {
        todo!();
    }

    pub fn get_unroll_spend(&self, allocator: &mut Allocator) -> TransactionBundle {
        todo!();
    }

    pub fn state_channel_spent(&self, allocator: &mut Allocator, condition: &ClvmObject) -> Result<SpentResult, Error> {
        todo!();
    }

    pub fn unroll_coin_spent<'a>(&'a self, allocator: &mut Allocator, conditions: &ClvmObject) -> Result<CoinSpentResult<'a>, Error> {
        todo!();
    }

    pub fn spend_reward_coins(&self, allocator: &mut Allocator, coins: &[CoinString], target_puzzle_hash: &PuzzleHash) -> SpendRewardResult {
        todo!();
    }
}

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
    pub fn new(allocator: &mut Allocator, amount: Amount, game_handler: Program, is_my_turn: bool, timeout: Timeout, validation_puzzle: Puzzle, validation_puzzle_hash: PuzzleHash, initial_state: ClvmObject, initial_move: &[u8], initial_move_max_size: usize, initial_mover_share: Amount, my_private_key: PrivateKey, their_puzzle_hash: PuzzleHash, nonce: usize) -> Self {
        todo!();
    }

    pub fn get_initial_puzzle_hash(&self) -> PuzzleHash {
        todo!();
    }

    pub fn my_turn_make_move(&mut self, allocator: &mut Allocator, readable_move: &ClvmObject) -> RefereeMakerMoveResult {
        todo!();
    }

    pub fn get_transaction_for_move(&mut self, allocator: &mut Allocator, coin_string: &CoinString) -> (TransactionBundle, CoinString) {
        todo!();
    }

    pub fn get_my_share(&self, allocator: &mut Allocator) -> Amount {
        todo!();
    }

    pub fn get_timeout_transaction(&self, allocator: &mut Allocator) -> (TransactionBundle, CoinString) {
        todo!();
    }

    pub fn their_turn_move_off_chain(&mut self, allocator: &mut Allocator, their_move: &[u8], validation_info_hash: &Hash, max_move_size: usize, mover_share: &Amount) -> TheirTurnMoveResult {
        todo!();
    }

    pub fn their_turn_coin_spent(&mut self, allocator: &mut Allocator, coin_string: &CoinString, conditions: &ClvmObject) -> Result<TheirTurnCoinSpentResult, Error> {
        todo!();
    }
}
