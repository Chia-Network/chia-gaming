pub mod game;
pub mod game_handler;
pub mod game_start_info;
pub mod runner;
pub mod types;

use std::cmp::Ordering;
use std::collections::HashMap;
use std::mem::swap;
use std::rc::Rc;

use rand::prelude::*;

use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;

use serde::{Deserialize, Serialize};

use crate::channel_handler::game_handler::TheirTurnResult;
use crate::channel_handler::types::{
    prepend_rem_conditions, AcceptTransactionState, CachedPotatoRegenerateLastHop,
    ChannelCoinSpendInfo, ChannelCoinSpentResult, ChannelHandlerEnv,
    ChannelHandlerInitiationResult, ChannelHandlerMoveResult, ChannelHandlerPrivateKeys,
    ChannelHandlerUnrollSpendInfo, CoinDataForReward, CoinSpentAccept, CoinSpentDisposition,
    CoinSpentInformation, CoinSpentMoveUp, CoinSpentResult, DispositionResult, GameStartFailed,
    GameStartInfoInterface, HandshakeResult, LiveGame, MoveResult, OnChainGameCoin,
    OnChainGameState, PotatoAcceptCachedData, PotatoMoveCachedData, PotatoSignatures, ReadableMove,
    StartGameResult, UnrollCoin, UnrollCoinConditionInputs, UnrollTarget,
};

use crate::common::constants::{CREATE_COIN, DEFAULT_HIDDEN_PUZZLE_HASH};
use crate::common::standard_coin::{
    calculate_synthetic_secret_key, private_to_public_key, puzzle_for_pk,
    puzzle_for_synthetic_public_key, puzzle_hash_for_pk, puzzle_hash_for_synthetic_public_key,
    standard_solution_partial, ChiaIdentity,
};
use crate::common::types::Sha256Input;
use crate::common::types::{
    usize_from_atom, Aggsig, AllocEncoder, Amount, BrokenOutCoinSpendInfo, CoinCondition, CoinID,
    CoinSpend, CoinString, Error, GameID, GetCoinStringParts, Hash, IntoErr, Node, PrivateKey,
    Program, PublicKey, Puzzle, PuzzleHash, Sha256tree, Spend, SpendBundle, SpendRewardResult,
    Timeout,
};
use crate::potato_handler::types::GameAction;
use crate::referee::types::{GameMoveDetails, RefereeOnChainTransaction, TheirTurnCoinSpentResult};
use crate::referee::{Referee, RefereeInterface};

/// A channel handler runs the game by facilitating the phases of game startup
/// and passing on move information as well as termination to other layers.
///
/// Involves two puzzles:
/// 1) channel coin puzzle: vanilla 2 of 2 to the 2 sides' public keys
///
/// 2) unroll coin -- calculate based on current state
///
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
/// Conditions that the uonrll coin makes needs a rem to ensure that we know
/// the latest game state number.
///
/// Needs to be a code path by which they took an old potato and put it on chain.
///
/// Brass tacks about turn polarity:
///
/// If we made a move and never got a reply, the latest thing that can be signed
/// onto the chain is the most recent 'their move'.  We preserve the ability to
/// recall and sign this move via timeout_unroll and timeout_stored_signatures
/// which are updated when we send a move.
#[derive(Serialize, Deserialize)]
pub struct ChannelHandler {
    private_keys: ChannelHandlerPrivateKeys,

    their_channel_coin_public_key: PublicKey,
    their_unroll_coin_public_key: PublicKey,
    their_referee_puzzle_hash: PuzzleHash,
    their_reward_puzzle_hash: PuzzleHash,
    reward_puzzle_hash: PuzzleHash,

    my_out_of_game_balance: Amount,
    their_out_of_game_balance: Amount,

    my_allocated_balance: Amount,
    their_allocated_balance: Amount,

    have_potato: bool,
    initiated_on_chain: bool,
    on_chain_for_error: bool,

    // Specifies the time lock that should be used in the unroll coin's conditions.
    unroll_advance_timeout: Timeout,

    cached_last_action: Option<CachedPotatoRegenerateLastHop>,

    // Has a parity between the two players of whether have_potato means odd
    // or even, but odd-ness = have-potato is arbitrary.
    current_state_number: usize, //
    // Increments per game started.
    next_nonce_number: usize,

    state_channel: CoinSpend,

    // If current unroll is not populated, the previous unroll contains the
    // info needed to unroll to the previous state on which we can replay our
    // most recent move.
    unroll: ChannelHandlerUnrollSpendInfo,
    timeout: Option<ChannelHandlerUnrollSpendInfo>,

    // Maps state_number → timeout_conditions_hash (DEFAULT_HASH) for each
    // exchange we've participated in.  Needed to reconstruct the unroll coin
    // puzzle for preemption when the on-chain state is from an older exchange.
    state_conditions_hashes: HashMap<usize, PuzzleHash>,

    // Live games
    live_games: Vec<LiveGame>,

    // Games removed by send_potato_accept / received_potato_accept that
    // haven't been confirmed by a full potato round-trip yet.  Kept so
    // set_state_for_coins and accept_or_timeout_game_on_chain can find them
    // if the channel goes on-chain before the round-trip completes.
    pending_accept_games: Vec<LiveGame>,
}

pub trait EnvDataForReferee {
    fn allocator(&mut self) -> &mut AllocEncoder;
    fn referee_puzzle(&self) -> Puzzle;
    fn referee_puzzle_hash(&self) -> PuzzleHash;
    fn agg_sig_me_additional_data(&self) -> Hash;
}

impl<'a, R: Rng> EnvDataForReferee for ChannelHandlerEnv<'a, R> {
    fn allocator(&mut self) -> &mut AllocEncoder {
        self.allocator
    }
    fn referee_puzzle(&self) -> Puzzle {
        self.referee_coin_puzzle.clone()
    }
    fn referee_puzzle_hash(&self) -> PuzzleHash {
        self.referee_coin_puzzle_hash.clone()
    }
    fn agg_sig_me_additional_data(&self) -> Hash {
        self.agg_sig_me_additional_data.clone()
    }
}

impl ChannelHandler {
    pub fn is_initial_potato(&self) -> bool {
        self.unroll.coin.started_with_potato
    }

    pub fn channel_private_key(&self) -> PrivateKey {
        self.private_keys.my_channel_coin_private_key.clone()
    }

    pub fn unroll_private_key(&self) -> PrivateKey {
        self.private_keys.my_unroll_coin_private_key.clone()
    }

    pub fn referee_private_key(&self) -> PrivateKey {
        self.private_keys.my_referee_private_key.clone()
    }

    pub fn initiated_on_chain(&self) -> bool {
        self.initiated_on_chain
    }

    pub fn set_initiated_on_chain(&mut self) {
        self.initiated_on_chain = true;
    }

    pub fn on_chain_for_error(&self) -> bool {
        self.on_chain_for_error
    }

    pub fn set_on_chain_for_error(&mut self) {
        self.on_chain_for_error = true;
    }

    pub fn get_state_number(&self) -> usize {
        self.current_state_number
    }

    /// Corrupt the channel handler's view of state for testing unrecoverable
    /// unroll edge cases.  Sets `current_state_number` to `new_sn`, changes
    /// `unroll.coin.state_number` to match, and clears `timeout` so that
    /// `get_unroll_for_state` won't find the real on-chain state.
    #[cfg(feature = "sim-tests")]
    pub fn corrupt_state_for_testing(&mut self, new_sn: usize) {
        self.current_state_number = new_sn;
        self.unroll.coin.state_number = new_sn;
        self.unroll.signatures = Default::default();
        self.timeout = None;
    }

    pub fn all_games_finished(&self) -> bool {
        self.live_games.is_empty()
    }

    pub fn live_game_ids(&self) -> Vec<GameID> {
        self.live_games.iter().map(|g| g.game_id.clone()).collect()
    }

    pub fn amount(&self, on_chain: bool) -> Amount {
        let allocated = self.my_allocated_balance.clone() + self.their_allocated_balance.clone();

        if on_chain {
            return allocated;
        }

        allocated + self.my_out_of_game_balance.clone() + self.their_out_of_game_balance.clone()
    }

    pub fn get_our_current_share(&self) -> Amount {
        self.my_out_of_game_balance.clone()
    }

    pub fn get_their_current_share(&self) -> Amount {
        self.their_out_of_game_balance.clone()
    }

    pub fn get_cached_game_id(&self) -> Option<&GameID> {
        if let Some(CachedPotatoRegenerateLastHop::PotatoAccept(acc)) = &self.cached_last_action {
            return Some(&acc.game_id);
        }

        None
    }

    pub fn clear_cached_game_id_for_send(&mut self) {
        if let Some(game_id) = self.get_cached_game_id() {
            if let Ok(idx) = self.get_game_by_id(game_id) {
                self.live_games.remove(idx);
            }
        }
    }

    pub fn get_reward_puzzle_hash<R: Rng>(
        &self,
        _env: &mut ChannelHandlerEnv<R>,
    ) -> Result<PuzzleHash, Error> {
        Ok(self.reward_puzzle_hash.clone())
    }

    pub fn get_opponent_reward_puzzle_hash(&self) -> PuzzleHash {
        self.their_reward_puzzle_hash.clone()
    }

    pub fn get_finished_unroll_coin(&self) -> &ChannelHandlerUnrollSpendInfo {
        if let Some(t) = self.timeout.as_ref() {
            t
        } else {
            &self.unroll
        }
    }

    pub fn get_unroll_coin(&self) -> &ChannelHandlerUnrollSpendInfo {
        &self.unroll
    }

    /// Return whichever stored UnrollCoin matches the given on-chain state
    /// number.  Checks `self.timeout` first, then `self.unroll`.
    pub fn get_unroll_for_state(&self, state_number: usize) -> Result<&ChannelHandlerUnrollSpendInfo, Error> {
        if let Some(t) = self.timeout.as_ref() {
            if t.coin.state_number == state_number {
                return Ok(t);
            }
        }
        if self.unroll.coin.state_number == state_number {
            return Ok(&self.unroll);
        }
        Err(Error::StrErr(format!(
            "No stored unroll matches on-chain state {state_number} (unroll={}, timeout={:?})",
            self.unroll.coin.state_number,
            self.timeout.as_ref().map(|t| t.coin.state_number),
        )))
    }

    fn make_curried_unroll_puzzle<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
    ) -> Result<NodePtr, Error> {
        self.unroll
            .coin
            .make_curried_unroll_puzzle(env, &self.get_aggregate_unroll_public_key())
    }

    fn unroll_coin_condition_inputs(
        &self,
        my_balance: Amount,
        their_balance: Amount,
        puzzle_hashes_and_amounts: &[(PuzzleHash, Amount)],
    ) -> UnrollCoinConditionInputs {
        let my_referee_public_key =
            private_to_public_key(&self.private_keys.my_referee_private_key);
        let inputs = UnrollCoinConditionInputs {
            ref_pubkey: my_referee_public_key,
            their_referee_puzzle_hash: self.their_referee_puzzle_hash.clone(),
            my_balance,
            their_balance,
            puzzle_hashes_and_amounts: puzzle_hashes_and_amounts.to_vec(),
            rem_condition_state: self.current_state_number,
            unroll_timeout: self.unroll_advance_timeout.to_u64(),
        };
        inputs
    }

    pub fn state_channel_coin(&self) -> &CoinString {
        &self.state_channel.coin
    }

    /// Return the right public key to use for a clean shutdown.
    pub fn clean_shutdown_public_key(&self) -> PublicKey {
        private_to_public_key(&self.private_keys.my_channel_coin_private_key)
    }

    /// Return the right amount to use for a clean shutdown coin output.
    pub fn clean_shutdown_amount(&self) -> Amount {
        self.my_out_of_game_balance.clone()
    }

    fn get_just_created_games(&self) -> Vec<GameID> {
        if let Some(CachedPotatoRegenerateLastHop::PotatoCreatedGame(games, _, _)) =
            &self.cached_last_action
        {
            games.clone()
        } else {
            vec![]
        }
    }

    /// Returns true if there are active games that weren't just created in the
    /// most recent potato exchange (and thus can't be cancelled for shutdown).
    pub fn has_games_beyond_just_created(&self) -> bool {
        let just_created = self.get_just_created_games();
        self.live_games
            .iter()
            .any(|g| !just_created.contains(&g.game_id))
    }

    /// Cancel games that were just created (in the most recent potato) by
    /// restoring their contributions to the out-of-game balances and removing
    /// them from live_games.  Used before clean shutdown when the only active
    /// games are ones we just initiated.
    pub fn cancel_just_created_games(&mut self) {
        let just_created = self.get_just_created_games();
        if just_created.is_empty() {
            return;
        }
        for game in self.live_games.iter() {
            if just_created.contains(&game.game_id) {
                self.my_out_of_game_balance += game.my_contribution.clone();
                self.their_out_of_game_balance += game.their_contribution.clone();
                self.my_allocated_balance =
                    self.my_allocated_balance.clone() - game.my_contribution.clone();
                self.their_allocated_balance =
                    self.their_allocated_balance.clone() - game.their_contribution.clone();
            }
        }
        self.live_games
            .retain(|g| !just_created.contains(&g.game_id));
        self.cached_last_action = None;
    }

    pub fn create_conditions_and_signature_of_channel_coin<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        unroll_coin: &UnrollCoin,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        let unroll_coin_parent = self.state_channel_coin();
        self.get_solution_and_signature(
            &unroll_coin_parent.to_coin_id(),
            env,
            &self.private_keys.my_channel_coin_private_key,
            &self.get_aggregate_channel_public_key(),
            &self.get_aggregate_unroll_public_key(),
            &self
                .state_channel
                .coin
                .amount()
                .expect("state channel coin has no amount"),
            unroll_coin,
        )
    }

    /// Construct a SpendBundle that spends the channel coin to create the
    /// unroll coin, using the latest agreed-upon state.  Combines our
    /// half-signature with the peer's half-signature from the most recent
    /// potato exchange.
    pub fn get_channel_coin_spend_to_unroll_bundle<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
    ) -> Result<SpendBundle, Error> {
        let finished_unroll = self.get_finished_unroll_coin();
        let channel_coin_spend =
            self.create_conditions_and_signature_of_channel_coin(env, &finished_unroll.coin)?;
        let aggregate_signature = channel_coin_spend.signature.clone()
            + finished_unroll
                .signatures
                .my_channel_half_signature_peer
                .clone();

        Ok(SpendBundle {
            name: Some("spend channel to unroll".to_string()),
            spends: vec![CoinSpend {
                coin: self.state_channel.coin.clone(),
                bundle: Spend {
                    puzzle: self.state_channel.bundle.puzzle.clone(),
                    solution: channel_coin_spend.solution.p().into(),
                    signature: aggregate_signature,
                },
            }],
        })
    }

    /// Compute the CoinString of the unroll coin that will be created when
    /// the channel coin is spent with the current state.
    pub fn compute_expected_unroll_coin<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
    ) -> Result<CoinString, Error> {
        let finished_unroll = self.get_finished_unroll_coin();
        let curried_unroll_puzzle = finished_unroll
            .coin
            .make_curried_unroll_puzzle(env, &self.get_aggregate_unroll_public_key())?;
        let unroll_puzzle_hash = Node(curried_unroll_puzzle).sha256tree(env.allocator);
        let amount = self
            .state_channel
            .coin
            .amount()
            .expect("state channel coin has no amount");
        Ok(CoinString::from_parts(
            &self.state_channel.coin.to_coin_id(),
            &unroll_puzzle_hash,
            &amount,
        ))
    }

    pub fn get_aggregate_unroll_public_key(&self) -> PublicKey {
        let public_key = private_to_public_key(&self.private_keys.my_unroll_coin_private_key);
        public_key + self.their_unroll_coin_public_key.clone()
    }

    pub fn get_aggregate_channel_public_key(&self) -> PublicKey {
        let public_key = private_to_public_key(&self.private_keys.my_channel_coin_private_key);
        public_key + self.their_channel_coin_public_key.clone()
    }

    pub fn new<R: Rng>(
        env: &mut ChannelHandlerEnv<R>,
        private_keys: ChannelHandlerPrivateKeys,
        launcher_coin_id: CoinID,
        we_start_with_potato: bool,
        their_channel_pubkey: PublicKey,
        their_unroll_pubkey: PublicKey,
        their_referee_puzzle_hash: PuzzleHash,
        their_reward_puzzle_hash: PuzzleHash,
        my_contribution: Amount,
        their_contribution: Amount,
        unroll_advance_timeout: Timeout,
        reward_puzzle_hash: PuzzleHash,
    ) -> Result<(Self, ChannelHandlerInitiationResult), Error> {
        let our_channel_pubkey = private_to_public_key(&private_keys.my_channel_coin_private_key);
        let our_unroll_pubkey = private_to_public_key(&private_keys.my_unroll_coin_private_key);
        if their_channel_pubkey == our_channel_pubkey {
            return Err(Error::Channel(
                "Duplicated channel coin public key".to_string(),
            ));
        }

        if their_unroll_pubkey == our_unroll_pubkey {
            return Err(Error::Channel(
                "Duplicated unroll coin public key".to_string(),
            ));
        }

        let aggregate_public_key = our_channel_pubkey.clone() + their_channel_pubkey.clone();

        let state_channel_coin_puzzle_hash =
            puzzle_hash_for_synthetic_public_key(env.allocator, &aggregate_public_key)?;
        let amount = my_contribution.clone() + their_contribution.clone();
        let channel_coin_parent =
            CoinString::from_parts(&launcher_coin_id, &state_channel_coin_puzzle_hash, &amount);

        let mut myself = ChannelHandler {
            their_channel_coin_public_key: their_channel_pubkey.clone(),
            their_unroll_coin_public_key: their_unroll_pubkey.clone(),
            their_referee_puzzle_hash: their_referee_puzzle_hash.clone(),
            their_reward_puzzle_hash: their_reward_puzzle_hash.clone(),
            my_out_of_game_balance: my_contribution.clone(),
            their_out_of_game_balance: their_contribution.clone(),
            unroll_advance_timeout: unroll_advance_timeout.clone(),
            reward_puzzle_hash: reward_puzzle_hash.clone(),

            my_allocated_balance: Amount::default(),
            their_allocated_balance: Amount::default(),

            have_potato: we_start_with_potato,
            initiated_on_chain: false,
            on_chain_for_error: false,

            cached_last_action: None,

            current_state_number: 0,
            next_nonce_number: 0,

            state_channel: CoinSpend {
                coin: channel_coin_parent,
                bundle: Spend::default(),
            },

            unroll: ChannelHandlerUnrollSpendInfo::default(),
            timeout: None,

            state_conditions_hashes: HashMap::new(),

            live_games: Vec::new(),
            pending_accept_games: Vec::new(),

            private_keys,
        };

        myself.unroll.coin.state_number = myself.current_state_number;
        myself.unroll.coin.started_with_potato = myself.have_potato;

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

        // We need a spend of the channel coin to sign.
        // The seq number is zero.
        // There are no game coins and a balance for both sides.
        let inputs = myself.unroll_coin_condition_inputs(
            myself.my_out_of_game_balance.clone(),
            myself.their_out_of_game_balance.clone(),
            &[],
        );
        myself.unroll.coin.update(
            env,
            &myself.private_keys.my_unroll_coin_private_key,
            &myself.their_unroll_coin_public_key,
            // XXX might need to mutate slightly.
            &inputs,
        )?;
        if let Some(ref outcome) = myself.unroll.coin.outcome {
            myself
                .state_conditions_hashes
                .insert(outcome.state_number, outcome.hash.clone());
        }
        myself.current_state_number += 1;

        let channel_coin_spend =
            myself.create_conditions_and_signature_of_channel_coin(env, &myself.unroll.coin)?;

        myself.state_channel.bundle = Spend {
            puzzle: puzzle_for_synthetic_public_key(
                env.allocator,
                &env.standard_puzzle,
                &aggregate_public_key,
            )?,
            solution: channel_coin_spend.solution.clone(),
            signature: channel_coin_spend.signature.clone(),
        };

        Ok((
            myself,
            ChannelHandlerInitiationResult {
                channel_puzzle_hash_up: state_channel_coin_puzzle_hash,
                my_initial_channel_half_signature_peer: channel_coin_spend.signature,
            },
        ))
    }

    pub fn finish_handshake<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        their_initial_channel_half_signature: &Aggsig,
    ) -> Result<HandshakeResult, Error> {
        let aggregate_public_key = self.get_aggregate_channel_public_key();

        let channel_coin_spend =
            self.create_conditions_and_signature_of_channel_coin(env, &self.unroll.coin)?;

        let combined_signature =
            channel_coin_spend.signature.clone() + their_initial_channel_half_signature.clone();

        let state_channel_puzzle = puzzle_for_synthetic_public_key(
            env.allocator,
            &env.standard_puzzle,
            &aggregate_public_key,
        )?;

        Ok(HandshakeResult {
            channel_puzzle_reveal: state_channel_puzzle,
            amount: self
                .state_channel
                .coin
                .amount()
                .expect("state channel coin has no amount")
                .clone(),
            spend: ChannelCoinSpendInfo {
                aggsig: combined_signature,
                solution: channel_coin_spend.solution.p(),
                conditions: channel_coin_spend.conditions.p(),
            },
        })
    }

    fn compute_game_coin_unroll_data(
        &self,
        unroll_coin: Option<&CoinID>,
        skip_game: &[GameID],
        skip_coin_id: Option<&GameID>,
        games: &[LiveGame],
    ) -> Result<Vec<OnChainGameCoin>, Error> {
        // It's ok to not have a proper coin id here when we only want
        // the puzzle hashes and amounts.
        let parent_coin_id = unroll_coin.cloned().unwrap_or_default();

        let mut result = Vec::new();
        for game in games
            .iter()
            .filter(|game| !skip_game.contains(&game.game_id))
        {
            let coin = if skip_coin_id == Some(&game.game_id) {
                None
            } else {
                Some(CoinString::from_parts(
                    &parent_coin_id,
                    &game.last_referee_puzzle_hash,
                    &game.get_amount(),
                ))
            };

            result.push(OnChainGameCoin {
                game_id_up: game.game_id.clone(),
                coin_string_up: coin,
            });
        }

        Ok(result)
    }

    pub fn compute_unroll_data_for_games(
        &self,
        skip_game: &[GameID],
        skip_coin_id: Option<&GameID>,
        games: &[LiveGame],
    ) -> Result<Vec<(PuzzleHash, Amount)>, Error> {
        Ok(self
            .compute_game_coin_unroll_data(None, skip_game, skip_coin_id, games)?
            .iter()
            .filter_map(|ngc| ngc.coin_string_up.as_ref().and_then(|c| c.to_parts()))
            .map(|(_, puzzle_hash, amount)| (puzzle_hash, amount))
            .collect())
    }

    pub fn update_cached_unroll_state<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
    ) -> Result<PotatoSignatures, Error> {
        let new_game_coins_on_chain: Vec<(PuzzleHash, Amount)> =
            self.compute_unroll_data_for_games(&[], None, &self.live_games)?;

        let unroll_inputs = self.unroll_coin_condition_inputs(
            self.my_out_of_game_balance.clone(),
            self.their_out_of_game_balance.clone(),
            &new_game_coins_on_chain,
        );

        self.current_state_number += 1;
        self.unroll.coin.state_number = self.current_state_number;

        // Now update our unroll state.
        self.unroll.coin.update(
            env,
            &self.private_keys.my_unroll_coin_private_key,
            &self.their_unroll_coin_public_key,
            &unroll_inputs,
        )?;
        if let Some(ref outcome) = self.unroll.coin.outcome {
            self.state_conditions_hashes
                .insert(outcome.state_number, outcome.hash.clone());
        }
        self.unroll.signatures = Default::default();
        self.have_potato = false;

        let channel_coin_spend =
            self.create_conditions_and_signature_of_channel_coin(env, &self.unroll.coin)?;

        Ok(PotatoSignatures {
            my_channel_half_signature_peer: channel_coin_spend.signature,
            my_unroll_half_signature_peer: self.unroll.coin.get_unroll_coin_signature()?,
        })
    }

    pub fn send_empty_potato<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
    ) -> Result<PotatoSignatures, Error> {
        // We let them spend a state number 1 higher but nothing else changes.
        self.update_cache_for_potato_send(None);

        self.update_cached_unroll_state(env)
    }

    pub fn verify_channel_coin_from_peer_signatures<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        their_channel_half_signature: &Aggsig,
        conditions: Rc<Program>,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        let aggregate_public_key = self.get_aggregate_channel_public_key();
        let spend = self.state_channel.coin.clone();
        let channel_coin_spend = self.get_solution_and_signature_from_conditions(
            &spend.to_coin_id(),
            env,
            &self.private_keys.my_channel_coin_private_key,
            &aggregate_public_key,
            conditions,
        )?;

        let full_signature =
            channel_coin_spend.signature.clone() + their_channel_half_signature.clone();
        if full_signature.verify(&aggregate_public_key, &channel_coin_spend.message) {
            Ok(BrokenOutCoinSpendInfo {
                signature: full_signature,
                ..channel_coin_spend
            })
        } else {
            Err(Error::StrErr("failed to verify signature".to_string()))
        }
    }

    pub fn received_potato_verify_signatures<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        signatures: &PotatoSignatures,
        inputs: &UnrollCoinConditionInputs,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        // The potato just arrived, so any prior pending accepts are now
        // confirmed by the round-trip.
        self.pending_accept_games.clear();

        // Unroll coin section.
        let mut test_unroll = self.unroll.coin.clone();
        test_unroll.state_number = self.current_state_number + 1;
        test_unroll.update(
            env,
            &self.private_keys.my_unroll_coin_private_key,
            &self.their_unroll_coin_public_key,
            inputs,
        )?;

        if !test_unroll.verify(
            env,
            &self.get_aggregate_unroll_public_key(),
            &signatures.my_unroll_half_signature_peer,
        )? {
            return Err(Error::StrErr("bad unroll signature verify".to_string()));
        }

        // State coin section
        let channel_coin_spend =
            self.create_conditions_and_signature_of_channel_coin(env, &test_unroll)?;
        self.verify_channel_coin_from_peer_signatures(
            env,
            &signatures.my_channel_half_signature_peer,
            channel_coin_spend.conditions.p(),
        )?;

        // If state number is 0 and we're receiving the potato, then we don't
        // verify, we do finish_handshake instead.
        if self.current_state_number == 0 {
            self.finish_handshake(env, &signatures.my_channel_half_signature_peer)?;
        }

        self.current_state_number += 1;
        if let Some(ref outcome) = test_unroll.outcome {
            self.state_conditions_hashes
                .insert(outcome.state_number, outcome.hash.clone());
        }
        self.timeout = Some(ChannelHandlerUnrollSpendInfo {
            coin: test_unroll.clone(),
            signatures: signatures.clone(),
        });

        self.have_potato = true;

        Ok(BrokenOutCoinSpendInfo {
            signature: channel_coin_spend.signature.clone()
                + signatures.my_channel_half_signature_peer.clone(),
            ..channel_coin_spend
        })
    }

    pub fn received_empty_potato<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        signatures: &PotatoSignatures,
    ) -> Result<ChannelCoinSpendInfo, Error> {
        let unroll_data = self.compute_unroll_data_for_games(&[], None, &self.live_games)?;

        let spend = self.received_potato_verify_signatures(
            env,
            signatures,
            &self.unroll_coin_condition_inputs(
                self.my_out_of_game_balance.clone(),
                self.their_out_of_game_balance.clone(),
                &unroll_data,
            ),
        )?;

        self.cached_last_action = None;

        Ok(ChannelCoinSpendInfo {
            aggsig: spend.signature,
            solution: spend.solution.p(),
            conditions: spend.conditions.p(),
        })
    }

    pub fn add_games<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        start_info_list: &[Rc<dyn GameStartInfoInterface>],
    ) -> Result<Vec<LiveGame>, Error> {
        let mut res = Vec::new();
        for g in start_info_list.iter() {
            let new_game_nonce = self.next_nonce_number;
            self.next_nonce_number += 1;

            let referee_identity = ChiaIdentity::new(
                env.allocator,
                self.private_keys.my_referee_private_key.clone(),
            )?;
            let ref_puzzle = env.referee_coin_puzzle.clone();
            let ref_ph = env.referee_coin_puzzle_hash.clone();
            let agg_sig_me = env.agg_sig_me_additional_data.clone();
            let (r, ph) = Referee::new(
                env.allocator,
                ref_puzzle,
                ref_ph,
                g,
                referee_identity,
                &self.their_referee_puzzle_hash,
                &self.reward_puzzle_hash,
                new_game_nonce,
                &agg_sig_me,
                self.current_state_number,
            )?;
            res.push(LiveGame::new(
                g.game_id().clone(),
                ph,
                Rc::new(r),
                g.my_contribution_this_game().clone(),
                g.their_contribution_this_game().clone(),
            ));
        }

        Ok(res)
    }

    fn start_game_contributions(
        &mut self,
        start_info_list: &[Rc<dyn GameStartInfoInterface>],
    ) -> (Amount, Amount) {
        let mut my_full_contribution = Amount::default();
        let mut their_full_contribution = Amount::default();

        for start in start_info_list.iter() {
            my_full_contribution += start.my_contribution_this_game().clone();
            their_full_contribution += start.their_contribution_this_game().clone();
        }

        (my_full_contribution, their_full_contribution)
    }

    pub fn send_potato_start_game<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        start_info_list: &[Rc<dyn GameStartInfoInterface>],
    ) -> Result<StartGameResult, Error> {
        let (my_full_contribution, their_full_contribution) =
            self.start_game_contributions(start_info_list);

        if my_full_contribution.clone() > self.my_out_of_game_balance
            || their_full_contribution.clone() > self.their_out_of_game_balance
        {
            return Ok(StartGameResult::Failure(GameStartFailed::OutOfMoney));
        }

        self.clear_cached_game_id_for_send();
        self.my_allocated_balance += my_full_contribution.clone();
        self.their_allocated_balance += their_full_contribution.clone();
        self.my_out_of_game_balance -= my_full_contribution.clone();
        self.their_out_of_game_balance -= their_full_contribution.clone();

        // We let them spend a state number 1 higher but nothing else changes.
        self.update_cache_for_potato_send(Some(CachedPotatoRegenerateLastHop::PotatoCreatedGame(
            start_info_list
                .iter()
                .map(|g| g.game_id().clone())
                .collect(),
            my_full_contribution,
            their_full_contribution,
        )));

        let mut new_games = self.add_games(env, start_info_list)?;
        self.live_games.append(&mut new_games);

        Ok(StartGameResult::Success(Box::new(
            self.update_cached_unroll_state(env)?,
        )))
    }

    pub fn received_potato_start_game<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        signatures: &PotatoSignatures,
        start_info_list: &[Rc<dyn GameStartInfoInterface>],
    ) -> Result<(Vec<GameID>, ChannelCoinSpendInfo), Error> {
        let mut new_games = self.add_games(env, start_info_list)?;
        let result_game_ids: Vec<GameID> = new_games.iter().map(|g| &g.game_id).cloned().collect();

        let (my_full_contribution, their_full_contribution) =
            self.start_game_contributions(start_info_list);

        if my_full_contribution.clone() > self.my_out_of_game_balance
            || their_full_contribution.clone() > self.their_out_of_game_balance
        {
            return Err(Error::StrErr("out of money".to_string()));
        }

        self.my_allocated_balance += my_full_contribution.clone();
        self.their_allocated_balance += their_full_contribution.clone();
        self.my_out_of_game_balance -= my_full_contribution.clone();
        self.their_out_of_game_balance -= their_full_contribution.clone();

        // Make a list of all game outputs in order.
        let cached_game_ids = self
            .get_cached_game_id()
            .map(|g| vec![g.clone()])
            .unwrap_or_default();
        let mut unroll_data_for_all_games =
            self.compute_unroll_data_for_games(&cached_game_ids, None, &self.live_games)?;
        unroll_data_for_all_games.append(&mut self.compute_unroll_data_for_games(
            &[],
            None,
            &new_games,
        )?);

        // Update an unroll coin to see if we can verify the message.
        let spend = self.received_potato_verify_signatures(
            env,
            signatures,
            &self.unroll_coin_condition_inputs(
                self.my_out_of_game_balance.clone(),
                self.their_out_of_game_balance.clone(),
                &unroll_data_for_all_games,
            ),
        )?;
        self.live_games.append(&mut new_games);

        Ok((
            result_game_ids,
            ChannelCoinSpendInfo {
                aggsig: spend.signature,
                solution: spend.solution.p(),
                conditions: spend.conditions.p(),
            },
        ))
    }

    pub fn get_game_by_id(&self, game_id: &GameID) -> Result<usize, Error> {
        self.live_games
            .iter()
            .position(|g| &g.game_id == game_id)
            .map(Ok)
            .unwrap_or_else(|| {
                Err(Error::StrErr(
                    "send potato move for nonexistent game id".to_string(),
                ))
            })
    }

    pub fn send_potato_move<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        game_id: &GameID,
        readable_move: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<MoveResult, Error> {
        let game_idx = self.get_game_by_id(game_id)?;

        let referee_result = self.live_games[game_idx].internal_make_move(
            env.allocator,
            readable_move,
            new_entropy.clone(),
            self.current_state_number,
        )?;

        let match_puzzle_hash = referee_result.puzzle_hash_for_unroll.clone();

        let _ = self.live_games[game_idx].get_transaction_for_move(
            env.allocator,
            &CoinString::from_parts(
                &CoinID::default(),
                &PuzzleHash::default(),
                &Amount::default(),
            ),
            false,
        );

        self.live_games[game_idx].last_referee_puzzle_hash =
            self.live_games[game_idx].outcome_puzzle_hash(env.allocator)?;

        // Referee is now at S' (post-move). Save it for potential redo after unroll.
        let (saved_referee, saved_ph) = self.live_games[game_idx].save_referee_state();

        let puzzle_hash = referee_result.puzzle_hash_for_unroll;
        let amount = referee_result.details.basic.mover_share.clone();

        // We let them spend a state number 1 higher but nothing else changes.
        self.update_cache_for_potato_send(Some(
            CachedPotatoRegenerateLastHop::PotatoMoveHappening(Rc::new(PotatoMoveCachedData {
                state_number: self.current_state_number,
                game_id: game_id.clone(),
                match_puzzle_hash,
                puzzle_hash,
                amount,
                saved_post_move_referee: Some(saved_referee),
                saved_post_move_last_ph: Some(saved_ph),
            })),
        ));

        //self.live_games[game_idx]
        let signatures = self.update_cached_unroll_state(env)?;

        Ok(MoveResult {
            signatures,
            state_number: self.current_state_number,
            game_move: referee_result.details.clone(),
        })
    }

    pub fn received_potato_move<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        game_id: &GameID,
        move_result: &MoveResult,
    ) -> Result<ChannelHandlerMoveResult, Error> {
        let game_idx = self.get_game_by_id(game_id)?;

        // Save referee state so we can restore it if anything goes wrong
        // (slash detection or signature verification failure).
        let (saved_referee, saved_last_ph) = self.live_games[game_idx].save_referee_state();

        let coin_string = self.state_channel.coin.clone();
        let their_move_result = match self.live_games[game_idx].internal_their_move(
            env.allocator,
            &move_result.game_move,
            self.current_state_number,
            Some(&coin_string),
        ) {
            Ok(r) => r,
            Err(e) => {
                self.live_games[game_idx].restore_referee_state(saved_referee, saved_last_ph);
                return Err(e);
            }
        };

        let (readable_move, message, mover_share) = match their_move_result.original {
            TheirTurnResult::FinalMove(move_data) => (
                move_data.readable_move,
                vec![],
                move_data.mover_share.clone(),
            ),
            TheirTurnResult::MakeMove(_, message, move_data) => (
                move_data.readable_move,
                message.clone(),
                move_data.mover_share.clone(),
            ),
            TheirTurnResult::Slash(_) => {
                self.live_games[game_idx].restore_referee_state(saved_referee, saved_last_ph);
                return Err(Error::StrErr(
                    "slash when off chain: go on chain".to_string(),
                ));
            }
        };

        let unroll_data = self.compute_unroll_data_for_games(&[], None, &self.live_games)?;

        let spend = match self.received_potato_verify_signatures(
            env,
            &move_result.signatures,
            &self.unroll_coin_condition_inputs(
                self.my_out_of_game_balance.clone(),
                self.their_out_of_game_balance.clone(),
                &unroll_data,
            ),
        ) {
            Ok(s) => s,
            Err(e) => {
                self.live_games[game_idx].restore_referee_state(saved_referee, saved_last_ph);
                return Err(e);
            }
        };

        self.cached_last_action = None;

        Ok(ChannelHandlerMoveResult {
            spend_info: ChannelCoinSpendInfo {
                aggsig: spend.signature,
                solution: spend.solution.p(),
                conditions: spend.conditions.p(),
            },
            readable_their_move: readable_move.p(),
            state_number: self.current_state_number,
            message,
            mover_share,
        })
    }

    pub fn received_message<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        game_id: &GameID,
        message: &[u8],
    ) -> Result<ReadableMove, Error> {
        let game_idx = self.get_game_by_id(game_id)?;

        self.live_games[game_idx].receive_readable(env.allocator, message)
    }

    pub fn send_potato_accept<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        game_id: &GameID,
    ) -> Result<(PotatoSignatures, Amount), Error> {
        assert!(self.have_potato);
        let game_idx = self.get_game_by_id(game_id)?;

        let live_game = self.live_games.remove(game_idx);
        self.my_allocated_balance -= live_game.my_contribution.clone();
        self.their_allocated_balance -= live_game.their_contribution.clone();

        let amount = live_game.get_our_current_share();
        let at_stake = live_game.get_amount();

        // Keep a copy of the referee so set_state_for_coins and
        // accept_or_timeout_game_on_chain can find it during on-chain
        // resolution if the channel goes on-chain before the potato
        // round-trip completes.
        let (ref_clone, ph_clone) = live_game.save_referee_state();
        self.pending_accept_games.push(LiveGame::new(
            game_id.clone(),
            ph_clone,
            ref_clone,
            live_game.my_contribution.clone(),
            live_game.their_contribution.clone(),
        ));

        self.my_out_of_game_balance += amount.clone();
        self.their_out_of_game_balance += at_stake.clone() - amount.clone();

        self.update_cache_for_potato_send(if amount == Amount::default() {
            None
        } else {
            Some(CachedPotatoRegenerateLastHop::PotatoAccept(Box::new(
                PotatoAcceptCachedData {
                    game_id: game_id.clone(),
                    puzzle_hash: live_game.last_referee_puzzle_hash.clone(),
                    live_game,
                    at_stake_amount: at_stake,
                    our_share_amount: amount.clone(),
                },
            )))
        });

        let signatures = self.update_cached_unroll_state(env)?;

        Ok((signatures, amount))
    }

    pub fn received_potato_accept<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        signatures: &PotatoSignatures,
        game_id: &GameID,
    ) -> Result<ChannelCoinSpendInfo, Error> {
        assert!(!self.have_potato);
        let game_idx = self.get_game_by_id(game_id)?;
        let unroll_data = self.compute_unroll_data_for_games(
            // Skip the removed game.
            std::slice::from_ref(game_id),
            None,
            &self.live_games,
        )?;

        let game_amount_for_me = self.live_games[game_idx].get_our_current_share();
        let game_amount_for_them = self.live_games[game_idx].get_amount()
            - self.live_games[game_idx].get_our_current_share();

        let new_my_allocated =
            self.my_allocated_balance.clone() - self.live_games[game_idx].my_contribution.clone();
        let new_their_allocated = self.their_allocated_balance.clone()
            - self.live_games[game_idx].their_contribution.clone();
        let my_balance = self.my_out_of_game_balance.clone() + game_amount_for_me;
        let their_balance = self.their_out_of_game_balance.clone() + game_amount_for_them;

        let unroll_condition_inputs = self.unroll_coin_condition_inputs(
            my_balance.clone(),
            their_balance.clone(),
            &unroll_data,
        );
        let spend =
            self.received_potato_verify_signatures(env, signatures, &unroll_condition_inputs)?;

        self.my_allocated_balance = new_my_allocated;
        self.their_allocated_balance = new_their_allocated;

        self.my_out_of_game_balance = my_balance;
        self.their_out_of_game_balance = their_balance;

        let removed = self.live_games.remove(game_idx);
        self.pending_accept_games.push(removed);

        Ok(ChannelCoinSpendInfo {
            aggsig: spend.signature,
            solution: spend.solution.p(),
            conditions: spend.conditions.p(),
        })
    }

    pub fn state_channel_coin_solution_and_signature<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        conditions: Rc<Program>,
    ) -> Result<(Rc<Program>, Aggsig), Error> {
        let aggregate_public_key = self.get_aggregate_channel_public_key();
        let spend = self.state_channel_coin();
        let channel_coin_spend = self.get_solution_and_signature_from_conditions(
            &spend.to_coin_id(),
            env,
            &self.private_keys.my_channel_coin_private_key,
            &aggregate_public_key,
            conditions,
        )?;

        Ok((
            channel_coin_spend.solution.p(),
            channel_coin_spend.signature,
        ))
    }

    /// Uses the channel coin key to post standard format coin generation to the
    /// real blockchain via a Spend.
    pub fn send_potato_clean_shutdown<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        conditions: NodePtr,
    ) -> Result<Spend, Error> {
        assert!(self.have_potato);
        let aggregate_public_key = self.get_aggregate_channel_public_key();
        let spend = self.state_channel_coin();

        let conditions_program = Program::from_nodeptr(env.allocator, conditions)?;
        let channel_coin_spend = self.get_solution_and_signature_from_conditions(
            &spend.to_coin_id(),
            env,
            &self.private_keys.my_channel_coin_private_key,
            &aggregate_public_key,
            Rc::new(conditions_program),
        )?;

        Ok(Spend {
            solution: channel_coin_spend.solution.clone(),
            signature: channel_coin_spend.signature,
            puzzle: puzzle_for_pk(env.allocator, &aggregate_public_key)?,
        })
    }

    pub fn get_solution_and_signature_from_conditions<R: Rng>(
        &self,
        coin_id: &CoinID,
        env: &mut ChannelHandlerEnv<R>,
        private_key: &PrivateKey,
        aggregate_public_key: &PublicKey,
        conditions: Rc<Program>,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        let conditions_nodeptr = conditions.to_nodeptr(env.allocator)?;
        let spend = standard_solution_partial(
            env.allocator,
            private_key,
            coin_id,
            conditions_nodeptr,
            aggregate_public_key,
            &env.agg_sig_me_additional_data,
            true,
        )?;
        Ok(spend)
    }

    pub fn get_solution_and_signature<R: Rng>(
        &self,
        coin_id: &CoinID,
        env: &mut ChannelHandlerEnv<R>,
        private_key: &PrivateKey,
        aggregate_channel_public_key: &PublicKey,
        aggregate_unroll_public_key: &PublicKey,
        amount: &Amount,
        unroll_coin: &UnrollCoin,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        let unroll_puzzle =
            unroll_coin.make_curried_unroll_puzzle(env, aggregate_unroll_public_key)?;
        let unroll_puzzle_hash = Node(unroll_puzzle).sha256tree(env.allocator);
        let create_conditions = vec![Node(
            (
                CREATE_COIN,
                (unroll_puzzle_hash.clone(), (amount.clone(), ())),
            )
                .to_clvm(env.allocator)
                .into_gen()?,
        )];
        let create_conditions_obj = create_conditions.to_clvm(env.allocator).into_gen()?;
        let create_conditions_with_rem =
            prepend_rem_conditions(env, unroll_coin.state_number, create_conditions_obj)?;
        let ccrem_program = Program::from_nodeptr(env.allocator, create_conditions_with_rem)?;
        self.get_solution_and_signature_from_conditions(
            coin_id,
            env,
            private_key,
            aggregate_channel_public_key,
            Rc::new(ccrem_program),
        )
    }

    pub fn received_potato_clean_shutdown<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        their_channel_half_signature: &Aggsig,
        conditions: NodePtr,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        assert!(!self.have_potato);
        let conditions_program = Program::from_nodeptr(env.allocator, conditions)?;
        let channel_spend = self.verify_channel_coin_from_peer_signatures(
            env,
            their_channel_half_signature,
            Rc::new(conditions_program),
        )?;

        Ok(channel_spend)
    }

    /// Extract the on-chain unrolling state number from the channel-coin
    /// spend conditions.
    pub fn unrolling_state_from_conditions<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        conditions: NodePtr,
    ) -> Result<usize, Error> {
        let rem = self.break_out_conditions_for_spent_coin(env, conditions)?;
        usize_from_atom(&rem[0])
            .ok_or_else(|| Error::StrErr("Unconvertible state number".to_string()))
    }

    fn break_out_conditions_for_spent_coin<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        conditions: NodePtr,
    ) -> Result<Vec<Vec<u8>>, Error> {
        // Figure out our state number vs the one given in conditions.
        let all_conditions = CoinCondition::from_nodeptr(env.allocator, conditions);
        let rem_conditions: Vec<Vec<u8>> = all_conditions
            .iter()
            .filter_map(|c| {
                if let CoinCondition::Rem(data) = c {
                    return data.first().cloned();
                }

                None
            })
            .collect();

        if rem_conditions.is_empty() {
            return Err(Error::StrErr(
                "Wrong number of rems in conditions".to_string(),
            ));
        }

        Ok(rem_conditions)
    }

    pub fn get_create_unroll_coin_transaction<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        use_unroll: &ChannelHandlerUnrollSpendInfo,
        add_sigs: bool,
    ) -> Result<ChannelCoinSpentResult, Error> {
        assert!(self.timeout.is_some());

        // Superceding state no timeout
        // Provide a reveal of the unroll puzzle.
        // Provide last unroll conditions
        // Should have a cached signature for unrolling

        // Full unroll puzzle reveal includes the curried info,
        let curried_unroll_puzzle = use_unroll
            .coin
            .make_curried_unroll_puzzle(env, &self.get_aggregate_unroll_public_key())?;
        let unroll_puzzle_solution = use_unroll
            .coin
            .make_unroll_puzzle_solution(env, &self.get_aggregate_unroll_public_key())?;
        let solution_program = Program::from_nodeptr(env.allocator, unroll_puzzle_solution)?;

        let mut signature = use_unroll.coin.get_unroll_coin_signature()?;
        if add_sigs {
            signature += use_unroll.signatures.my_unroll_half_signature_peer.clone();
        }
        Ok(ChannelCoinSpentResult {
            transaction: Spend {
                puzzle: Puzzle::from_nodeptr(env.allocator, curried_unroll_puzzle)?,
                solution: solution_program.into(),
                signature,
            },
            timeout: false,
            games_canceled: self.get_just_created_games(),
            unrolling_state_number: 0,
        })
    }

    /// Ensure that we include the last state sequence number in a memo so we can
    /// possibly supercede an earlier unroll.
    ///
    /// Look at the conditions:
    ///
    /// The current sequence number is always either
    /// We have two sequence numbers:
    ///  - unroll state number
    ///  - channel coin spend state number
    ///
    /// Whenever the channel coin gets spent, either we'll want to make it hit
    /// its timeout or supercede the state that's in it.
    ///
    /// If the sequence number in the unroll is equal to our current state number
    /// then force the timeout.
    ///
    /// Otherwise
    ///   Not equal, and parity equal - hard error
    ///   Less than our current unroll number - either same parity (fucked) or
    ///   opposite (return a spend to supercede the spend it gave)
    ///   Equal to unroll, try to timeout
    ///   Equal to state, not unroll, try to timeout (different)
    ///   Greater than state number - hard error
    ///
    /// Conditions on spending the channel should have default_conditions_hash
    /// and state number as rems.
    ///
    /// Happens because one of us decided to start spending it.
    /// Play has not necessarily ended.
    /// One way in which this is spent is the clean unroll.
    ///   Clean unroll won't reach here.
    /// One of the two sides, started unrolling.
    ///   So we must unroll as well.
    ///
    /// Give a spend to do as well to start our part of the unroll given that
    /// the channel coin is spent.
    ///
    /// Must have the option that games were outright canceled.
    /// Need to make the result richer to communicate that.
    pub fn channel_coin_spent<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        myself: bool,
        conditions: NodePtr,
    ) -> Result<ChannelCoinSpentResult, Error> {
        let rem_conditions = self.break_out_conditions_for_spent_coin(env, conditions)?;

        let unrolling_state_number = usize_from_atom(&rem_conditions[0])
            .ok_or_else(|| Error::StrErr("Unconvertible state number".to_string()))?;

        // Three cases based on comparing on-chain state to our current state:
        let mut result = match (
            myself,
            unrolling_state_number.cmp(&self.current_state_number),
        ) {
            // We initiated this spend, or the on-chain state matches ours:
            // use the timeout (default) path.
            (true, _) | (_, Ordering::Equal) => self.make_timeout_unroll_spend(env),
            // On-chain state is from the future relative to us - error.
            (_, Ordering::Greater) => Err(Error::StrErr(format!(
                "Reply from the future onchain {} (me {})",
                unrolling_state_number, self.current_state_number,
            ))),
            // On-chain state is behind ours - preempt.  We have two
            // adjacent states (unroll and timeout); exactly one will
            // satisfy the CLSP parity constraint.  If neither does,
            // make_preemption_unroll_spend returns an error (case e).
            (_, Ordering::Less) => self.make_preemption_unroll_spend(env, unrolling_state_number),
        };
        if let Ok(ref mut r) = result {
            r.unrolling_state_number = unrolling_state_number;
        }
        result
    }

    /// Build the timeout (default-path) spend of the unroll coin using our
    /// own unroll data.  Both puzzle and solution come from `self.unroll`.
    fn make_timeout_unroll_spend<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
    ) -> Result<ChannelCoinSpentResult, Error> {
        let agg_key = self.get_aggregate_unroll_public_key();
        let curried_puzzle = self.unroll.coin.make_curried_unroll_puzzle(env, &agg_key)?;
        let solution = self.unroll.coin.make_unroll_puzzle_solution(env, &agg_key)?;

        Ok(ChannelCoinSpentResult {
            transaction: Spend {
                puzzle: Puzzle::from_nodeptr(env.allocator, curried_puzzle)?,
                solution: Program::from_nodeptr(env.allocator, solution)?.into(),
                signature: self.unroll.coin.get_unroll_coin_signature()?,
            },
            timeout: true,
            games_canceled: self.get_just_created_games(),
            unrolling_state_number: 0,
        })
    }

    /// Build a preemption (challenge-path) spend of the unroll coin.
    /// The PUZZLE must match the on-chain coin (built from the state that
    /// matches the on-chain unroll).  The SOLUTION and SIGNATURE come from
    /// our latest state that satisfies the CLSP parity constraint:
    ///   logand(1, logxor(our_state_number, OLD_SEQUENCE_NUMBER)) == 1
    fn make_preemption_unroll_spend<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        unrolling_state_number: usize,
    ) -> Result<ChannelCoinSpentResult, Error> {
        // OLD_SEQUENCE_NUMBER equals state_number (both set during update()).
        // The channel coin REM also carries state_number, so OLD = unrolling_state_number.
        let old_sn = unrolling_state_number;

        let agg_key = self.get_aggregate_unroll_public_key();

        // Pick whichever of our stored states has the right parity relative
        // to OLD.  The CLSP requires logand(1, logxor(new_sn, old_sn)) == 1,
        // i.e. new_sn and old_sn must differ in the LSB.
        //
        // A candidate must also have the peer's half-signature — without it
        // the aggregate signature cannot be formed and the spend would be
        // rejected on-chain.  The `unroll` slot lacks peer signatures after
        // update_cached_unroll_state (they arrive only in the `timeout` slot
        // when the peer responds), so it is often ineligible.
        let has_peer_sig = |info: &ChannelHandlerUnrollSpendInfo| -> bool {
            info.signatures.my_unroll_half_signature_peer != Aggsig::default()
        };
        let parity_ok = |sn: usize| -> bool { (sn ^ old_sn) & 1 == 1 };

        let unroll_ok = parity_ok(self.unroll.coin.state_number) && has_peer_sig(&self.unroll);
        let preempt_source = if unroll_ok {
            &self.unroll
        } else if let Some(t) = self.timeout.as_ref() {
            if parity_ok(t.coin.state_number) && has_peer_sig(t) {
                t
            } else {
                return Err(Error::StrErr(format!(
                    "No stored state satisfies parity+signature for preemption (old={old_sn} unroll_sn={} timeout_sn={:?})",
                    self.unroll.coin.state_number,
                    self.timeout.as_ref().map(|t| t.coin.state_number),
                )));
            }
        } else {
            return Err(Error::StrErr(
                "No timeout state available for preemption".to_string(),
            ));
        };

        // PUZZLE: must match the on-chain unroll coin.  Reconstruct it from
        // known components using the stored conditions_hash for the on-chain
        // state number.  Both sides compute identical puzzles for each
        // exchange, so we stored the hash during the original exchange.
        let conditions_hash = self
            .state_conditions_hashes
            .get(&unrolling_state_number)
            .cloned()
            .ok_or_else(|| {
                Error::StrErr(format!(
                    "No stored conditions_hash for state {unrolling_state_number} (have: {:?})",
                    self.state_conditions_hashes.keys().collect::<Vec<_>>(),
                ))
            })?;

        let shared_puzzle = CurriedProgram {
            program: env.unroll_metapuzzle.clone(),
            args: clvm_curried_args!(agg_key.clone()),
        }
        .to_clvm(env.allocator)
        .into_gen()?;
        let shared_puzzle_hash = Node(shared_puzzle).sha256tree(env.allocator);

        let curried_puzzle = CurriedProgram {
            program: env.unroll_puzzle.clone(),
            args: clvm_curried_args!(shared_puzzle_hash, unrolling_state_number, conditions_hash),
        }
        .to_clvm(env.allocator)
        .into_gen()?;

        // SOLUTION: from the preemption source (our newer state).
        let solution = preempt_source.coin.make_unroll_puzzle_solution(env, &agg_key)?;

        // SIGNATURE: aggregate of both halves from the preemption source.
        let mut signature = preempt_source.coin.get_unroll_coin_signature()?;
        signature += preempt_source.signatures.my_unroll_half_signature_peer.clone();

        Ok(ChannelCoinSpentResult {
            transaction: Spend {
                puzzle: Puzzle::from_nodeptr(env.allocator, curried_puzzle)?,
                solution: Program::from_nodeptr(env.allocator, solution)?.into(),
                signature,
            },
            timeout: false,
            games_canceled: self.get_just_created_games(),
            unrolling_state_number: 0,
        })
    }

    // 5 cases
    //
    // 1 last potato nil (nothing changed)
    // 2 last potato sent made a game (game would be cancelled, don't need to know
    //    anything but the balance we got back)
    // 3 accept - remember the accept transaction.  work off the game list we have
    //    wont include the accepted game.  will have transaction bundle.
    // 4 game cancelled any other time (skip when making list).
    // 5 move happening - outer thing needs to know that this thing is associated
    //    with a specific game.  will spend that game coin.  referee maker up to
    //    date after that.  aware of move relationship to game id.
    fn update_cache_for_potato_send(
        &mut self,
        cache_update: Option<CachedPotatoRegenerateLastHop>,
    ) {
        self.cached_last_action = cache_update;
    }

    fn get_cached_disposition_for_spent_result<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        unroll_coin: &CoinString,
        state_number: usize,
    ) -> Result<Option<DispositionResult>, Error> {
        if state_number == self.current_state_number {
            return Ok(None);
        } else if state_number != self.unroll.coin.state_number {
            return Err(Error::StrErr("Bad state number".to_string()));
        }

        match self.cached_last_action.as_ref() {
            None => Ok(None),
            Some(CachedPotatoRegenerateLastHop::PotatoCreatedGame(
                ids,
                our_contrib,
                _their_contrib,
            )) => {
                // Add amount contributed to vanilla balance
                // Skip game when generating result.
                Ok(Some(DispositionResult {
                    disposition: CoinSpentDisposition::CancelledUX(ids.to_vec()),
                    skip_game: ids.clone(),
                    skip_coin_id: None,
                    our_contribution_adjustment: our_contrib.clone(),
                }))
            }
            Some(CachedPotatoRegenerateLastHop::PotatoAccept(cached)) => {
                let game_coin = CoinString::from_parts(
                    &unroll_coin.to_coin_id(),
                    &cached.puzzle_hash,
                    &cached.at_stake_amount,
                );

                let spend_transaction =
                    cached
                        .live_game
                        .get_transaction_for_move(env.allocator, &game_coin, false)?;

                Ok(Some(DispositionResult {
                    disposition: CoinSpentDisposition::Accept(CoinSpentAccept {
                        game_id: cached.game_id.clone(),
                        spend: CoinSpend {
                            coin: unroll_coin.clone(),
                            bundle: spend_transaction.bundle.clone(),
                        },
                        reward_coin: spend_transaction.coin,
                    }),
                    skip_game: Vec::default(),
                    skip_coin_id: None,
                    our_contribution_adjustment: Amount::default(),
                }))
            }
            Some(CachedPotatoRegenerateLastHop::PotatoMoveHappening(cached)) => {
                let game_idx = self.get_game_by_id(&cached.game_id)?;

                let game_coin = CoinString::from_parts(
                    &unroll_coin.to_coin_id(),
                    &cached.puzzle_hash,
                    &cached.amount,
                );

                let spend_transaction = self.live_games[game_idx].get_transaction_for_move(
                    env.allocator,
                    &game_coin,
                    false,
                )?;

                // Existing game coin is in the before state.
                Ok(Some(DispositionResult {
                    disposition: CoinSpentDisposition::Move(CoinSpentMoveUp {
                        game_id: cached.game_id.clone(),
                        spend_before_game_coin: CoinSpend {
                            coin: game_coin.clone(),
                            bundle: spend_transaction.bundle.clone(),
                        },
                        after_update_game_coin: spend_transaction.coin.clone(),
                    }),
                    skip_coin_id: Some(cached.game_id.clone()),
                    skip_game: Vec::default(),
                    our_contribution_adjustment: Amount::default(),
                }))
            }
        }
    }

    fn get_new_game_coins_on_chain(
        &self,
        unroll_coin: Option<&CoinID>,
        skip_game: &[GameID],
        skip_coin_id: Option<&GameID>,
    ) -> Result<Vec<OnChainGameCoin>, Error> {
        self.compute_game_coin_unroll_data(unroll_coin, skip_game, skip_coin_id, &self.live_games)
    }

    pub fn get_game_coins<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
    ) -> Result<Vec<OnChainGameCoin>, Error> {
        let state_number = self.unroll.coin.state_number;
        // We need the view of the system as of the most recent timeout.
        // I made a move, they have the potato, so we need to reconstruct the
        // game states from the most recent their turn.  If there's a move in the
        // state cache then that game uses that puzzle hash and amount, otherwise
        // it uses the one from the live game object.  Once on chain, we'll need
        // the actual puzzle, but that's a problem for a comment other than this
        // one.
        let unroll_puzzle = self.make_curried_unroll_puzzle(env)?;
        let unroll_puzzle_hash = Node(unroll_puzzle).sha256tree(env.allocator);
        let parent_coin = self.state_channel.coin.clone();
        let unroll_coin = CoinString::from_parts(
            &parent_coin.to_coin_id(),
            &unroll_puzzle_hash,
            &(self.my_out_of_game_balance.clone() + self.their_out_of_game_balance.clone()),
        );

        let disposition =
            self.get_cached_disposition_for_spent_result(env, &unroll_coin, state_number)?;
        self.get_new_game_coins_on_chain(
            Some(&unroll_coin.to_coin_id()),
            &disposition
                .as_ref()
                .map(|d| d.skip_game.clone())
                .unwrap_or_default(),
            disposition.as_ref().and_then(|d| d.skip_coin_id.as_ref()),
        )
    }

    // Reset our state so that we generate the indicated puzzles from the live games.
    /// After an unroll completes, map on-chain game coin puzzle hashes to the
    /// corresponding live games.  No rewinding.
    ///
    /// Match game coins to live games by amount, then determine the action:
    ///  (a) coin PH matches `cached_last_action.match_puzzle_hash`
    ///      → we need to replay our cached move on this coin
    ///  (b) coin PH matches the live game's `last_referee_puzzle_hash`
    ///      → game is already at the latest state, nothing to redo
    ///  (c) coin PH matches neither → the preemption/timeout created the coin
    ///      from the other player's perspective; if we have a cached action for
    ///      this game, we still need the redo
    pub fn set_state_for_coins<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<R>,
        unroll_coin: &CoinString,
        coins: &[PuzzleHash],
    ) -> Result<HashMap<CoinString, OnChainGameState>, Error> {
        let mut res = HashMap::new();

        let (cached_game_id, cached_match_ph) = match &self.cached_last_action {
            Some(CachedPotatoRegenerateLastHop::PotatoMoveHappening(d)) => {
                (Some(d.game_id.clone()), Some(d.match_puzzle_hash.clone()))
            }
            _ => (None, None),
        };

        for game_coin_ph in coins.iter() {
            let mut matched = false;

            for live_game in self.live_games.iter_mut() {
                let coin_id = CoinString::from_parts(
                    &unroll_coin.to_coin_id(),
                    game_coin_ph,
                    &live_game.get_amount(),
                );

                let needs_redo = cached_game_id.as_ref() == Some(&live_game.game_id)
                    && cached_match_ph.as_ref() == Some(game_coin_ph);
                let is_latest = live_game.last_referee_puzzle_hash == *game_coin_ph;

                let game_timeout = live_game.get_game_timeout();

                if needs_redo {
                    res.insert(
                        coin_id,
                        OnChainGameState {
                            game_id: live_game.game_id.clone(),
                            puzzle_hash: game_coin_ph.clone(),
                            our_turn: true,
                            state_number: self.current_state_number,
                            accept: AcceptTransactionState::Waiting,
                            pending_slash_amount: None,
                            cheating_move_mover_share: None,
                            accepted: false,
                            game_timeout,
                        },
                    );
                    matched = true;
                    break;
                }

                // No cached action: determine our_turn from the referee.
                // If the coin is at the latest state and the referee
                // says it's our turn, we can move normally on-chain.
                let our_turn = is_latest && live_game.is_my_turn();
                res.insert(
                    coin_id,
                    OnChainGameState {
                        game_id: live_game.game_id.clone(),
                        puzzle_hash: game_coin_ph.clone(),
                        our_turn,
                        state_number: self.current_state_number,
                        accept: AcceptTransactionState::Waiting,
                        pending_slash_amount: None,
                        cheating_move_mover_share: None,
                        accepted: false,
                        game_timeout,
                    },
                );
                matched = true;
                break;
            }

            if !matched {
                for pending in self.pending_accept_games.iter() {
                    let coin_id = CoinString::from_parts(
                        &unroll_coin.to_coin_id(),
                        game_coin_ph,
                        &pending.get_amount(),
                    );
                    res.insert(
                        coin_id,
                        OnChainGameState {
                            game_id: pending.game_id.clone(),
                            puzzle_hash: game_coin_ph.clone(),
                            our_turn: true,
                            state_number: self.current_state_number,
                            accept: AcceptTransactionState::Waiting,
                            pending_slash_amount: None,
                            cheating_move_mover_share: None,
                            accepted: true,
                            game_timeout: pending.get_game_timeout(),
                        },
                    );
                    break;
                }
            }
        }

        Ok(res)
    }

    pub fn game_is_my_turn(&self, game_id: &GameID) -> Option<bool> {
        for g in self.live_games.iter() {
            if g.game_id == *game_id {
                return Some(g.is_my_turn());
            }
        }

        None
    }

    pub fn enable_cheating_for_game(
        &mut self,
        game_id: &GameID,
        make_move: &[u8],
        mover_share: Amount,
    ) -> Result<bool, Error> {
        let game_idx = self.get_game_by_id(game_id)?;
        Ok(self.live_games[game_idx].enable_cheating(make_move, mover_share))
    }

    pub fn save_game_state(
        &self,
        game_id: &GameID,
    ) -> Result<(Rc<dyn RefereeInterface>, PuzzleHash), Error> {
        let idx = self.get_game_by_id(game_id)?;
        Ok(self.live_games[idx].save_referee_state())
    }

    pub fn restore_game_state(
        &mut self,
        game_id: &GameID,
        referee: Rc<dyn RefereeInterface>,
        last_ph: PuzzleHash,
    ) -> Result<(), Error> {
        let idx = self.get_game_by_id(game_id)?;
        self.live_games[idx].restore_referee_state(referee, last_ph);
        Ok(())
    }

    pub fn get_transaction_for_game_move(
        &self,
        allocator: &mut AllocEncoder,
        game_id: &GameID,
        game_coin: &CoinString,
        on_chain: bool,
    ) -> Result<RefereeOnChainTransaction, Error> {
        let idx = self.get_game_by_id(game_id)?;
        self.live_games[idx].get_transaction_for_move(allocator, game_coin, on_chain)
    }

    pub fn get_game_outcome_puzzle_hash<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        game_id: &GameID,
    ) -> Result<PuzzleHash, Error> {
        let idx = self.get_game_by_id(game_id)?;
        self.live_games[idx].outcome_puzzle_hash(env.allocator)
    }

    /// Extract cached move data (including saved S' referee) from
    /// `cached_last_action` for a specific game.
    pub fn take_cached_move_for_game(
        &mut self,
        game_id: &GameID,
    ) -> Option<Rc<PotatoMoveCachedData>> {
        if let Some(CachedPotatoRegenerateLastHop::PotatoMoveHappening(move_data)) =
            &self.cached_last_action
        {
            if move_data.game_id == *game_id {
                let result = move_data.clone();
                self.cached_last_action = None;
                return Some(result);
            }
        }
        None
    }

    pub fn on_chain_our_move<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        game_id: &GameID,
        readable_move: &ReadableMove,
        entropy: Hash,
        existing_coin: &CoinString,
    ) -> Result<
        (
            PuzzleHash,
            PuzzleHash,
            usize,
            GameMoveDetails,
            RefereeOnChainTransaction,
        ),
        Error,
    > {
        let game_idx = self.get_game_by_id(game_id)?;

        let last_puzzle_hash = self.live_games[game_idx].last_puzzle_hash();
        let _start_puzzle_hash = self.live_games[game_idx].current_puzzle_hash(env.allocator)?;

        // assert_eq!(start_puzzle_hash, existing_ph);

        // assert_eq!(self.game_is_my_turn(game_id), Some(true));
        let move_result = self.live_games[game_idx].internal_make_move(
            env.allocator,
            readable_move,
            entropy,
            self.current_state_number,
        )?;

        let tx = self.live_games[game_idx].get_transaction_for_move(
            env.allocator,
            existing_coin,
            true,
        )?;

        let post_outcome = self.live_games[game_idx].outcome_puzzle_hash(env.allocator)?;

        Ok((
            last_puzzle_hash,
            post_outcome,
            self.current_state_number,
            move_result.details.clone(),
            tx,
        ))
    }

    pub fn is_our_spend<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        game_id: &GameID,
        coin_string: &CoinString,
    ) -> Result<bool, Error> {
        let live_game_idx = self.get_game_by_id(game_id)?;
        let prev_puzzle_hash = self.live_games[live_game_idx].current_puzzle_hash(env.allocator)?;
        if !self.live_games[live_game_idx].processing_my_turn() {
            return Ok(false);
        }

        if let Some((_, ph, _)) = coin_string.to_parts() {
            return Ok(prev_puzzle_hash == ph);
        }

        Ok(false)
    }

    pub fn game_coin_spent<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        game_id: &GameID,
        coin_string: &CoinString,
        conditions: &[CoinCondition],
    ) -> Result<CoinSpentInformation, Error> {
        let reward_puzzle_hash = self.get_reward_puzzle_hash(env)?;

        let (ph, amt) = if let Some((ph, amt)) = conditions
            .iter()
            .filter_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    return Some((ph.clone(), amt.clone()));
                }

                None
            })
            .next()
        {
            (ph, amt)
        } else {
            return Err(Error::StrErr("bad coin".to_string()));
        };

        if reward_puzzle_hash == ph {
            return Ok(CoinSpentInformation::OurReward(ph.clone(), amt.clone()));
        }

        let live_game_idx = self.get_game_by_id(game_id)?;

        // Forward-only alignment: if the new coin's PH matches our
        // referee's expected outcome, the opponent's move brought the
        // on-chain state to where our referee already is. Skip the
        // referee's coin-spend processing and return Expected directly.
        let our_on_chain_ph = self.live_games[live_game_idx].current_puzzle_hash(env.allocator)?;
        let our_outcome_ph = self.live_games[live_game_idx].outcome_puzzle_hash(env.allocator)?;
        if ph == our_on_chain_ph || ph == our_outcome_ph {
            let coin_being_spent_ph = coin_string.to_parts().map(|(_, p, _)| p);
            let matches_spent = coin_being_spent_ph.as_ref() == Some(&ph);
            if !matches_spent {
                self.live_games[live_game_idx].last_referee_puzzle_hash = ph.clone();
                return Ok(CoinSpentInformation::TheirSpend(
                    TheirTurnCoinSpentResult::Expected(
                        self.current_state_number,
                        ph,
                        amt,
                        None,
                    ),
                ));
            }
        }

        let spent_result = self.live_games[live_game_idx].their_turn_coin_spent(
            env.allocator,
            coin_string,
            conditions,
            self.current_state_number,
        )?;
        Ok(CoinSpentInformation::TheirSpend(spent_result))
    }

    /// Simple forward-only redo check.  `set_state_for_coins` already matched
    /// the game coin to the live game by amount.  We just check if the cached
    /// action is for the same game and emit the `RedoMove`.
    fn get_redo_result_forward(
        &self,
        cla: &Option<CachedPotatoRegenerateLastHop>,
        coin: &CoinString,
    ) -> Result<Option<GameAction>, Error> {
        if let Some(CachedPotatoRegenerateLastHop::PotatoMoveHappening(move_data)) = cla {
            let coin_matches = coin
                .to_parts()
                .map(|(_, ph, _)| ph == move_data.match_puzzle_hash)
                .unwrap_or(false);
            if coin_matches {
                return Ok(Some(GameAction::RedoMove(
                    move_data.game_id.clone(),
                    coin.clone(),
                    move_data.clone(),
                )));
            }
        }
        Ok(None)
    }

    pub fn get_redo_action<R: Rng>(
        &mut self,
        _env: &mut ChannelHandlerEnv<R>,
        coin: &CoinString,
    ) -> Result<Option<GameAction>, Error> {
        let mut cla = None;
        swap(&mut cla, &mut self.cached_last_action);
        let result = self.get_redo_result_forward(&cla, coin);
        if result.as_ref().map(|r| r.is_none()).unwrap_or(false) {
            swap(&mut cla, &mut self.cached_last_action);
        }
        result
    }

    // what our vanilla coin string is
    // return these triplets for all the active games
    //  (id of game, coin string that's now on chain for it and the referee maker
    //   for playing it)
    //  Returns 3 special goofy things:
    //   move that needs to be replayed on chain
    //   the game is in a goofy state because the spilled out referee maker thinks
    //     things are one step behind
    //   other special value is whether we folded or not
    //   (necessary info to do folding)
    //  Finally, the game that got cancelled (id).
    // includes the relative balances reflected
    //  folded and move should include a transaction bundle
    //  folded one: coin string of reward coin.
    //
    // Actually not sure what's going to happen
    // could be a time out
    // or other side could supplant this state.
    //
    // Could be we sent the potato, we timeout (network lag) but they
    // immediately supercede.
    //
    // If they supercede the timeout we sent then that's ok.
    // Thing that's goofy: state n successfully times out.
    // The potato we sen't didn't happen.
    // Nil potato -> ok
    // Last we did was fold, fold on chain
    // Last we did was move, replay move on chain
    // Last we did was create a game, game cancelled, put back
    // balances.
    //
    // If we have the potato at state 0 and they start an unroll, we don't
    pub fn unroll_coin_spent<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        unroll_coin: &CoinString,
        conditions: NodePtr,
    ) -> Result<CoinSpentResult, Error> {
        let rem_conditions = self.break_out_conditions_for_spent_coin(env, conditions)?;

        let state_number = if let Some(state_number) = usize_from_atom(&rem_conditions[0]) {
            state_number
        } else {
            return Err(Error::StrErr("Unconvertible state number".to_string()));
        };

        let disposition =
            self.get_cached_disposition_for_spent_result(env, unroll_coin, state_number)?;

        // return list of triples of game_id, coin_id, referee maker pulling from a list of pairs of (id, ref maker)
        let new_game_coins_on_chain = self.get_new_game_coins_on_chain(
            Some(&unroll_coin.to_coin_id()),
            &disposition
                .as_ref()
                .map(|d| d.skip_game.clone())
                .unwrap_or_default(),
            disposition.as_ref().and_then(|d| d.skip_coin_id.as_ref()),
        )?;

        // coin with = parent is the unroll coin id and whose puzzle hash is ref and amount is my vanilla amount.
        let referee_public_key = private_to_public_key(&self.referee_private_key());
        let referee_puzzle_hash = puzzle_hash_for_pk(env.allocator, &referee_public_key)?;
        let adjusted_amount = disposition
            .as_ref()
            .map(|d| d.our_contribution_adjustment.clone())
            .unwrap_or_default();

        Ok(CoinSpentResult {
            my_clean_reward_coin_string_up: CoinString::from_parts(
                &unroll_coin.to_coin_id(),
                &referee_puzzle_hash.clone(),
                &(self.my_out_of_game_balance.clone() + adjusted_amount),
            ),
            new_game_coins_on_chain,
            disposition: disposition.map(|d| d.disposition),
        })
    }

    pub fn accept_or_timeout_game_on_chain<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        game_id: &GameID,
        coin: &CoinString,
    ) -> Result<Option<RefereeOnChainTransaction>, Error> {
        if let Ok(game_idx) = self.get_game_by_id(game_id) {
            let tx = self.live_games[game_idx].get_transaction_for_timeout(env.allocator, coin)?;
            self.live_games.remove(game_idx);
            Ok(tx)
        } else if let Some(idx) = self
            .pending_accept_games
            .iter()
            .position(|g| g.game_id == *game_id)
        {
            let tx = self.pending_accept_games[idx]
                .get_transaction_for_timeout(env.allocator, coin)?;
            self.pending_accept_games.remove(idx);
            Ok(tx)
        } else {
            Ok(None)
        }
    }

    // the vanilla coin we get and each reward coin are all sent to the referee
    // this returns spends which allow them to be consolidated by spending the
    // reward coins.
    //
    // From here, they're spent to the puzzle hash given.
    // Makes a single coin whose puzzle hash is the specified one and amount is
    // equal to all the inputs.
    //
    // All coin strings coming in should have the referee pubkey's standard puzzle
    // hash as their puzzle hash.
    pub fn spend_reward_coins<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        coins: &[CoinString],
        target_puzzle_hash: &PuzzleHash,
    ) -> Result<SpendRewardResult, Error> {
        let mut total_amount = Amount::default();
        let mut exploded_coins = Vec::with_capacity(coins.len());
        let my_referee_public_key =
            private_to_public_key(&self.private_keys.my_referee_private_key);
        let referee_puzzle_hash = puzzle_hash_for_pk(env.allocator, &my_referee_public_key)?;

        for c in coins.iter() {
            let (_parent, ph, amount) = c.get_coin_string_parts()?;
            assert_eq!(ph, referee_puzzle_hash);
            total_amount += amount.clone();
            exploded_coins.push(CoinDataForReward {
                coin_string: c.clone(),
                // parent,
                // puzzle_hash: ph,
                // amount,
            });
        }

        let mut coins_with_solutions = Vec::with_capacity(exploded_coins.len());
        let default_hidden_puzzle_hash = Hash::from_bytes(DEFAULT_HIDDEN_PUZZLE_HASH);
        let synthetic_referee_private_key = calculate_synthetic_secret_key(
            &self.private_keys.my_referee_private_key,
            &default_hidden_puzzle_hash,
        )?;
        let puzzle = puzzle_for_pk(env.allocator, &my_referee_public_key)?;

        for (i, coin) in exploded_coins.iter().enumerate() {
            let parent_id = coin.coin_string.to_coin_id();
            let conditions = if i == 0 {
                (
                    (
                        CREATE_COIN,
                        (target_puzzle_hash.clone(), (total_amount.clone(), ())),
                    ),
                    (),
                )
                    .to_clvm(env.allocator)
                    .into_gen()?
            } else {
                ().to_clvm(env.allocator).into_gen()?
            };

            let spend = standard_solution_partial(
                env.allocator,
                &synthetic_referee_private_key,
                &parent_id,
                conditions,
                &my_referee_public_key,
                &env.agg_sig_me_additional_data,
                false,
            )?;

            coins_with_solutions.push(CoinSpend {
                coin: coin.coin_string.clone(),
                bundle: Spend {
                    puzzle: puzzle.clone(),
                    solution: spend.solution.clone(),
                    signature: spend.signature.clone(),
                },
            });
        }

        let result_coin_parent = if let Some(coin) = exploded_coins.first() {
            coin.coin_string.clone()
        } else {
            return Err(Error::StrErr("no reward coins to spend".to_string()));
        };

        Ok(SpendRewardResult {
            coins_with_solutions,
            result_coin_string_up: CoinString::from_parts(
                &result_coin_parent.to_coin_id(),
                target_puzzle_hash,
                &total_amount,
            ),
        })
    }

    // Inititate a simple on chain spend.
    //
    // Currently used for testing but might be used elsewhere.
    pub fn get_unroll_target<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        use_unroll: &ChannelHandlerUnrollSpendInfo,
    ) -> Result<UnrollTarget, Error> {
        let curried_unroll_puzzle = use_unroll
            .coin
            .make_curried_unroll_puzzle(env, &self.get_aggregate_unroll_public_key())?;

        Ok(UnrollTarget {
            state_number: use_unroll.coin.state_number,
            unroll_puzzle_hash: Node(curried_unroll_puzzle).sha256tree(env.allocator),
            my_amount: self.my_out_of_game_balance.clone(),
            their_amount: self.their_out_of_game_balance.clone(),
        })
    }

    /// Find the first created coin whose puzzle hash matches our referee key.
    pub fn find_my_reward_coin<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        parent_coin: &CoinString,
        conditions: &[CoinCondition],
    ) -> Result<CoinString, Error> {
        let referee_public_key = private_to_public_key(&self.private_keys.my_referee_private_key);
        let referee_puzzle_hash = puzzle_hash_for_pk(env.allocator, &referee_public_key)?;
        let parent_coin_id = parent_coin.to_coin_id();

        conditions
            .iter()
            .find_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    if ph == &referee_puzzle_hash && amt > &Amount::default() {
                        return Some(CoinString::from_parts(&parent_coin_id, ph, amt));
                    }
                }
                None
            })
            .ok_or_else(|| Error::StrErr("no reward coin found for our puzzle hash".to_string()))
    }

    pub fn handle_reward_spends<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        coin_id: &CoinString,
        conditions: &[CoinCondition],
    ) -> Result<Option<SpendBundle>, Error> {
        let referee_public_key = private_to_public_key(&self.private_keys.my_referee_private_key);
        let referee_puzzle_hash = puzzle_hash_for_pk(env.allocator, &referee_public_key)?;
        let parent_coin_id = coin_id.to_coin_id();

        let pay_to_me: Vec<CoinString> = conditions
            .iter()
            .filter_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    if ph == &referee_puzzle_hash && amt > &Amount::default() {
                        return Some(CoinString::from_parts(&parent_coin_id, ph, amt));
                    }
                }

                None
            })
            .collect();

        if !pay_to_me.is_empty() {
            // Check for conditions that pay us
            let reward_puzzle_hash = self.get_reward_puzzle_hash(env)?;
            let spend_rewards = self.spend_reward_coins(env, &pay_to_me, &reward_puzzle_hash)?;
            return Ok(Some(SpendBundle {
                name: Some("spend reward".to_string()),
                spends: spend_rewards.coins_with_solutions,
            }));
        }

        Ok(None)
    }

    pub fn get_game_state_id<R: Rng>(&self, env: &mut ChannelHandlerEnv<R>) -> Result<Hash, Error> {
        // Each puzzle hash is typically 32 bytes; pre-allocate to avoid repeated growth.
        let mut bytes: Vec<u8> = Vec::with_capacity(self.live_games.len() * 32);
        for l in self.live_games.iter() {
            let ph = l.current_puzzle_hash(env.allocator)?;
            bytes.extend_from_slice(ph.bytes());
        }
        Ok(Sha256Input::Bytes(&bytes).hash())
    }
}
