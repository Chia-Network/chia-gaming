pub mod game;
pub mod game_handler;
pub mod runner;
pub mod types;
pub mod v1;

use std::cmp::Ordering;
use std::collections::HashMap;
use std::mem::swap;
use std::rc::Rc;

use log::debug;

use rand::prelude::*;

use clvm_traits::ToClvm;
use clvmr::allocator::NodePtr;

use crate::channel_handler::game_handler::TheirTurnResult;
use crate::channel_handler::types::{
    AcceptTransactionState, CachedPotatoRegenerateLastHop, ChannelCoin, ChannelCoinInfo,
    ChannelCoinSpendInfo, ChannelCoinSpentResult, ChannelHandlerEnv, ChannelHandlerInitiationData,
    ChannelHandlerInitiationResult, ChannelHandlerMoveResult, ChannelHandlerPrivateKeys,
    ChannelHandlerUnrollSpendInfo, CoinDataForReward, CoinSpentAccept, CoinSpentDisposition,
    CoinSpentInformation, CoinSpentMoveUp, CoinSpentResult, DispositionResult, GameStartFailed,
    GameStartInfo, GameStartInfoInterface, HandshakeResult, LiveGame, MoveResult, OnChainGameCoin,
    OnChainGameState, PotatoAcceptCachedData, PotatoMoveCachedData, PotatoSignatures, ReadableMove,
    StartGameResult, UnrollCoin, UnrollCoinConditionInputs, UnrollTarget,
};

use crate::common::constants::{CREATE_COIN, DEFAULT_HIDDEN_PUZZLE_HASH};
use crate::common::standard_coin::{
    calculate_synthetic_secret_key, private_to_public_key, puzzle_for_pk,
    puzzle_for_synthetic_public_key, puzzle_hash_for_pk, puzzle_hash_for_synthetic_public_key,
    standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{
    usize_from_atom, Aggsig, AllocEncoder, Amount, BrokenOutCoinSpendInfo, CoinCondition, CoinID,
    CoinSpend, CoinString, Error, GameID, GetCoinStringParts, Hash, IntoErr, Node, PrivateKey,
    Program, PublicKey, Puzzle, PuzzleHash, Sha256tree, Spend, SpendBundle, SpendRewardResult,
    Timeout,
};
use crate::potato_handler::types::GameAction;
use crate::referee::types::{GameMoveDetails, RefereeOnChainTransaction, TheirTurnCoinSpentResult};
use crate::referee::{RefereeInterface, RefereeMaker};

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
    #[allow(dead_code)]
    unroll_advance_timeout: Timeout,

    cached_last_action: Option<CachedPotatoRegenerateLastHop>,
    did_rewind: Option<CachedPotatoRegenerateLastHop>,

    // Has a parity between the two players of whether have_potato means odd
    // or even, but odd-ness = have-potato is arbitrary.
    current_state_number: usize, //
    // Increments per game started.
    next_nonce_number: usize,

    state_channel: ChannelCoinInfo,

    // If current unroll is not populated, the previous unroll contains the
    // info needed to unroll to the previous state on which we can replay our
    // most recent move.
    unroll: ChannelHandlerUnrollSpendInfo,
    timeout: Option<ChannelHandlerUnrollSpendInfo>,

    // Live games
    live_games: Vec<LiveGame>,
}

pub trait EnvDataForReferee {
    fn allocator(&mut self) -> &mut AllocEncoder;
    fn referee_puzzle_v0(&self) -> Puzzle;
    fn referee_puzzle_hash_v0(&self) -> PuzzleHash;
    fn referee_puzzle_v1(&self) -> Puzzle;
    fn referee_puzzle_hash_v1(&self) -> PuzzleHash;
    fn agg_sig_me_additional_data(&self) -> Hash;
}

impl<'a, R: Rng> EnvDataForReferee for ChannelHandlerEnv<'a, R> {
    fn allocator(&mut self) -> &mut AllocEncoder {
        self.allocator
    }
    fn referee_puzzle_v0(&self) -> Puzzle {
        self.referee_coin_puzzle.clone()
    }
    fn referee_puzzle_hash_v0(&self) -> PuzzleHash {
        self.referee_coin_puzzle_hash.clone()
    }
    fn referee_puzzle_v1(&self) -> Puzzle {
        self.referee_coin_puzzle_v1.clone()
    }
    fn referee_puzzle_hash_v1(&self) -> PuzzleHash {
        self.referee_coin_puzzle_hash_v1.clone()
    }
    fn agg_sig_me_additional_data(&self) -> Hash {
        self.agg_sig_me_additional_data.clone()
    }
}

pub trait MakeRefereeFromGameStart {
    fn make_referee(
        &self,
        env: &mut dyn EnvDataForReferee,
        my_identity: ChiaIdentity,
        their_puzzle_hash: &PuzzleHash,
        reward_puzzle_hash: &PuzzleHash,
        nonce: usize,
        state_number: usize,
    ) -> Result<(Rc<dyn RefereeInterface>, PuzzleHash), Error>;
}

impl MakeRefereeFromGameStart for GameStartInfo {
    fn make_referee(
        &self,
        env: &mut dyn EnvDataForReferee,
        my_identity: ChiaIdentity,
        their_puzzle_hash: &PuzzleHash,
        reward_puzzle_hash: &PuzzleHash,
        nonce: usize,
        state_number: usize,
    ) -> Result<(Rc<dyn RefereeInterface>, PuzzleHash), Error> {
        let ref_v0 = env.referee_puzzle_v0();
        let ref_ph_v0 = env.referee_puzzle_hash_v0();
        let agg_sig_me = env.agg_sig_me_additional_data();
        let (r, ph) = RefereeMaker::new(
            env.allocator(),
            ref_v0,
            ref_ph_v0,
            self,
            my_identity,
            their_puzzle_hash,
            reward_puzzle_hash,
            nonce,
            &agg_sig_me,
            state_number,
        )?;
        Ok((Rc::new(r), ph))
    }
}

impl MakeRefereeFromGameStart for v1::game_start_info::GameStartInfo {
    fn make_referee(
        &self,
        env: &mut dyn EnvDataForReferee,
        my_identity: ChiaIdentity,
        their_puzzle_hash: &PuzzleHash,
        reward_puzzle_hash: &PuzzleHash,
        nonce: usize,
        state_number: usize,
    ) -> Result<(Rc<dyn RefereeInterface>, PuzzleHash), Error> {
        let ref_v1 = env.referee_puzzle_v1();
        let ref_ph_v1 = env.referee_puzzle_hash_v1();
        let agg_sig_me = env.agg_sig_me_additional_data();
        let (r, ph) = crate::referee::v1::RefereeMaker::new(
            env.allocator(),
            ref_v1,
            ref_ph_v1,
            self,
            my_identity,
            their_puzzle_hash,
            reward_puzzle_hash,
            nonce,
            &agg_sig_me,
            state_number,
        )?;
        Ok((Rc::new(r), ph))
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

    pub fn all_games_finished(&self) -> bool {
        self.live_games.is_empty()
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
            debug!("cached game id {game_id:?}");
            if let Ok(idx) = self.get_game_by_id(game_id) {
                debug!("delete old matching game {idx}");
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
        };
        debug!("computed unroll inputs {inputs:?}");
        inputs
    }

    pub fn state_channel_coin(&self) -> &ChannelCoin {
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

    pub fn create_conditions_and_signature_of_channel_coin<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        unroll_coin: &UnrollCoin,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        let unroll_coin_parent = self.state_channel_coin();
        unroll_coin_parent.get_solution_and_signature(
            env,
            &self.private_keys.my_channel_coin_private_key,
            &self.get_aggregate_channel_public_key(),
            &self.get_aggregate_unroll_public_key(),
            &self.state_channel.amount,
            unroll_coin,
        )
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
        initiation: &ChannelHandlerInitiationData,
    ) -> Result<(Self, ChannelHandlerInitiationResult), Error> {
        let our_channel_pubkey = private_to_public_key(&private_keys.my_channel_coin_private_key);
        let our_unroll_pubkey = private_to_public_key(&private_keys.my_unroll_coin_private_key);
        if initiation.their_channel_pubkey == our_channel_pubkey {
            return Err(Error::Channel(
                "Duplicated channel coin public key".to_string(),
            ));
        }

        if initiation.their_unroll_pubkey == our_unroll_pubkey {
            return Err(Error::Channel(
                "Duplicated unroll coin public key".to_string(),
            ));
        }

        let aggregate_public_key =
            our_channel_pubkey.clone() + initiation.their_channel_pubkey.clone();
        debug!(
            "construct channel handler {}",
            initiation.we_start_with_potato
        );
        debug!("aggregate public key {aggregate_public_key:?}");
        debug!("our unroll public key {our_unroll_pubkey:?}");
        debug!(
            "their unroll public key {:?}",
            initiation.their_unroll_pubkey
        );

        let state_channel_coin_puzzle_hash =
            puzzle_hash_for_synthetic_public_key(env.allocator, &aggregate_public_key)?;
        let amount = initiation.my_contribution.clone() + initiation.their_contribution.clone();
        let channel_coin_parent = CoinString::from_parts(
            &initiation.launcher_coin_id,
            &state_channel_coin_puzzle_hash,
            &amount,
        );

        let mut myself = ChannelHandler {
            their_channel_coin_public_key: initiation.their_channel_pubkey.clone(),
            their_unroll_coin_public_key: initiation.their_unroll_pubkey.clone(),
            their_referee_puzzle_hash: initiation.their_referee_puzzle_hash.clone(),
            their_reward_puzzle_hash: initiation.their_reward_puzzle_hash.clone(),
            my_out_of_game_balance: initiation.my_contribution.clone(),
            their_out_of_game_balance: initiation.their_contribution.clone(),
            unroll_advance_timeout: initiation.unroll_advance_timeout.clone(),
            reward_puzzle_hash: initiation.reward_puzzle_hash.clone(),

            my_allocated_balance: Amount::default(),
            their_allocated_balance: Amount::default(),

            have_potato: initiation.we_start_with_potato,
            initiated_on_chain: false,
            on_chain_for_error: false,

            cached_last_action: None,
            did_rewind: None,

            current_state_number: 0,
            next_nonce_number: 0,

            state_channel: ChannelCoinInfo {
                coin: ChannelCoin::new(channel_coin_parent),
                amount,
                spend: Spend::default(),
            },

            unroll: ChannelHandlerUnrollSpendInfo::default(),
            timeout: None,

            live_games: Vec::new(),

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
            myself.my_out_of_game_balance.clone() - myself.my_allocated_balance.clone(),
            myself.their_out_of_game_balance.clone() - myself.their_allocated_balance.clone(),
            &[],
        );
        myself.unroll.coin.update(
            env,
            &myself.private_keys.my_unroll_coin_private_key,
            &myself.their_unroll_coin_public_key,
            // XXX might need to mutate slightly.
            &inputs,
        )?;
        myself.current_state_number += 1;

        let channel_coin_spend =
            myself.create_conditions_and_signature_of_channel_coin(env, &myself.unroll.coin)?;

        myself.state_channel.spend = Spend {
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

        debug!("finish_handshake");
        let channel_coin_spend =
            self.create_conditions_and_signature_of_channel_coin(env, &self.unroll.coin)?;

        debug!("their sig {:?}", their_initial_channel_half_signature);
        let combined_signature =
            channel_coin_spend.signature.clone() + their_initial_channel_half_signature.clone();
        debug!("combined signature {combined_signature:?}");

        let state_channel_puzzle = puzzle_for_synthetic_public_key(
            env.allocator,
            &env.standard_puzzle,
            &aggregate_public_key,
        )?;
        debug!(
            "puzzle hash for state channel coin (ch) {:?}",
            state_channel_puzzle.sha256tree(env.allocator)
        );

        Ok(HandshakeResult {
            channel_puzzle_reveal: state_channel_puzzle,
            amount: self.state_channel.amount.clone(),
            spend: ChannelCoinSpendInfo {
                aggsig: combined_signature,
                solution: channel_coin_spend.solution.p(),
                conditions: channel_coin_spend.conditions.p(),
            },
        })
    }

    fn compute_game_coin_unroll_data<'a>(
        &'a self,
        unroll_coin: Option<&CoinID>,
        skip_game: &[GameID],
        skip_coin_id: Option<&GameID>,
        games: &'a [LiveGame],
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

        if self.my_allocated_balance > self.my_out_of_game_balance
            || self.their_allocated_balance > self.their_out_of_game_balance
        {
            return Err(Error::StrErr("not enough money".to_string()));
        }

        let unroll_inputs = self.unroll_coin_condition_inputs(
            self.my_out_of_game_balance.clone() - self.my_allocated_balance.clone(),
            self.their_out_of_game_balance.clone() - self.their_allocated_balance.clone(),
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
        let spend = self.state_channel_coin();
        let channel_coin_spend = spend.get_solution_and_signature_from_conditions(
            env,
            &self.private_keys.my_channel_coin_private_key,
            &aggregate_public_key,
            conditions,
        )?;

        let full_signature =
            channel_coin_spend.signature.clone() + their_channel_half_signature.clone();
        debug!("combined signature {full_signature:?}");
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
        // Unroll coin section.
        let mut test_unroll = self.unroll.coin.clone();
        test_unroll.state_number = self.current_state_number + 1;
        test_unroll.update(
            env,
            &self.private_keys.my_unroll_coin_private_key,
            &self.their_unroll_coin_public_key,
            inputs,
        )?;
        debug!(
            "verify: started with potato: {}",
            test_unroll.started_with_potato
        );

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
        debug!("current state number now {}", self.current_state_number);
        debug!("test_unroll updated {:?}", test_unroll.outcome);
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
                self.my_out_of_game_balance.clone() - self.my_allocated_balance.clone(),
                self.their_out_of_game_balance.clone() - self.their_allocated_balance.clone(),
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

            let (referee_maker, puzzle_hash) = g.make_referee(
                env,
                referee_identity,
                &self.their_referee_puzzle_hash,
                &self.reward_puzzle_hash,
                new_game_nonce,
                self.current_state_number,
            )?;
            res.push(LiveGame::new(
                g.game_id().clone(),
                puzzle_hash,
                referee_maker,
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
        debug!("{} SEND POTATO START GAME", self.is_initial_potato());
        let (my_full_contribution, their_full_contribution) =
            self.start_game_contributions(start_info_list);

        debug!(
            "send potato start game: me {my_full_contribution:?} then {their_full_contribution:?}"
        );

        if my_full_contribution > self.my_out_of_game_balance
            || their_full_contribution > self.their_out_of_game_balance
        {
            return Ok(StartGameResult::Failure(GameStartFailed::OutOfMoney));
        }

        self.clear_cached_game_id_for_send();
        let live_game_ids: Vec<&GameID> = self.live_games.iter().map(|l| &l.game_id).collect();
        debug!("current game ids: {live_game_ids:?}");

        // We let them spend a state number 1 higher but nothing else changes.
        self.update_cache_for_potato_send(Some(CachedPotatoRegenerateLastHop::PotatoCreatedGame(
            start_info_list
                .iter()
                .map(|g| g.game_id().clone())
                .collect(),
            my_full_contribution.clone(),
            their_full_contribution.clone(),
        )));

        debug!(
            "send: started with potato: {}",
            self.unroll.coin.started_with_potato
        );

        debug!("before adding games: {} games", self.live_games.len());
        let mut new_games = self.add_games(env, start_info_list)?;
        self.live_games.append(&mut new_games);
        debug!("after adding games: {} games", self.live_games.len());

        self.my_allocated_balance += my_full_contribution;
        self.their_allocated_balance += their_full_contribution;

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
        debug!(
            "{} RECEIVED_POTATO_START_GAME: our state is {}, unroll state is {}",
            self.is_initial_potato(),
            self.current_state_number,
            self.unroll.coin.state_number
        );
        let mut new_games = self.add_games(env, start_info_list)?;
        let result_game_ids: Vec<GameID> = new_games.iter().map(|g| &g.game_id).cloned().collect();

        let (my_full_contribution, their_full_contribution) =
            self.start_game_contributions(start_info_list);

        debug!(
            "recv potato start game: me {my_full_contribution:?} then {their_full_contribution:?}"
        );

        self.my_allocated_balance += my_full_contribution;
        self.their_allocated_balance += their_full_contribution;

        // Make a list of all game outputs in order.
        let cached_game_ids = self
            .get_cached_game_id()
            .map(|g| vec![g.clone()])
            .unwrap_or_default();
        debug!("taking into account cached game ids when doing receive_potato_start_games: {cached_game_ids:?}");
        let mut unroll_data_for_all_games =
            self.compute_unroll_data_for_games(&cached_game_ids, None, &self.live_games)?;
        debug!("start with {} games", unroll_data_for_all_games.len());
        unroll_data_for_all_games.append(&mut self.compute_unroll_data_for_games(
            &[],
            None,
            &new_games,
        )?);

        debug!(
            "existing games {} new games {} total games {}",
            self.live_games.len(),
            new_games.len(),
            unroll_data_for_all_games.len()
        );
        for n in new_games.iter() {
            debug!("received game id {:?}", n.game_id);
        }

        // Update an unroll coin to see if we can verify the message.
        debug!(
            "aggregate state channel public key {:?}",
            self.get_aggregate_channel_public_key()
        );
        let spend = self.received_potato_verify_signatures(
            env,
            signatures,
            &self.unroll_coin_condition_inputs(
                self.my_out_of_game_balance.clone() - self.my_allocated_balance.clone(),
                self.their_out_of_game_balance.clone() - self.their_allocated_balance.clone(),
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
                debug!("nonexistent game id {game_id:?}");
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
        debug!(
            "{} SEND_POTATO_MOVE {}",
            self.is_initial_potato(),
            self.current_state_number
        );
        let game_idx = self.get_game_by_id(game_id)?;
        let match_puzzle_hash = self.live_games[game_idx].current_puzzle_hash(env.allocator)?;

        let referee_result = self.live_games[game_idx].internal_make_move(
            env.allocator,
            readable_move,
            new_entropy.clone(),
            self.current_state_number,
        )?;

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
            referee_result.puzzle_hash_for_unroll.clone();

        debug!(
            "{} move_result {referee_result:?}",
            self.unroll.coin.started_with_potato
        );
        let puzzle_hash = referee_result.puzzle_hash_for_unroll;
        let amount = referee_result.details.basic.mover_share.clone();

        // We let them spend a state number 1 higher but nothing else changes.
        self.update_cache_for_potato_send(Some(
            CachedPotatoRegenerateLastHop::PotatoMoveHappening(Rc::new(PotatoMoveCachedData {
                state_number: self.current_state_number,
                game_id: game_id.clone(),
                match_puzzle_hash,
                puzzle_hash,
                move_data: readable_move.clone(),
                move_entropy: new_entropy,
                amount,
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
        debug!(
            "{} RECEIVED_POTATO_MOVE {}",
            self.is_initial_potato(),
            self.current_state_number,
        );
        let game_idx = self.get_game_by_id(game_id)?;

        // Not used along this route, but provided.
        let coin_string = self.state_channel_coin().coin_string().clone();
        let their_move_result = self.live_games[game_idx].internal_their_move(
            env.allocator,
            &move_result.game_move,
            self.current_state_number,
            Some(&coin_string),
        )?;

        debug!(
            "{} their_move_result {their_move_result:?}",
            self.unroll.coin.started_with_potato
        );
        debug!(
            "{} my share after their move {:?}",
            self.unroll.coin.started_with_potato,
            self.live_games[game_idx].get_our_current_share()
        );

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
                return Err(Error::StrErr(
                    "slash when off chain: go on chain".to_string(),
                ));
            }
        };

        let unroll_data = self.compute_unroll_data_for_games(&[], None, &self.live_games)?;

        let spend = self.received_potato_verify_signatures(
            env,
            &move_result.signatures,
            &self.unroll_coin_condition_inputs(
                self.my_out_of_game_balance.clone() - self.my_allocated_balance.clone(),
                self.their_out_of_game_balance.clone() - self.their_allocated_balance.clone(),
                &unroll_data,
            ),
        )?;

        // Needs to know their puzzle_hash_for_unroll so we can keep it to do
        // the unroll spend.

        // Check whether the unroll_puzzle_hash is right.
        // Check whether the spend signed in the Move Result is valid by using
        // the unroll puzzle hash that was given to us.
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
        debug!("{} SEND_POTATO_ACCEPT", self.is_initial_potato());
        let game_idx = self.get_game_by_id(game_id)?;

        // referee maker is removed and will be destroyed when we leave this
        // function.
        let live_game = self.live_games.remove(game_idx);
        self.my_allocated_balance -= live_game.my_contribution.clone();
        self.their_allocated_balance -= live_game.their_contribution.clone();

        let amount = live_game.get_our_current_share();
        let at_stake = live_game.get_amount();

        self.my_out_of_game_balance -= live_game.my_contribution.clone();
        self.my_out_of_game_balance += amount.clone();
        self.their_out_of_game_balance -= live_game.their_contribution.clone();
        self.their_out_of_game_balance += at_stake.clone() - amount.clone();

        debug!(
            "accept: my_allocated {:?} their_allocated {:?} my_balance {:?} their_balance {:?}",
            self.my_allocated_balance,
            self.their_allocated_balance,
            self.my_out_of_game_balance,
            self.their_out_of_game_balance
        );

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
        debug!("{} RECEIVED_POTATO_ACCEPT", self.is_initial_potato());
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

        debug!("received potato accept, my share {game_amount_for_me:?}");
        let new_my_allocated =
            self.my_allocated_balance.clone() - self.live_games[game_idx].my_contribution.clone();
        let new_their_allocated = self.their_allocated_balance.clone()
            - self.live_games[game_idx].their_contribution.clone();
        let my_balance = self.my_out_of_game_balance.clone()
            - self.live_games[game_idx].my_contribution.clone()
            + game_amount_for_me;
        let their_balance = self.their_out_of_game_balance.clone()
            - self.live_games[game_idx].their_contribution.clone()
            + game_amount_for_them;

        debug!(
            "accept: my_allocated {:?} their_allocated {:?} my_balance {:?} their_balance {:?}",
            new_my_allocated, new_their_allocated, my_balance, their_balance
        );

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

        self.live_games.remove(game_idx);

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
        let channel_coin_spend = spend.get_solution_and_signature_from_conditions(
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
        debug!("{} SEND_POTATO_CLEAN_SHUTDOWN", self.is_initial_potato());
        assert!(self.have_potato);
        let aggregate_public_key = self.get_aggregate_channel_public_key();
        let spend = self.state_channel_coin();

        let conditions_program = Program::from_nodeptr(env.allocator, conditions)?;
        debug!("conditions {conditions_program:?}");
        let channel_coin_spend = spend.get_solution_and_signature_from_conditions(
            env,
            &self.private_keys.my_channel_coin_private_key,
            &aggregate_public_key,
            Rc::new(conditions_program),
        )?;

        debug!(
            "send_potato_clean_shutdown {:?}",
            channel_coin_spend.solution
        );

        Ok(Spend {
            solution: channel_coin_spend.solution.clone(),
            signature: channel_coin_spend.signature,
            puzzle: puzzle_for_pk(env.allocator, &aggregate_public_key)?,
        })
    }

    pub fn received_potato_clean_shutdown<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        their_channel_half_signature: &Aggsig,
        conditions: NodePtr,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        debug!(
            "{} RECEIVED_POTATO_CLEAN_SHUTDOWN",
            self.is_initial_potato()
        );
        assert!(!self.have_potato);
        let conditions_program = Program::from_nodeptr(env.allocator, conditions)?;
        debug!("conditions {conditions_program:?}");
        let channel_spend = self.verify_channel_coin_from_peer_signatures(
            env,
            their_channel_half_signature,
            Rc::new(conditions_program),
        )?;

        debug!(
            "received_potato_clean_shutdown {:?}",
            channel_spend.solution
        );

        Ok(channel_spend)
    }

    fn break_out_conditions_for_spent_coin<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        conditions: NodePtr,
    ) -> Result<Vec<Vec<u8>>, Error> {
        // Figure out our state number vs the one given in conditions.
        let all_conditions = CoinCondition::from_nodeptr(env.allocator, conditions);
        debug!("all_conditions {all_conditions:?}");
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

        debug!("channel handler at {}", self.current_state_number);

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

        debug!(
            "get_unroll_coin_transaction {:?}",
            solution_program.to_hex()
        );
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
        let full_coin = self.get_unroll_coin();

        let unrolling_state_number = usize_from_atom(&rem_conditions[0])
            .ok_or_else(|| Error::StrErr("Unconvertible state number".to_string()))?;

        let our_parity = full_coin.coin.state_number & 1;
        let their_parity = unrolling_state_number & 1;

        debug!(
            "{} CHANNEL COIN SPENT: myself {myself} initiated {} my state {} coin state {} channel coin state {unrolling_state_number}",
            self.unroll.coin.started_with_potato,
            self.initiated_on_chain,
            self.current_state_number,
            full_coin.coin.state_number
        );

        // investigate
        match (
            myself,
            unrolling_state_number.cmp(&self.current_state_number),
        ) {
            (true, _) | (_, Ordering::Equal) => {
                // Timeout
                let curried_unroll_puzzle = self
                    .unroll
                    .coin
                    .make_curried_unroll_puzzle(env, &self.get_aggregate_unroll_public_key())?;
                let unroll_puzzle_solution = self
                    .unroll
                    .coin
                    .make_unroll_puzzle_solution(env, &self.get_aggregate_unroll_public_key())?;

                Ok(ChannelCoinSpentResult {
                    transaction: Spend {
                        puzzle: Puzzle::from_nodeptr(env.allocator, curried_unroll_puzzle)?,
                        solution: Program::from_nodeptr(env.allocator, unroll_puzzle_solution)?
                            .into(),
                        signature: self.unroll.coin.get_unroll_coin_signature()?,
                    },
                    timeout: true,
                    games_canceled: self.get_just_created_games(),
                })
            }
            (_, Ordering::Greater) => Err(Error::StrErr(format!(
                "Reply from the future onchain {} (me {}) vs {}",
                unrolling_state_number, self.current_state_number, full_coin.coin.state_number
            ))),
            (_, Ordering::Less) => {
                if our_parity == their_parity {
                    return Err(Error::StrErr(
                        "We're superceding ourselves from the past?".to_string(),
                    ));
                }

                self.get_create_unroll_coin_transaction(env, full_coin, true)
            }
        }
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
        let parent_coin = self.state_channel_coin().coin_string();
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
    pub fn set_state_for_coins<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        unroll_coin: &CoinString,
        coins: &[PuzzleHash],
    ) -> Result<HashMap<CoinString, OnChainGameState>, Error> {
        let mut res = HashMap::new();
        let initial_potato = self.is_initial_potato();

        swap(&mut self.did_rewind, &mut self.cached_last_action);

        debug!(
            "{initial_potato} ALIGN GAME STATES: initiated {} my state {} coin state {}",
            self.initiated_on_chain, self.current_state_number, self.unroll.coin.state_number,
        );

        debug!("{initial_potato} cached state {:?}", self.did_rewind);
        debug!("{initial_potato} #game coins {}", coins.len());

        let mover_puzzle_hash = private_to_public_key(&self.referee_private_key());
        for game_coin in coins.iter() {
            if let Some(CachedPotatoRegenerateLastHop::PotatoAccept(cached)) = &self.did_rewind {
                if *game_coin == cached.puzzle_hash {
                    let coin_id = CoinString::from_parts(
                        &unroll_coin.to_coin_id(),
                        &game_coin.clone(),
                        &cached.live_game.get_amount(),
                    );
                    debug!("{initial_potato} set coin for accept");
                    res.insert(
                        coin_id,
                        OnChainGameState {
                            game_id: cached.live_game.game_id.clone(),
                            puzzle_hash: game_coin.clone(),
                            our_turn: cached.live_game.is_my_turn(),
                            state_number: self.current_state_number,
                            accept: AcceptTransactionState::Waiting,
                        },
                    );
                    continue;
                }
            }

            for live_game in self.live_games.iter_mut() {
                debug!(
                    "live game id {:?} try to use coin {game_coin:?}",
                    live_game.game_id
                );
                let coin_id = CoinString::from_parts(
                    &unroll_coin.to_coin_id(),
                    &game_coin.clone(),
                    &live_game.get_amount(),
                );

                let rewind_target = live_game.set_state_for_coin(
                    env.allocator,
                    &coin_id,
                    game_coin,
                    self.current_state_number,
                )?;

                if let Some(rewind_state) = rewind_target.state_number {
                    debug!("{} rewind target state was {rewind_state}", initial_potato);
                    debug!("mover puzzle hash is {:?}", mover_puzzle_hash);
                    debug!(
                        "{initial_potato} new game coin {coin_id:?} for game_id {:?}",
                        live_game.game_id
                    );
                    res.insert(
                        coin_id,
                        OnChainGameState {
                            game_id: live_game.game_id.clone(),
                            puzzle_hash: game_coin.clone(),
                            our_turn: live_game.is_my_turn(),
                            state_number: self.current_state_number,
                            accept: AcceptTransactionState::Waiting,
                        },
                    );
                }
            }
        }

        // assert_eq!(res.is_empty(), coins.is_empty());

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
        debug!(
            "{} ON CHAIN OUR MOVE {:?} {:?} {:?}",
            self.is_initial_potato(),
            readable_move,
            entropy,
            existing_coin
        );
        let game_idx = self.get_game_by_id(game_id)?;

        let last_puzzle_hash = self.live_games[game_idx].last_puzzle_hash();
        let start_puzzle_hash = self.live_games[game_idx].current_puzzle_hash(env.allocator)?;
        let end_puzzle_hash = self.live_games[game_idx].outcome_puzzle_hash(env.allocator)?;

        debug!("last puzzle hash {last_puzzle_hash:?}");
        debug!("start puzzle hash {start_puzzle_hash:?}");
        debug!("outcome puzzle hash {end_puzzle_hash:?}");

        // assert_eq!(start_puzzle_hash, existing_ph);

        debug!(
            "on chain our turn {} processing our turn {}",
            self.live_games[game_idx].is_my_turn(),
            self.live_games[game_idx].processing_my_turn()
        );

        // assert_eq!(self.game_is_my_turn(game_id), Some(true));
        let move_result = self.live_games[game_idx].internal_make_move(
            env.allocator,
            readable_move,
            entropy,
            self.current_state_number,
        )?;
        debug!(
            "{} move_result {move_result:?}",
            self.unroll.coin.started_with_potato
        );

        let tx = self.live_games[game_idx].get_transaction_for_move(
            env.allocator,
            existing_coin,
            true,
        )?;

        Ok((
            last_puzzle_hash,
            self.live_games[game_idx].outcome_puzzle_hash(env.allocator)?,
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
        debug!(
            "{} GAME COIN SPENT {:?} {:?} {:?}",
            self.is_initial_potato(),
            coin_string,
            conditions,
            self.game_is_my_turn(game_id)
        );

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
            debug!("was our turn, reward {ph:?} {amt:?}");
            return Ok(CoinSpentInformation::OurReward(ph.clone(), amt.clone()));
        }

        let live_game_idx = self.get_game_by_id(game_id)?;
        let spent_result = self.live_games[live_game_idx].their_turn_coin_spent(
            env.allocator,
            coin_string,
            conditions,
            self.current_state_number,
        )?;
        if let Some(CachedPotatoRegenerateLastHop::PotatoMoveHappening(move_data)) =
            &self.did_rewind
        {
            if let TheirTurnCoinSpentResult::Expected(state_number, ph, amt, _) = &spent_result {
                return Ok(CoinSpentInformation::TheirSpend(
                    TheirTurnCoinSpentResult::Expected(
                        *state_number,
                        ph.clone(),
                        amt.clone(),
                        Some(move_data.clone()),
                    ),
                ));
            }
        }

        Ok(CoinSpentInformation::TheirSpend(spent_result))
    }

    fn get_redo_result<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        cla: &mut Option<CachedPotatoRegenerateLastHop>,
        coin: &CoinString,
    ) -> Result<Option<GameAction>, Error> {
        match cla {
            Some(CachedPotatoRegenerateLastHop::PotatoCreatedGame(
                ids,
                my_contrib,
                their_contrib,
            )) => {
                // Can't restart games on chain so rewind.
                self.my_allocated_balance -= my_contrib.clone();
                self.their_allocated_balance -= their_contrib.clone();
                let remove_ids: Vec<usize> = self
                    .live_games
                    .iter()
                    .enumerate()
                    .filter_map(|(i, g)| {
                        if ids.contains(&g.game_id) {
                            Some(i)
                        } else {
                            None
                        }
                    })
                    .collect();
                for id in remove_ids.into_iter() {
                    self.live_games.remove(id);
                }
                Ok(None)
            }
            Some(CachedPotatoRegenerateLastHop::PotatoAccept(ref mut accept)) => {
                debug!("{} redo move is an accept", self.is_initial_potato());
                let transaction = accept
                    .live_game
                    .get_transaction_for_timeout(env.allocator, coin)?;

                debug!("{} redo accept data {accept:?}", self.is_initial_potato());
                let outcome_puzzle_hash = accept.live_game.outcome_puzzle_hash(env.allocator)?;
                Ok(transaction.map(|t| {
                    GameAction::RedoAccept(
                        accept.live_game.game_id.clone(),
                        coin.clone(),
                        outcome_puzzle_hash,
                        Box::new(t),
                    )
                }))
            }
            Some(CachedPotatoRegenerateLastHop::PotatoMoveHappening(move_data)) => {
                let game_idx = self.get_game_by_id(&move_data.game_id)?;
                debug!(
                    "{} have cached move {move_data:?}",
                    self.is_initial_potato()
                );
                debug!(
                    "redo if move matches puzzle hash {:?}",
                    move_data.match_puzzle_hash
                );
                debug!("redo for coin {coin:?}");

                if let Some(rwo) = self.live_games[game_idx].get_rewind_outcome() {
                    if let Some(transaction) = rwo.transaction.as_ref() {
                        if rwo.version == 0 {
                            debug!("{} redo move data {move_data:?}", self.is_initial_potato());
                            return Ok(Some(GameAction::RedoMoveV0(
                                move_data.game_id.clone(),
                                coin.clone(),
                                rwo.outcome_puzzle_hash.clone(),
                                Box::new(transaction.clone()),
                            )));
                        } else {
                            return Ok(Some(GameAction::RedoMoveV1(
                                coin.clone(),
                                rwo.outcome_puzzle_hash.clone(),
                                Box::new(transaction.clone()),
                                None,
                                self.live_games[game_idx].get_amount(),
                            )));
                        }
                    }
                }

                Ok(None)
            }
            _ => Ok(None),
        }
    }

    pub fn get_redo_action<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        coin: &CoinString,
    ) -> Result<Option<GameAction>, Error> {
        debug!(
            "{} GET REDO ACTION {} vs {}",
            self.is_initial_potato(),
            self.current_state_number,
            self.unroll.coin.state_number
        );

        // We're on chain due to error.
        let mut cla = None;
        swap(&mut cla, &mut self.did_rewind);

        let result = self.get_redo_result(env, &mut cla, coin);

        swap(&mut cla, &mut self.did_rewind);

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
            // Game is done one way or another.
            self.live_games.remove(game_idx);
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
        let mut exploded_coins = Vec::new();
        let referee_pk = private_to_public_key(&self.referee_private_key());
        let referee_puzzle_hash = puzzle_hash_for_pk(env.allocator, &referee_pk)?;

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

        let mut coins_with_solutions = Vec::default();
        let default_hidden_puzzle_hash = Hash::from_bytes(DEFAULT_HIDDEN_PUZZLE_HASH);
        let synthetic_referee_private_key = calculate_synthetic_secret_key(
            &self.private_keys.my_referee_private_key,
            &default_hidden_puzzle_hash,
        )?;
        let my_referee_public_key =
            private_to_public_key(&self.private_keys.my_referee_private_key);
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

    pub fn handle_reward_spends<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        coin_id: &CoinString,
        conditions: &[CoinCondition],
    ) -> Result<Option<SpendBundle>, Error> {
        let referee_private_key = self.referee_private_key();
        let referee_public_key = private_to_public_key(&referee_private_key);
        let referee_puzzle_hash = puzzle_hash_for_pk(env.allocator, &referee_public_key)?;

        let pay_to_me: Vec<CoinString> = conditions
            .iter()
            .filter_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    if ph == &referee_puzzle_hash && amt > &Amount::default() {
                        return Some(CoinString::from_parts(&coin_id.to_coin_id(), ph, amt));
                    }
                }

                None
            })
            .collect();

        if !pay_to_me.is_empty() {
            debug!("handle rewards {conditions:?} output {pay_to_me:?}");
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
}
