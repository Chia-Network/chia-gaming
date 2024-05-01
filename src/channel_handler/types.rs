use rand::prelude::*;
use rand::distributions::Standard;
use clvmr::allocator::{Allocator, NodePtr};
use clvm_traits::{ToClvm, clvm_curried_args};
use clvm_utils::CurriedProgram;

use crate::common::types::{Amount, CoinString, PrivateKey, PublicKey, Aggsig, GameID, RefereeID, Program, Puzzle, PuzzleHash, Error, GameHandler, Timeout, ClvmObject, Hash, CoinID, AllocEncoder, Sha256tree, IntoErr};
use crate::common::standard_coin::{private_to_public_key, puzzle_hash_for_pk, aggregate_public_keys, read_hex_puzzle, standard_solution_partial, unsafe_sign_partial};

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
    pub launcher_coin_id: CoinID,
    pub we_start_with_potato: bool,
    pub their_state_pubkey: PublicKey,
    pub their_unroll_pubkey: PublicKey,
    pub their_referee_puzzle_hash: PuzzleHash,
    pub my_contribution: Amount,
    pub their_contribution: Amount,
}

pub struct ChannelHandlerInitiationResult {
    pub channel_puzzle_hash_up: PuzzleHash,
    pub my_initial_channel_half_signature_peer: Aggsig
}

pub struct PotatoSignatures {
    // Half signed thing signing to the new state.
    my_channel_half_signature_peer: Aggsig,
    // Half signed thing allowing you to supercede an earlier state to this one.
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
///
/// Involves two puzzles:
/// 1) channel coin puzzle: vanilla 2 of 2 to the 2 sides' public keys
///
/// 2) unroll coin -- calculate based on current state
///   curried in:
///     shared puzzle hash
///       2 of 2 combining the unroll pubkeys of the 2 sides.
///         involves
///           take their unroll coin public key and our unroll public key from
///           our unroll private key and aggsig combine them for this 2 of 2 key.
///
/// this is a standard puzzle ala chia.wallet.puzzles that can be spent
/// with the above noted key and should be computed as such.
///
/// generated using DEFAULT_HIDDEN_PUZZLE_HASH and puzzle_for_pk as in
/// chia-blockchain.
///
/// old seq num
/// rotating all the time
/// default_conditions
///
///   args:
///     reveal
///     solution
///
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

    started_with_potato: bool,
    // Has a parity between the two players of whether have_potato means odd
    // or even, but odd-ness = have-potato is arbitrary.
    current_state_number: usize,
    // Increments per game started.
    next_nonce_number: usize,

    // Used in unrolling.
    last_channel_aggsig: Aggsig,
    last_unroll_aggsig: Aggsig,
    game_id_of_most_recent_move: Option<GameID>,
    game_id_of_most_recent_created_game: Option<GameID>,
    game_id_of_most_recent_accepted_game: Option<GameID>,
    referee_of_most_recent_accepted_game: Option<RefereeID>,
}

pub struct UnrollCoinSignatures {
    to_create_unroll_coin: Aggsig,
    to_spend_unroll_coin: Aggsig
}

pub fn read_unroll_metapuzzle(allocator: &mut Allocator) -> Result<Puzzle, Error> {
    read_hex_puzzle(allocator, "resources/unroll_meta_puzzle.hex")
}

pub fn read_unroll_puzzle(allocator: &mut Allocator) -> Result<Puzzle, Error> {
    read_hex_puzzle(allocator, "resources/state_channel_state_channel_unrolling.hex")
}

pub struct ChannelHandlerEnv<'a> {
    pub allocator: &'a mut Allocator,
    pub unroll_metapuzzle: Puzzle,
    pub unroll_puzzle: Puzzle,
}

impl<'a> ChannelHandlerEnv<'a> {
    fn new(allocator: &'a mut Allocator, unroll_metapuzzle: Puzzle, unroll_puzzle: Puzzle) -> ChannelHandlerEnv {
        ChannelHandlerEnv {
            allocator,
            unroll_metapuzzle,
            unroll_puzzle
        }
    }

    fn curried_unroll_puzzle(&mut self, old_seq_number: u64, default_conditions_hash: PuzzleHash) -> Result<Puzzle, Error> {
        let curried_program = CurriedProgram {
            program: self.unroll_puzzle.clone(),
            args: clvm_curried_args!(self.unroll_metapuzzle.clone(), old_seq_number, default_conditions_hash)
        };
        let nodeptr = curried_program.to_clvm(&mut AllocEncoder(self.allocator)).into_gen()?;
        Ok(Puzzle::from_nodeptr(nodeptr))
    }
}

impl ChannelHandler {
    pub fn new(
        private_keys: ChannelHandlerPrivateKeys
    ) -> Self {
        ChannelHandler {
            private_keys,
            .. ChannelHandler::default()
        }
    }

    pub fn construct_with_rng<R: Rng>(rng: &mut R) -> ChannelHandler {
        ChannelHandler::new(rng.gen())
    }

    /// Returns a list of create coin conditions which the unroll coin should do.
    /// We don't care about the parent coin id since we're not constraining it.
    ///
    /// The order is important and the first two coins' order are determined by
    /// whether the potato was ours first.
    pub fn get_state_channel_unroll_conditions(&self, env: &mut ChannelHandlerEnv, my_balance: &Amount, their_balance: &Amount, puzzle_hashes_and_amounts: &[(PuzzleHash, Amount)]) -> Result<ClvmObject, Error> {
        let their_first_coin = (51, (self.their_referee_puzzle_hash.clone(), (their_balance.clone(), ())));

        // Our ref is a standard puzzle whose public key is our ref pubkey.
        let ref_pubkey = private_to_public_key(&self.private_keys.my_referee_private_key)?;
        let standard_puzzle_hash_of_ref = puzzle_hash_for_pk(env.allocator, &ref_pubkey)?;

        let our_first_coin = (51 as u32, (standard_puzzle_hash_of_ref, (my_balance.clone(), ())));

        let (start_coin_one, start_coin_two) =
            if self.started_with_potato {
                (our_first_coin, their_first_coin)
            } else {
                (their_first_coin, our_first_coin)
            };

        let mut alloc_enc = AllocEncoder(env.allocator);
        let start_coin_one_clvm = start_coin_one.to_clvm(&mut alloc_enc).into_gen()?;
        let start_coin_two_clvm = start_coin_two.to_clvm(&mut alloc_enc).into_gen()?;
        let mut result_coins: Vec<ClvmObject> = vec![
            ClvmObject::from_nodeptr(start_coin_one_clvm),
            ClvmObject::from_nodeptr(start_coin_two_clvm),
        ];

        // Signatures for the unroll puzzle are always unsafe.
        // Signatures for the channel puzzle are always safe (std format).
        // Meta puzzle for the unroll can't be standard.
        for (ph, a) in puzzle_hashes_and_amounts.iter() {
            let clvm_conditions = (51, (ph.clone(), (a.clone(), ()))).to_clvm(&mut alloc_enc).into_gen()?;
            result_coins.push(ClvmObject::from_nodeptr(clvm_conditions));
        }

        Ok(ClvmObject::from_nodeptr((result_coins).to_clvm(&mut AllocEncoder(env.allocator)).into_gen()?))
    }

    pub fn create_conditions_and_signature_to_create_unroll_coin(&self, env: &mut ChannelHandlerEnv) -> Result<(ClvmObject, Aggsig), Error> {
        let amount_of_unroll_coin = self.my_out_of_game_balance.add(&self.their_out_of_game_balance.clone().into());
        let default_conditions = self.get_state_channel_unroll_conditions(env, &self.my_out_of_game_balance, &self.their_out_of_game_balance, &[])?;
        let default_conditions_hash = default_conditions.sha256tree(env.allocator);
        let unroll_coin_parent =
            if let Some(coin_string) = self.state_channel_coin_string.as_ref() {
                coin_string.to_coin_id()
            } else {
                return Err(Error::Channel("state_channel_unroll_signature called without having created state_channel_coin_string".to_string()));
            };
        let unroll_puzzle = env.curried_unroll_puzzle(0, default_conditions_hash)?;
        let unroll_puzzle_hash = unroll_puzzle.sha256tree(env.allocator);
        let create_conditions = vec![
            ClvmObject::from_nodeptr((51, (unroll_puzzle_hash.clone(), (amount_of_unroll_coin, ()))).to_clvm(&mut AllocEncoder(env.allocator)).into_gen()?)
        ];
        let create_conditions_obj = ClvmObject::from_nodeptr(create_conditions.to_clvm(&mut AllocEncoder(env.allocator)).into_gen()?);
        let channel_coin_public_key = private_to_public_key(&self.private_keys.my_channel_coin_private_key)?;
        let aggregated_key_for_unroll_create = aggregate_public_keys(&channel_coin_public_key, &self.their_channel_coin_public_key)?;
        standard_solution_partial(env.allocator, &self.private_keys.my_unroll_coin_private_key, &unroll_coin_parent, create_conditions_obj, &aggregated_key_for_unroll_create)
    }

    pub fn create_conditions_and_signature_to_spend_unroll_coin(&self, env: &mut ChannelHandlerEnv, conditions: &ClvmObject) -> Result<(ClvmObject, Aggsig), Error> {
        // Should make together two signatures.  One for the unroll coin and
        // one to spend the unroll coin.
        let unroll_private_key = &self.private_keys.my_unroll_coin_private_key;
        let default_conditions = self.get_state_channel_unroll_conditions(env, &self.my_out_of_game_balance, &self.their_out_of_game_balance, &[])?;
        let default_conditions_hash = default_conditions.sha256tree(env.allocator);
        let unroll_puzzle = env.curried_unroll_puzzle(0, default_conditions_hash.clone())?;
        let unroll_puzzle_hash = unroll_puzzle.sha256tree(env.allocator);
        let unroll_pubkey = private_to_public_key(&unroll_private_key)?;
        let aggregate_key_for_unroll_unsafe_sig = aggregate_public_keys(&unroll_pubkey, &self.their_unroll_coin_public_key)?;
        let to_spend_unroll_sig = unsafe_sign_partial(unroll_private_key, &aggregate_key_for_unroll_unsafe_sig, &default_conditions_hash.bytes());
        Ok((default_conditions, to_spend_unroll_sig))
    }

    pub fn state_channel_unroll_signature(&self, env: &mut ChannelHandlerEnv, conditions: &ClvmObject) -> Result<UnrollCoinSignatures, Error> {
        let (_, to_create_unroll_sig) = self.create_conditions_and_signature_to_create_unroll_coin(env)?;
        let (_, to_spend_unroll_sig) = self.create_conditions_and_signature_to_spend_unroll_coin(env, conditions)?;

        Ok(UnrollCoinSignatures {
            to_create_unroll_coin: to_create_unroll_sig,
            to_spend_unroll_coin: to_spend_unroll_sig
        })
    }

    pub fn initiate(&mut self, env: &mut ChannelHandlerEnv, initiation: &ChannelHandlerInitiationData) -> Result<ChannelHandlerInitiationResult, Error> {
        let our_channel_pubkey = private_to_public_key(&self.private_keys.my_channel_coin_private_key)?;
        let our_unroll_pubkey = private_to_public_key(&self.private_keys.my_unroll_coin_private_key)?;
        if initiation.their_state_pubkey == our_channel_pubkey {
            return Err(Error::Channel("Duplicated channel coin public key".to_string()));
        }

        if initiation.their_unroll_pubkey == our_unroll_pubkey {
            return Err(Error::Channel("Duplicated unroll coin public key".to_string()));
        }

        let combined_state_channel_pubkey = aggregate_public_keys(&our_channel_pubkey, &initiation.their_state_pubkey)?;
        let state_channel_coin_puzzle_hash = puzzle_hash_for_pk(env.allocator, &combined_state_channel_pubkey)?;
        let state_channel_coin_amt = initiation.my_contribution.add(&initiation.their_contribution);
        self.state_channel_coin_string = Some(CoinString::from_parts(&initiation.launcher_coin_id, &state_channel_coin_puzzle_hash, &state_channel_coin_amt));

        self.have_potato = initiation.we_start_with_potato;
        self.started_with_potato = self.have_potato;
        self.their_channel_coin_public_key = initiation.their_state_pubkey.clone();
        self.their_unroll_coin_public_key = initiation.their_unroll_pubkey.clone();
        self.their_referee_puzzle_hash = initiation.their_referee_puzzle_hash.clone();
        self.my_out_of_game_balance = initiation.my_contribution.clone();
        self.their_out_of_game_balance = initiation.their_contribution.clone();

        self.current_state_number = 1;
        self.next_nonce_number = 0;

        // XXX more member settings.

        // Unroll puzzle knows its sequence number and knows the hashes of the
        // things to exit in the two different ways (one is a hash of a list of
        // conditions, (default conditions hash), other is the shared puzzle hash.
        // Either the shared puzzle is revealed with a solution.
        //
        // After a timeout period, an opportunity exists to spend with the default
        // conditions.
        //
        // The shared puzzle hash passed into the state_channel puzzle
        // essentially an invocation of
        // state_channel.clinc::state_channel_unrolling
        // should be a standard puzzle with a aggsig parent condition.

        // Puzzle hash of a standard puzzle with a pubkey that combines our
        // channel private_key to pubkey and their channel pubkey.
        let combined_public_key = aggregate_public_keys(&our_channel_pubkey, &self.their_channel_coin_public_key)?;
        let shared_puzzle_hash = puzzle_hash_for_pk(env.allocator, &combined_public_key)?;

        // Signature signs the conditions.
        // Seems like the conditions are the DEFAULT_CONDITIONS of the state
        // channel unroll.

        // We need a spend of the channel coin to sign.
        // The seq number is zero.
        // There are no game coins and a balance for both sides.

        let default_conditions = self.get_state_channel_unroll_conditions(env, &self.my_out_of_game_balance, &self.their_out_of_game_balance, &[])?;
        let default_conditions_hash = default_conditions.sha256tree(env.allocator);
        let signature = self.private_keys.my_channel_coin_private_key.sign(&default_conditions_hash.bytes())?;

        Ok(ChannelHandlerInitiationResult {
            channel_puzzle_hash_up: shared_puzzle_hash,
            my_initial_channel_half_signature_peer: signature,
        })
    }

    pub fn finish_handshake(&mut self, _allocator: &mut Allocator, _their_initial_channel_hash_signature: &Aggsig) -> Result<(), Error> {
        todo!();
    }

    pub fn send_empty_potato(&mut self, _allocator: &mut Allocator) -> PotatoSignatures {
        todo!();
    }

    pub fn received_empty_potato(&mut self, _allocator: &mut Allocator, _signatures: &PotatoSignatures) -> Result<(), Error> {
        todo!();
    }

    pub fn send_potato_start_game(&mut self, _allocator: &mut Allocator, _my_contribution_this_game: Amount, _their_contribution_this_game: Amount, _start_info_list: &[GameStartInfo]) -> PotatoSignatures {
        todo!();
    }

    pub fn received_potato_start_game(&mut self, _allocator: &mut Allocator, _signatures: &PotatoSignatures, _start_info_list: &[GameStartInfo]) -> Result<(), Error> {
        todo!();
    }

    pub fn send_potato_move(&mut self, _allocator: &mut Allocator, _game_id: &GameID, _reable_move: &ReadableMove) -> MoveResult {
        todo!();
    }

    pub fn received_potato_move(&mut self, _allocator: &mut Allocator, _signatures: &PotatoSignatures, _game_id: &GameID, _their_move: &[u8], _validation_info_hash: &Hash, _max_move_size: usize, _mover_share: &Amount) -> Result<(), Error> {
        todo!();
    }

    pub fn received_message(&mut self, _allocator: &mut Allocator, _game_id: &GameID, _message: &ClvmObject) -> Result<ReadableUX, Error> {
        todo!();
    }

    pub fn send_potato_accept(&mut self, _allocator: &mut Allocator, _game_id: &GameID) -> (PotatoSignatures, Amount) {
        todo!();
    }

    pub fn received_potato_accept(&mut self, _allocator: &mut Allocator, _signautures: &PotatoSignatures, _game_id: &GameID) -> Result<(), Error> {
        todo!();
    }

    pub fn send_potato_clean_shutdown(&self, _allocator: &mut Allocator, _conditions: &ClvmObject) -> TransactionBundle {
        todo!();
    }

    pub fn received_potato_clean_shutdown(&self, __allocator: &mut Allocator, _their_channel_half_signature: &Aggsig, _conditions: &ClvmObject) -> Result<(), Error> {
        todo!();
    }

    pub fn get_unroll_spend(&self, _allocator: &mut Allocator) -> TransactionBundle {
        todo!();
    }

    pub fn state_channel_spent(&self, _allocator: &mut Allocator, _condition: &ClvmObject) -> Result<SpentResult, Error> {
        todo!();
    }

    pub fn unroll_coin_spent<'a>(&'a self, _allocator: &mut Allocator, _conditions: &ClvmObject) -> Result<CoinSpentResult<'a>, Error> {
        todo!();
    }

    pub fn spend_reward_coins(&self, _allocator: &mut Allocator, _coins: &[CoinString], _target_puzzle_hash: &PuzzleHash) -> SpendRewardResult {
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
