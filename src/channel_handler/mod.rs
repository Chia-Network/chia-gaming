pub mod game;
pub mod game_handler;
pub mod game_start_info;
pub mod runner;
pub mod types;

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;

use serde::{Deserialize, Serialize};

use crate::channel_handler::game_start_info::GameStartInfo;
use crate::channel_handler::types::{
    AcceptTransactionState, CachedPotatoRegenerateLastHop, ChannelCoinSpendInfo,
    ChannelCoinSpentResult, ChannelHandlerEnv, ChannelHandlerInitiationResult,
    ChannelHandlerMoveResult, ChannelHandlerPrivateKeys, ChannelHandlerUnrollSpendInfo,
    CoinSpentInformation, HandshakeResult, LiveGame, MoveResult, OnChainGameCoin, OnChainGameState,
    PotatoAcceptTimeoutCachedData, PotatoMoveCachedData, PotatoSignatures, ProposedGame,
    ReadableMove, UnrollCoin, UnrollCoinConditionInputs,
};

use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    private_to_public_key, puzzle_for_pk, puzzle_for_synthetic_public_key,
    puzzle_hash_for_synthetic_public_key, standard_solution_partial, ChiaIdentity,
};
use crate::common::types::Sha256Input;
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, BrokenOutCoinSpendInfo, CoinCondition, CoinID, CoinSpend,
    CoinString, Error, GameID, Hash, IntoErr, Node, PrivateKey, Program, PublicKey, Puzzle,
    PuzzleHash, Sha256tree, Spend, Timeout,
};
use crate::referee::types::{GameMoveDetails, TheirTurnCoinSpentResult};
use crate::referee::Referee;

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
/// Conditions that the unroll coin makes needs a rem to ensure that we know
/// the latest game state number.
///
/// Needs to be a code path by which they took an old potato and put it on chain.
///
/// Brass tacks about turn polarity:
///
/// If we made a move and never got a reply, the latest thing that can be signed
/// onto the chain is the most recent 'their move'.  We preserve the ability to
/// recall and sign this move via `latest_sent_unroll` and `latest_received_unroll`
/// which are updated when we send/receive a potato.
#[derive(Clone, Serialize, Deserialize)]
pub struct ChannelHandler {
    private_keys: ChannelHandlerPrivateKeys,

    their_channel_coin_public_key: PublicKey,
    their_unroll_coin_public_key: PublicKey,
    their_referee_pubkey: PublicKey,
    their_reward_puzzle_hash: PuzzleHash,
    their_reward_payout_signature: Aggsig,
    reward_puzzle_hash: PuzzleHash,

    my_out_of_game_balance: Amount,
    their_out_of_game_balance: Amount,

    my_allocated_balance: Amount,
    their_allocated_balance: Amount,

    have_potato: bool,

    // Specifies the time lock that should be used in the unroll coin's conditions.
    unroll_advance_timeout: Timeout,

    cached_last_actions: Vec<CachedPotatoRegenerateLastHop>,

    // Latest potato number. Incremented on every send and receive.
    state_number: usize,
    // Role-namespaced nonces for game proposals.  Initiator uses even
    // values (0, 2, 4, …), responder uses odd (1, 3, 5, …).  The nonce
    // doubles as the GameID.
    my_next_nonce: u64,
    their_next_nonce: u64,

    state_channel: CoinSpend,

    // If current unroll is not populated, the previous unroll contains the
    // info needed to unroll to the previous state on which we can replay our
    // most recent move.
    latest_sent_unroll: ChannelHandlerUnrollSpendInfo,
    latest_received_unroll: Option<ChannelHandlerUnrollSpendInfo>,

    // Maps unroll_puzzle_hash → full unroll spend info for every state we've
    // sent the opponent.  They can broadcast any of these, so we keep all of
    // them to identify on-chain unroll coins and construct timeout spends.
    unroll_puzzle_hash_map: HashMap<PuzzleHash, ChannelHandlerUnrollSpendInfo>,

    // Live games
    live_games: Vec<LiveGame>,

    // Games removed by send_accept_timeout_no_finalize / apply_received_accept_timeout that
    // haven't been confirmed by a full potato round-trip yet.  Kept so
    // set_state_for_coins and accept_or_timeout_game_on_chain can find them
    // if the channel goes on-chain before the round-trip completes.
    pending_accept_timeouts: Vec<LiveGame>,
    // Games that have been proposed but not yet accepted or cancelled.
    // These are metadata only — they do not affect the unroll commitment
    // or player balances until accepted.
    proposed_games: Vec<ProposedGame>,
}

impl ChannelHandler {
    pub fn is_initial_potato(&self) -> bool {
        self.latest_sent_unroll.coin.started_with_potato
    }

    pub fn channel_private_key(&self) -> PrivateKey {
        self.private_keys.my_channel_coin_private_key.clone()
    }

    pub fn unroll_private_key(&self) -> PrivateKey {
        self.private_keys.my_unroll_coin_private_key.clone()
    }

    pub fn allocate_my_nonce(&mut self) -> u64 {
        let n = self.my_next_nonce;
        self.my_next_nonce += 2;
        n
    }

    pub fn is_our_nonce_parity(&self, game_id: &GameID) -> bool {
        game_id.0 % 2 == self.my_next_nonce % 2
    }

    pub fn state_number(&self) -> usize {
        self.state_number
    }

    pub fn timeout_state_number(&self) -> Option<usize> {
        self.latest_received_unroll
            .as_ref()
            .map(|t| t.coin.state_number)
    }

    pub fn have_potato(&self) -> bool {
        self.have_potato
    }

    /// Corrupt the channel handler's view of state for testing unrecoverable
    /// unroll edge cases.  Sets `state_number` and `latest_sent_unroll.coin.state_number`
    /// to `new_sn`, and clears `latest_received_unroll` and the puzzle hash map so
    /// that `get_unroll_for_state` won't find the real on-chain state.
    #[cfg(test)]
    pub fn corrupt_state_for_testing(&mut self, new_sn: usize) {
        self.state_number = new_sn;
        self.latest_sent_unroll.coin.state_number = new_sn;
        self.latest_sent_unroll.signatures = Default::default();
        self.latest_received_unroll = None;
        self.unroll_puzzle_hash_map.clear();
    }

    pub fn live_game_ids(&self) -> Vec<GameID> {
        self.live_games.iter().map(|g| g.game_id).collect()
    }

    pub fn all_game_ids(&self) -> Vec<GameID> {
        self.live_games
            .iter()
            .chain(self.pending_accept_timeouts.iter())
            .map(|g| g.game_id)
            .collect()
    }

    /// Game IDs of proposal accepts whose potato round-trip hasn't completed.
    pub fn pending_proposal_accept_game_ids(&self) -> Vec<GameID> {
        self.cached_last_actions
            .iter()
            .filter_map(|entry| {
                if let CachedPotatoRegenerateLastHop::ProposalAccepted(gid) = entry {
                    Some(*gid)
                } else {
                    None
                }
            })
            .collect()
    }

    pub fn find_live_game(&self, game_id: &GameID) -> Option<&LiveGame> {
        self.live_games.iter().find(|g| g.game_id == *game_id)
    }

    pub fn private_keys(&self) -> &ChannelHandlerPrivateKeys {
        &self.private_keys
    }

    pub fn my_allocated_balance(&self) -> Amount {
        self.my_allocated_balance.clone()
    }

    pub fn their_allocated_balance(&self) -> Amount {
        self.their_allocated_balance.clone()
    }

    pub fn unroll_advance_timeout(&self) -> &Timeout {
        &self.unroll_advance_timeout
    }

    pub fn take_live_games(&mut self) -> Vec<LiveGame> {
        std::mem::take(&mut self.live_games)
    }

    pub fn take_pending_accept_timeouts(&mut self) -> Vec<LiveGame> {
        std::mem::take(&mut self.pending_accept_timeouts)
    }

    pub fn take_cached_last_actions(&mut self) -> Vec<CachedPotatoRegenerateLastHop> {
        std::mem::take(&mut self.cached_last_actions)
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

    /// Drain all cached PotatoAcceptTimeout entries, returning (game_id, our_share_amount, game_finished) for each.
    pub fn drain_cached_accept_timeouts(&mut self) -> Vec<(GameID, Amount, bool)> {
        let mut accepts = Vec::new();
        self.cached_last_actions.retain(|entry| {
            if let CachedPotatoRegenerateLastHop::PotatoAcceptTimeout(acc) = entry {
                accepts.push((acc.game_id, acc.our_share_amount.clone(), acc.game_finished));
                false
            } else {
                true
            }
        });
        accepts
    }

    pub fn get_reward_puzzle_hash(
        &self,
        _env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<PuzzleHash, Error> {
        Ok(self.reward_puzzle_hash.clone())
    }

    pub fn my_reward_puzzle_hash(&self) -> &PuzzleHash {
        &self.reward_puzzle_hash
    }

    pub fn their_reward_puzzle_hash(&self) -> &PuzzleHash {
        &self.their_reward_puzzle_hash
    }

    pub fn get_opponent_reward_puzzle_hash(&self) -> PuzzleHash {
        self.their_reward_puzzle_hash.clone()
    }

    /// Return whichever stored UnrollCoin matches the given on-chain state
    /// number.  Checks `latest_received_unroll` first, then `latest_sent_unroll`,
    /// then falls back to the bounded puzzle hash map for recent historical states.
    pub fn get_unroll_for_state(
        &self,
        state_number: usize,
    ) -> Result<&ChannelHandlerUnrollSpendInfo, Error> {
        if let Some(t) = self.latest_received_unroll.as_ref() {
            if t.coin.state_number == state_number {
                return Ok(t);
            }
        }
        if self.latest_sent_unroll.coin.state_number == state_number {
            return Ok(&self.latest_sent_unroll);
        }
        // Fall back to the bounded map for recent historical states.
        for info in self.unroll_puzzle_hash_map.values() {
            if info.coin.state_number == state_number {
                return Ok(info);
            }
        }
        Err(Error::StrErr(format!(
            "No stored unroll matches on-chain state {state_number} (sent={}, received={:?}, map_size={})",
            self.latest_sent_unroll.coin.state_number,
            self.latest_received_unroll.as_ref().map(|t| t.coin.state_number),
            self.unroll_puzzle_hash_map.len(),
        )))
    }

    fn unroll_coin_condition_inputs(
        &self,
        my_balance: Amount,
        their_balance: Amount,
        puzzle_hashes_and_amounts: &[(PuzzleHash, Amount)],
    ) -> UnrollCoinConditionInputs {
        UnrollCoinConditionInputs {
            my_reward_puzzle_hash: self.reward_puzzle_hash.clone(),
            their_reward_puzzle_hash: self.their_reward_puzzle_hash.clone(),
            my_balance,
            their_balance,
            puzzle_hashes_and_amounts: puzzle_hashes_and_amounts.to_vec(),
            unroll_timeout: self.unroll_advance_timeout.to_u64(),
        }
    }

    pub fn state_channel_coin(&self) -> &CoinString {
        &self.state_channel.coin
    }

    pub fn set_launcher_coin_id(&mut self, launcher_coin_id: &CoinID) -> Result<(), Error> {
        let (_, ph, amt) = self
            .state_channel
            .coin
            .to_parts()
            .ok_or_else(|| Error::StrErr("channel coin not initialized".into()))?;
        self.state_channel.coin = CoinString::from_parts(launcher_coin_id, &ph, &amt);
        Ok(())
    }

    pub fn get_initial_signatures(&self) -> Result<PotatoSignatures, Error> {
        Ok(PotatoSignatures {
            my_channel_half_signature_peer: self.state_channel.bundle.signature.clone(),
            my_unroll_half_signature_peer: self
                .latest_sent_unroll
                .coin
                .get_unroll_coin_signature()?,
        })
    }

    pub fn verify_and_store_initial_peer_signatures(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        signatures: &PotatoSignatures,
    ) -> Result<ChannelCoinSpendInfo, Error> {
        if !self.latest_sent_unroll.coin.verify(
            env,
            &self.get_aggregate_unroll_public_key(),
            &signatures.my_unroll_half_signature_peer,
        )? {
            return Err(Error::StrErr("bad initial unroll signature".to_string()));
        }

        let channel_coin_spend = self
            .create_conditions_and_signature_of_channel_coin(env, &self.latest_sent_unroll.coin)?;
        let verified_spend = self.verify_channel_coin_from_peer_signatures(
            env,
            &signatures.my_channel_half_signature_peer,
            channel_coin_spend.conditions.p(),
        )?;

        let aggregate_public_key = self.get_aggregate_channel_public_key();
        self.state_channel.bundle = Spend {
            puzzle: puzzle_for_synthetic_public_key(
                env.allocator,
                &env.standard_puzzle,
                &aggregate_public_key,
            )?,
            solution: verified_spend.solution.clone(),
            signature: verified_spend.signature.clone(),
        };

        self.latest_received_unroll = Some(ChannelHandlerUnrollSpendInfo {
            coin: self.latest_sent_unroll.coin.clone(),
            signatures: signatures.clone(),
        });

        Ok(ChannelCoinSpendInfo {
            aggsig: verified_spend.signature,
            solution: verified_spend.solution.p(),
            conditions: verified_spend.conditions.p(),
        })
    }

    pub fn has_active_games(&self) -> bool {
        !self.live_games.is_empty()
    }

    pub fn unroll_puzzle_hash_map(&self) -> &HashMap<PuzzleHash, ChannelHandlerUnrollSpendInfo> {
        &self.unroll_puzzle_hash_map
    }

    /// Record an unroll state's puzzle hash for later on-chain identification
    /// via CREATE_COIN puzzle hash.  The opponent can broadcast any unroll
    /// we've ever sent them, so we keep all of them.
    fn record_unroll_puzzle_hash_for(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        info: &ChannelHandlerUnrollSpendInfo,
    ) -> Result<(), Error> {
        let agg_key = self.get_aggregate_unroll_public_key();
        let puzzle_node = info.coin.make_curried_unroll_puzzle(env, &agg_key)?;
        let puzzle_hash = Node(puzzle_node).sha256tree(env.allocator);

        self.unroll_puzzle_hash_map
            .insert(puzzle_hash, info.clone());

        Ok(())
    }

    fn record_unroll_puzzle_hash(&mut self, env: &mut ChannelHandlerEnv<'_>) -> Result<(), Error> {
        let info = self.latest_sent_unroll.clone();
        self.record_unroll_puzzle_hash_for(env, &info)
    }

    pub fn create_conditions_and_signature_of_channel_coin(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
        unroll_coin: &UnrollCoin,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        let unroll_coin_parent = self.state_channel_coin();
        self.get_solution_and_signature(
            &unroll_coin_parent.to_coin_id(),
            env,
            &self.private_keys.my_channel_coin_private_key,
            &self.get_aggregate_channel_public_key(),
            &self.get_aggregate_unroll_public_key(),
            &self.state_channel.coin.amount().ok_or_else(|| {
                debug_assert!(false, "state channel coin has no amount");
                Error::StrErr("state channel coin has no amount".to_string())
            })?,
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

    pub fn new(
        env: &mut ChannelHandlerEnv<'_>,
        private_keys: ChannelHandlerPrivateKeys,
        launcher_coin_id: CoinID,
        we_start_with_potato: bool,
        their_channel_pubkey: PublicKey,
        their_unroll_pubkey: PublicKey,
        their_referee_pubkey: PublicKey,
        their_reward_puzzle_hash: PuzzleHash,
        their_reward_payout_signature: Aggsig,
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

        if unroll_advance_timeout.to_u64() != 15 {
            return Err(Error::Channel(format!(
                "unroll_advance_timeout must be 15, got {}",
                unroll_advance_timeout.to_u64(),
            )));
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
            their_referee_pubkey: their_referee_pubkey.clone(),
            their_reward_puzzle_hash: their_reward_puzzle_hash.clone(),
            their_reward_payout_signature: their_reward_payout_signature.clone(),
            my_out_of_game_balance: my_contribution.clone(),
            their_out_of_game_balance: their_contribution.clone(),
            unroll_advance_timeout: unroll_advance_timeout.clone(),
            reward_puzzle_hash: reward_puzzle_hash.clone(),

            my_allocated_balance: Amount::default(),
            their_allocated_balance: Amount::default(),

            have_potato: we_start_with_potato,

            cached_last_actions: Vec::new(),

            state_number: 0,
            my_next_nonce: if we_start_with_potato { 0 } else { 1 },
            their_next_nonce: if we_start_with_potato { 1 } else { 0 },

            state_channel: CoinSpend {
                coin: channel_coin_parent,
                bundle: Spend::default(),
            },

            latest_sent_unroll: ChannelHandlerUnrollSpendInfo::default(),
            latest_received_unroll: None,
            unroll_puzzle_hash_map: HashMap::new(),

            live_games: Vec::new(),
            pending_accept_timeouts: Vec::new(),
            proposed_games: Vec::new(),

            private_keys,
        };

        myself.latest_sent_unroll.coin.state_number = 0;
        myself.latest_sent_unroll.coin.started_with_potato = myself.have_potato;

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
        // unroll/unroll_puzzle.clsp::state_channel_unrolling
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
        myself.latest_sent_unroll.coin.update(
            env,
            &myself.private_keys.my_unroll_coin_private_key,
            &myself.their_unroll_coin_public_key,
            &inputs,
        )?;
        myself.record_unroll_puzzle_hash(env)?;

        let channel_coin_spend = myself.create_conditions_and_signature_of_channel_coin(
            env,
            &myself.latest_sent_unroll.coin,
        )?;

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

    pub fn finish_handshake(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        their_initial_channel_half_signature: &Aggsig,
    ) -> Result<HandshakeResult, Error> {
        let aggregate_public_key = self.get_aggregate_channel_public_key();

        let channel_coin_spend = self
            .create_conditions_and_signature_of_channel_coin(env, &self.latest_sent_unroll.coin)?;

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
                .ok_or_else(|| {
                    debug_assert!(false, "state channel coin has no amount");
                    Error::StrErr("state channel coin has no amount".to_string())
                })?
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
                game_id_up: game.game_id,
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

    pub fn update_cached_unroll_state(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<PotatoSignatures, Error> {
        let new_game_coins_on_chain: Vec<(PuzzleHash, Amount)> =
            self.compute_unroll_data_for_games(&[], None, &self.live_games)?;

        let unroll_inputs = self.unroll_coin_condition_inputs(
            self.my_out_of_game_balance.clone(),
            self.their_out_of_game_balance.clone(),
            &new_game_coins_on_chain,
        );

        self.state_number += 1;
        self.latest_sent_unroll.coin.state_number = self.state_number;

        // Now update our unroll state.
        self.latest_sent_unroll.coin.update(
            env,
            &self.private_keys.my_unroll_coin_private_key,
            &self.their_unroll_coin_public_key,
            &unroll_inputs,
        )?;
        self.record_unroll_puzzle_hash(env)?;
        self.latest_sent_unroll.signatures = Default::default();
        self.have_potato = false;

        let channel_coin_spend = self
            .create_conditions_and_signature_of_channel_coin(env, &self.latest_sent_unroll.coin)?;

        let our_half = self.latest_sent_unroll.coin.get_unroll_coin_signature()?;

        Ok(PotatoSignatures {
            my_channel_half_signature_peer: channel_coin_spend.signature,
            my_unroll_half_signature_peer: our_half,
        })
    }

    pub fn send_empty_potato(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<PotatoSignatures, Error> {
        self.update_cached_unroll_state(env)
    }

    pub fn verify_channel_coin_from_peer_signatures(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
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

    pub fn received_potato_verify_signatures(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        signatures: &PotatoSignatures,
        inputs: &UnrollCoinConditionInputs,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        // The potato just arrived, so any prior pending accepts are now
        // confirmed by the round-trip.
        self.pending_accept_timeouts.clear();

        // Unroll coin section.
        let mut test_unroll = self.latest_sent_unroll.coin.clone();
        test_unroll.state_number = self.state_number + 1;

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

        self.state_number += 1;
        let received_info = ChannelHandlerUnrollSpendInfo {
            coin: test_unroll.clone(),
            signatures: signatures.clone(),
        };
        self.record_unroll_puzzle_hash_for(env, &received_info)?;
        self.latest_received_unroll = Some(received_info);

        self.have_potato = true;

        Ok(BrokenOutCoinSpendInfo {
            signature: channel_coin_spend.signature.clone()
                + signatures.my_channel_half_signature_peer.clone(),
            ..channel_coin_spend
        })
    }

    /// Verify batch signatures against the current channel state. Called once
    /// after all apply_received_* methods in a batch.
    pub fn verify_received_batch_signatures(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
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

        self.cached_last_actions
            .retain(|entry| matches!(entry, CachedPotatoRegenerateLastHop::PotatoAcceptTimeout(_)));

        Ok(ChannelCoinSpendInfo {
            aggsig: spend.signature,
            solution: spend.solution.p(),
            conditions: spend.conditions.p(),
        })
    }

    pub fn received_empty_potato(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
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

        self.cached_last_actions
            .retain(|entry| matches!(entry, CachedPotatoRegenerateLastHop::PotatoAcceptTimeout(_)));

        Ok(ChannelCoinSpendInfo {
            aggsig: spend.signature,
            solution: spend.solution.p(),
            conditions: spend.conditions.p(),
        })
    }

    /// Mutate state for sending a game proposal. Does NOT finalize signatures.
    /// Call `update_cached_unroll_state` once after all batch mutations.
    pub fn send_propose_game(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        start_info: &Rc<GameStartInfo>,
    ) -> Result<(), Error> {
        let new_game_nonce = start_info.game_id.0;

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
            start_info,
            referee_identity,
            &self.their_referee_pubkey,
            &self.their_reward_puzzle_hash,
            &self.their_reward_payout_signature,
            &self.reward_puzzle_hash,
            new_game_nonce,
            &agg_sig_me,
            self.state_number,
        )?;

        self.proposed_games.push(ProposedGame::new(
            start_info.game_id,
            ph,
            Rc::new(r),
            start_info.my_contribution_this_game.clone(),
            start_info.their_contribution_this_game.clone(),
        ));

        Ok(())
    }

    /// Propose a game and finalize unroll signatures in one call.
    pub fn propose_game(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        start_info: &Rc<GameStartInfo>,
    ) -> Result<PotatoSignatures, Error> {
        self.send_propose_game(env, start_info)?;
        self.update_cached_unroll_state(env)
    }

    /// Apply a received proposal without verifying signatures.
    pub fn apply_received_proposal(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        start_info: &Rc<GameStartInfo>,
    ) -> Result<(), Error> {
        let new_game_nonce = start_info.game_id.0;
        let expected_parity = self.their_next_nonce % 2;
        if new_game_nonce % 2 != expected_parity {
            return Err(Error::StrErr(format!(
                "received nonce {new_game_nonce} has wrong parity (expected {expected_parity})"
            )));
        }
        if new_game_nonce < self.their_next_nonce {
            return Err(Error::StrErr(format!(
                "received nonce {new_game_nonce} < minimum expected {}",
                self.their_next_nonce
            )));
        }

        // 4.3: Sanity limit on nonce gap to prevent absurd jumps.
        const MAX_NONCE_GAP: u64 = 1000;
        if new_game_nonce > self.their_next_nonce + MAX_NONCE_GAP {
            return Err(Error::StrErr(format!(
                "received nonce {new_game_nonce} too far ahead of expected {} (max gap {MAX_NONCE_GAP})",
                self.their_next_nonce
            )));
        }

        // 4.6: amount must equal the sum of contributions.
        let expected_amount = start_info.my_contribution_this_game.clone()
            + start_info.their_contribution_this_game.clone();
        if start_info.amount != expected_amount {
            return Err(Error::StrErr(format!(
                "proposal amount {} != my_contribution {} + their_contribution {}",
                start_info.amount.to_u64(),
                start_info.my_contribution_this_game.to_u64(),
                start_info.their_contribution_this_game.to_u64(),
            )));
        }

        if start_info.timeout.to_u64() != 15 {
            return Err(Error::StrErr(format!(
                "proposal game_timeout must be 15, got {}",
                start_info.timeout.to_u64(),
            )));
        }

        // 4.9: Limit on outstanding proposal count.
        const MAX_PROPOSALS: usize = 100;
        if self.proposed_games.len() >= MAX_PROPOSALS {
            return Err(Error::StrErr(format!(
                "too many outstanding proposals ({}, max {MAX_PROPOSALS})",
                self.proposed_games.len(),
            )));
        }

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
            start_info,
            referee_identity,
            &self.their_referee_pubkey,
            &self.their_reward_puzzle_hash,
            &self.their_reward_payout_signature,
            &self.reward_puzzle_hash,
            new_game_nonce,
            &agg_sig_me,
            self.state_number,
        )?;

        self.their_next_nonce = new_game_nonce + 2;

        self.proposed_games.push(ProposedGame::new(
            start_info.game_id,
            ph,
            Rc::new(r),
            start_info.my_contribution_this_game.clone(),
            start_info.their_contribution_this_game.clone(),
        ));

        Ok(())
    }

    /// Mutate state for accepting a proposal. Does NOT finalize signatures.
    fn accept_proposal_inner(&mut self, game_id: &GameID) -> Result<(), Error> {
        let idx = self
            .proposed_games
            .iter()
            .position(|p| p.game_id == *game_id)
            .ok_or_else(|| Error::StrErr(format!("no proposal with id {game_id:?}")))?;
        let proposal = self.proposed_games.remove(idx);

        if proposal.my_contribution.clone() > self.my_out_of_game_balance
            || proposal.their_contribution.clone() > self.their_out_of_game_balance
        {
            self.proposed_games.insert(idx, proposal);
            return Err(Error::StrErr(
                "insufficient balance to accept proposal".to_string(),
            ));
        }

        self.my_allocated_balance += proposal.my_contribution.clone();
        self.their_allocated_balance += proposal.their_contribution.clone();
        self.my_out_of_game_balance = self
            .my_out_of_game_balance
            .checked_sub(&proposal.my_contribution)?;
        self.their_out_of_game_balance = self
            .their_out_of_game_balance
            .checked_sub(&proposal.their_contribution)?;

        let live_game = LiveGame::new(
            proposal.game_id,
            proposal.initial_puzzle_hash,
            proposal.referee,
            proposal.my_contribution,
            proposal.their_contribution,
        );
        self.live_games.push(live_game);
        Ok(())
    }

    pub fn send_accept_proposal(&mut self, game_id: &GameID) -> Result<(), Error> {
        self.accept_proposal_inner(game_id)?;
        self.push_cached_action(CachedPotatoRegenerateLastHop::ProposalAccepted(*game_id));
        Ok(())
    }

    /// Apply a received accept-proposal without verifying signatures.
    pub fn apply_received_accept_proposal(&mut self, game_id: &GameID) -> Result<(), Error> {
        if !self.is_our_nonce_parity(game_id) {
            return Err(Error::StrErr(format!(
                "peer attempted to accept their own proposal {game_id:?}"
            )));
        }
        self.accept_proposal_inner(game_id)
    }

    /// Mutate state for cancelling a proposal. Does NOT finalize signatures.
    pub fn send_cancel_proposal(&mut self, game_id: &GameID) -> Result<(), Error> {
        let idx = self
            .proposed_games
            .iter()
            .position(|p| p.game_id == *game_id)
            .ok_or_else(|| Error::StrErr(format!("no proposal with id {game_id:?}")))?;
        self.proposed_games.remove(idx);
        Ok(())
    }

    pub fn received_cancel_proposal(&mut self, game_id: &GameID) -> Result<(), Error> {
        let idx = self
            .proposed_games
            .iter()
            .position(|p| p.game_id == *game_id)
            .ok_or_else(|| Error::StrErr(format!("cancel for unknown proposal {game_id:?}")))?;
        self.proposed_games.remove(idx);
        Ok(())
    }

    pub fn cancel_all_proposals(&mut self) -> Vec<GameID> {
        let ids: Vec<GameID> = self.proposed_games.iter().map(|p| p.game_id).collect();
        self.proposed_games.clear();
        ids
    }

    pub fn has_our_outstanding_proposals(&self) -> bool {
        self.proposed_games
            .iter()
            .any(|p| self.is_our_nonce_parity(&p.game_id))
    }

    pub fn find_proposal(&self, game_id: &GameID) -> Option<&ProposedGame> {
        self.proposed_games.iter().find(|p| p.game_id == *game_id)
    }

    pub fn pending_peer_proposal_ids(&self) -> Vec<GameID> {
        self.proposed_games
            .iter()
            .filter(|p| !self.is_our_nonce_parity(&p.game_id))
            .map(|p| p.game_id)
            .collect()
    }

    pub fn my_out_of_game_balance(&self) -> Amount {
        self.my_out_of_game_balance.clone()
    }

    pub fn their_out_of_game_balance(&self) -> Amount {
        self.their_out_of_game_balance.clone()
    }

    pub fn total_game_allocated(&self) -> Amount {
        self.my_allocated_balance.clone() + self.their_allocated_balance.clone()
    }

    pub fn is_game_proposed(&self, game_id: &GameID) -> bool {
        self.proposed_games.iter().any(|p| p.game_id == *game_id)
    }

    pub fn has_live_game(&self, game_id: &GameID) -> bool {
        self.live_games.iter().any(|g| &g.game_id == game_id)
    }

    pub fn is_game_finished(&self, game_id: &GameID) -> bool {
        self.get_game_by_id(game_id)
            .map(|idx| self.live_games[idx].is_my_turn() && self.live_games[idx].is_game_over())
            .unwrap_or(false)
    }

    pub fn get_game_our_current_share(&self, game_id: &GameID) -> Result<Amount, Error> {
        if let Some(g) = self.live_games.iter().find(|g| g.game_id == *game_id) {
            return g.get_our_current_share();
        }
        if let Some(g) = self
            .pending_accept_timeouts
            .iter()
            .find(|g| g.game_id == *game_id)
        {
            return g.get_our_current_share();
        }
        Err(Error::StrErr(format!(
            "get_game_our_current_share: game {:?} not found",
            game_id
        )))
    }

    /// Drain PotatoAcceptTimeout entries from cached_last_actions for games
    /// that are NOT in surviving_ids (i.e., preemption resolved them and no
    /// game coin was created on-chain). Returns (game_id, our_share, game_finished) tuples
    /// that need WeTimedOut notifications.
    ///
    /// This only fires when the potato never came back — if it had,
    /// drain_cached_accept_timeouts would have already removed these entries
    /// and emitted WeTimedOut off-chain.
    pub fn drain_preempt_resolved_accept_timeouts(
        &mut self,
        surviving_ids: &HashSet<GameID>,
    ) -> Vec<(GameID, Amount, bool)> {
        let mut resolved = Vec::new();
        self.cached_last_actions.retain(|entry| {
            if let CachedPotatoRegenerateLastHop::PotatoAcceptTimeout(acc) = entry {
                if !surviving_ids.contains(&acc.game_id) {
                    resolved.push((acc.game_id, acc.our_share_amount.clone(), acc.game_finished));
                    return false;
                }
            }
            true
        });
        for (gid, _, _) in &resolved {
            self.pending_accept_timeouts.retain(|g| g.game_id != *gid);
        }
        resolved
    }

    pub fn get_game_amount(&self, game_id: &GameID) -> Result<Amount, Error> {
        if let Some(g) = self.live_games.iter().find(|g| g.game_id == *game_id) {
            return Ok(g.get_amount());
        }
        if let Some(g) = self
            .pending_accept_timeouts
            .iter()
            .find(|g| g.game_id == *game_id)
        {
            return Ok(g.get_amount());
        }
        Err(Error::StrErr(format!(
            "get_game_amount: game {:?} not found",
            game_id
        )))
    }

    pub fn get_game_by_id(&self, game_id: &GameID) -> Result<usize, Error> {
        self.live_games
            .iter()
            .position(|g| &g.game_id == game_id)
            .map(Ok)
            .unwrap_or_else(|| {
                Err(Error::StrErr(
                    "no live game with the given game id".to_string(),
                ))
            })
    }

    /// Apply a send-side move mutation. Does NOT finalize signatures.
    /// Pushes a cache entry for on-chain redo.
    pub fn send_move_no_finalize(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        readable_move: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<MoveResult, Error> {
        let game_idx = self.get_game_by_id(game_id)?;
        let state_number = self.state_number;

        let referee_result = self.live_games[game_idx].internal_make_move(
            env.allocator,
            readable_move,
            new_entropy.clone(),
            state_number,
        )?;

        let match_puzzle_hash = referee_result.puzzle_hash_for_unroll.clone();

        self.live_games[game_idx].last_referee_puzzle_hash =
            self.live_games[game_idx].outcome_puzzle_hash(env.allocator)?;

        let (saved_referee, saved_ph) = self.live_games[game_idx].save_referee_state();

        let puzzle_hash = referee_result.puzzle_hash_for_unroll;
        let amount = referee_result.details.basic.mover_share.clone();

        self.push_cached_action(CachedPotatoRegenerateLastHop::PotatoMoveHappening(Rc::new(
            PotatoMoveCachedData {
                state_number: self.state_number,
                game_id: *game_id,
                match_puzzle_hash,
                puzzle_hash,
                amount,
                saved_post_move_referee: Some(saved_referee),
                saved_post_move_last_ph: Some(saved_ph),
            },
        )));

        Ok(MoveResult {
            state_number: self.state_number,
            game_move: referee_result.details.clone(),
            is_finished: self.live_games[game_idx].is_game_over(),
        })
    }

    /// Apply a received move to local state without verifying signatures.
    /// Call `verify_received_batch_signatures` once after all batch actions are applied.
    pub fn apply_received_move(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        game_move: &GameMoveDetails,
    ) -> Result<ChannelHandlerMoveResult, Error> {
        let game_idx = self.get_game_by_id(game_id)?;
        let game_amount = self.live_games[game_idx].get_amount();
        if game_move.basic.mover_share > game_amount {
            return Err(Error::StrErr(format!(
                "received move with mover_share {} exceeding game amount {}",
                game_move.basic.mover_share.to_u64(),
                game_amount.to_u64(),
            )));
        }

        let max_move_size = self.live_games[game_idx].get_max_move_size();
        if game_move.basic.move_made.len() > max_move_size {
            return Err(Error::StrErr(format!(
                "received move of {} bytes exceeds max_move_size {}",
                game_move.basic.move_made.len(),
                max_move_size,
            )));
        }

        let state_number = self.state_number;

        let their_move_result = self.live_games[game_idx].internal_their_move(
            env.allocator,
            game_move,
            state_number,
        )?;

        if their_move_result.slash.is_some() {
            return Err(Error::StrErr(
                "slash when off chain: go on chain".to_string(),
            ));
        }

        Ok(ChannelHandlerMoveResult {
            readable_their_move: their_move_result.readable_move.p(),
            state_number: self.state_number,
            message: their_move_result.message,
            mover_share: their_move_result.mover_share,
        })
    }

    pub fn received_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        message: &[u8],
    ) -> Result<ReadableMove, Error> {
        let game_idx = self.get_game_by_id(game_id)?;

        self.live_games[game_idx].receive_readable(env.allocator, message)
    }

    /// Apply a send-side accept mutation. Does NOT finalize signatures.
    /// Pushes a cache entry for on-chain redo. Returns the amount won.
    pub fn send_accept_timeout_no_finalize(&mut self, game_id: &GameID) -> Result<Amount, Error> {
        game_assert!(
            self.have_potato,
            "send_accept_timeout_no_finalize: must have potato"
        );
        let game_idx = self.get_game_by_id(game_id)?;
        game_assert!(
            self.live_games[game_idx].is_my_turn(),
            "accept_timeout requires it to be our turn"
        );

        let live_game = self.live_games.remove(game_idx);
        self.my_allocated_balance = self
            .my_allocated_balance
            .checked_sub(&live_game.my_contribution)?;
        self.their_allocated_balance = self
            .their_allocated_balance
            .checked_sub(&live_game.their_contribution)?;

        let amount = live_game.get_our_current_share()?;
        let at_stake = live_game.get_amount();

        let (ref_clone, ph_clone) = live_game.save_referee_state();
        self.pending_accept_timeouts.push(LiveGame::new(
            *game_id,
            ph_clone,
            ref_clone,
            live_game.my_contribution.clone(),
            live_game.their_contribution.clone(),
        ));

        self.my_out_of_game_balance += amount.clone();
        self.their_out_of_game_balance += at_stake.checked_sub(&amount)?;

        let game_finished = live_game.is_game_over();
        self.push_cached_action(CachedPotatoRegenerateLastHop::PotatoAcceptTimeout(
            Box::new(PotatoAcceptTimeoutCachedData {
                game_id: *game_id,
                puzzle_hash: live_game.last_referee_puzzle_hash.clone(),
                live_game,
                at_stake_amount: at_stake,
                our_share_amount: amount.clone(),
                game_finished,
            }),
        ));

        Ok(amount)
    }

    /// Apply a received accept (game finish) without verifying signatures.
    /// Returns (our_reward_amount, game_finished).
    pub fn apply_received_accept_timeout(
        &mut self,
        game_id: &GameID,
    ) -> Result<(Amount, bool), Error> {
        let game_idx = self.get_game_by_id(game_id)?;

        if self.live_games[game_idx].is_my_turn() {
            return Err(Error::StrErr(format!(
                "received AcceptTimeout for game {game_id:?} but it is our turn"
            )));
        }

        let game_finished = self.live_games[game_idx].is_game_over();
        let game_amount_for_me = self.live_games[game_idx].get_our_current_share()?;
        let game_amount_for_them = self.live_games[game_idx]
            .get_amount()
            .checked_sub(&self.live_games[game_idx].get_our_current_share()?)?;

        self.my_allocated_balance = self
            .my_allocated_balance
            .checked_sub(&self.live_games[game_idx].my_contribution)?;
        self.their_allocated_balance = self
            .their_allocated_balance
            .checked_sub(&self.live_games[game_idx].their_contribution)?;
        self.my_out_of_game_balance += game_amount_for_me.clone();
        self.their_out_of_game_balance += game_amount_for_them;

        let removed = self.live_games.remove(game_idx);
        self.pending_accept_timeouts.push(removed);
        Ok((game_amount_for_me, game_finished))
    }

    /// Uses the channel coin key to post standard format coin generation to the
    /// real blockchain via a Spend.
    pub fn send_potato_clean_shutdown(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
        conditions: NodePtr,
    ) -> Result<Spend, Error> {
        game_assert!(
            self.have_potato,
            "send_potato_clean_shutdown: must have potato"
        );
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

    pub fn get_solution_and_signature_from_conditions(
        &self,
        coin_id: &CoinID,
        env: &mut ChannelHandlerEnv<'_>,
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

    pub fn get_solution_and_signature(
        &self,
        coin_id: &CoinID,
        env: &mut ChannelHandlerEnv<'_>,
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
        let conditions_program = Program::from_nodeptr(env.allocator, create_conditions_obj)?;
        self.get_solution_and_signature_from_conditions(
            coin_id,
            env,
            private_key,
            aggregate_channel_public_key,
            Rc::new(conditions_program),
        )
    }

    pub fn received_potato_clean_shutdown(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
        their_channel_half_signature: &Aggsig,
        conditions: NodePtr,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        game_assert!(
            !self.have_potato,
            "received_potato_clean_shutdown: must not have potato"
        );
        let conditions_program = Program::from_nodeptr(env.allocator, conditions)?;
        let channel_spend = self.verify_channel_coin_from_peer_signatures(
            env,
            their_channel_half_signature,
            Rc::new(conditions_program),
        )?;

        Ok(channel_spend)
    }

    /// Identify the on-chain unroll from channel-coin spend conditions by
    /// finding the CREATE_COIN puzzle hash and looking it up in our map.
    /// Returns (state_number, conditions_hash).
    pub fn resolve_unroll_from_conditions(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
        conditions: NodePtr,
    ) -> Result<(usize, PuzzleHash), Error> {
        let all_conditions = CoinCondition::from_nodeptr(env.allocator, conditions);
        for c in &all_conditions {
            if let CoinCondition::CreateCoin(ph, _) = c {
                if let Some(info) = self.unroll_puzzle_hash_map.get(ph) {
                    let conditions_hash = info.coin.get_conditions_hash_for_unroll_puzzle()?;
                    return Ok((info.coin.state_number, conditions_hash));
                }
            }
        }
        Err(Error::StrErr(
            "No CREATE_COIN in channel spend matches a known unroll puzzle hash".to_string(),
        ))
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
    pub fn channel_coin_spent(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
        myself: bool,
        conditions: NodePtr,
    ) -> Result<ChannelCoinSpentResult, Error> {
        let (unrolling_state_number, conditions_hash) =
            self.resolve_unroll_from_conditions(env, conditions)?;

        // Three cases based on comparing on-chain state to our current state:
        let mut result = match (myself, unrolling_state_number.cmp(&self.state_number)) {
            // We initiated this spend, or the on-chain state matches ours:
            // use the timeout (default) path.
            (true, _) | (_, Ordering::Equal) => self.make_timeout_unroll_spend(env),
            // On-chain state is from the future relative to us - error.
            (_, Ordering::Greater) => Err(Error::StrErr(format!(
                "Reply from the future onchain {} (me {})",
                unrolling_state_number, self.state_number,
            ))),
            // On-chain state is behind ours - preempt.  We have two
            // adjacent states (latest_sent_unroll and latest_received_unroll);
            // exactly one will satisfy the CLSP parity constraint.
            (_, Ordering::Less) => {
                self.make_preemption_unroll_spend(env, unrolling_state_number, &conditions_hash)
            }
        };
        if let Ok(ref mut r) = result {
            r.unrolling_state_number = unrolling_state_number;
        }
        result
    }

    /// Build the timeout (default-path) spend of the unroll coin using our
    /// own unroll data.  Both puzzle and solution come from `self.latest_sent_unroll`.
    fn make_timeout_unroll_spend(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<ChannelCoinSpentResult, Error> {
        let agg_key = self.get_aggregate_unroll_public_key();
        let curried_puzzle = self
            .latest_sent_unroll
            .coin
            .make_curried_unroll_puzzle(env, &agg_key)?;
        let solution = self
            .latest_sent_unroll
            .coin
            .make_unroll_puzzle_solution(env, &agg_key)?;

        let sig = self.latest_sent_unroll.coin.get_unroll_coin_signature()?;

        Ok(ChannelCoinSpentResult {
            transaction: Spend {
                puzzle: Puzzle::from_nodeptr(env.allocator, curried_puzzle)?,
                solution: Program::from_nodeptr(env.allocator, solution)?.into(),
                signature: sig,
            },
            timeout: true,
            games_canceled: vec![],
            unrolling_state_number: 0,
        })
    }

    /// Build a preemption (challenge-path) spend of the unroll coin.
    /// The PUZZLE must match the on-chain coin (built from the state that
    /// matches the on-chain unroll).  The SOLUTION and SIGNATURE come from
    /// our latest state that satisfies the CLSP parity constraint:
    ///   logand(1, logxor(our_state_number, OLD_SEQUENCE_NUMBER)) == 1
    fn make_preemption_unroll_spend(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
        unrolling_state_number: usize,
        conditions_hash: &PuzzleHash,
    ) -> Result<ChannelCoinSpentResult, Error> {
        // OLD_SEQUENCE_NUMBER equals state_number (both set during update()).
        let old_sn = unrolling_state_number;

        let agg_key = self.get_aggregate_unroll_public_key();

        // Pick whichever of our stored states has the right parity relative
        // to OLD.  The CLSP requires logand(1, logxor(new_sn, old_sn)) == 1,
        // i.e. new_sn and old_sn must differ in the LSB.
        //
        // A candidate must also have the peer's half-signature — without it
        // the aggregate signature cannot be formed and the spend would be
        // rejected on-chain.  The `latest_sent_unroll` slot lacks peer signatures
        // after update_cached_unroll_state (they arrive only in the
        // `latest_received_unroll` slot when the peer responds), so it is often
        // ineligible.
        let has_peer_sig = |info: &ChannelHandlerUnrollSpendInfo| -> bool {
            info.signatures.my_unroll_half_signature_peer != Aggsig::default()
        };
        let parity_ok = |sn: usize| -> bool { (sn ^ old_sn) & 1 == 1 };

        let unroll_ok = parity_ok(self.latest_sent_unroll.coin.state_number)
            && has_peer_sig(&self.latest_sent_unroll);
        let preempt_source = if unroll_ok {
            &self.latest_sent_unroll
        } else if let Some(t) = self.latest_received_unroll.as_ref() {
            if parity_ok(t.coin.state_number) && has_peer_sig(t) {
                t
            } else {
                return Err(Error::StrErr(format!(
                    "No stored state satisfies parity+signature for preemption (old={old_sn} unroll_sn={} timeout_sn={:?})",
                    self.latest_sent_unroll.coin.state_number,
                    self.latest_received_unroll.as_ref().map(|t| t.coin.state_number),
                )));
            }
        } else {
            return Err(Error::StrErr(
                "No timeout state available for preemption".to_string(),
            ));
        };

        // PUZZLE: must match the on-chain unroll coin.  Reconstruct it from
        // known components using the conditions_hash resolved by the caller
        // from the unroll puzzle hash map.
        let shared_puzzle = CurriedProgram {
            program: env.unroll_metapuzzle.clone(),
            args: clvm_curried_args!(agg_key.clone()),
        }
        .to_clvm(env.allocator)
        .into_gen()?;
        let shared_puzzle_hash = Node(shared_puzzle).sha256tree(env.allocator);

        let curried_puzzle = CurriedProgram {
            program: env.unroll_puzzle.clone(),
            args: clvm_curried_args!(
                shared_puzzle_hash.clone(),
                unrolling_state_number,
                conditions_hash.clone()
            ),
        }
        .to_clvm(env.allocator)
        .into_gen()?;

        // SOLUTION: from the preemption source (our newer state).
        let solution = preempt_source
            .coin
            .make_unroll_puzzle_solution(env, &agg_key)?;

        // SIGNATURE: aggregate of both halves from the preemption source.
        let our_half = preempt_source.coin.get_unroll_coin_signature()?;
        let peer_half = preempt_source
            .signatures
            .my_unroll_half_signature_peer
            .clone();
        let signature = our_half.clone() + peer_half.clone();

        Ok(ChannelCoinSpentResult {
            transaction: Spend {
                puzzle: Puzzle::from_nodeptr(env.allocator, curried_puzzle)?,
                solution: Program::from_nodeptr(env.allocator, solution)?.into(),
                signature,
            },
            timeout: false,
            games_canceled: vec![],
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
    pub fn push_cached_action(&mut self, entry: CachedPotatoRegenerateLastHop) {
        self.cached_last_actions.push(entry);
    }

    /// After an unroll completes, map on-chain game coin puzzle hashes to the
    /// corresponding live games.
    ///
    /// Each game has up to two known puzzle hashes:
    ///  - `last_referee_puzzle_hash` (the current/latest state)
    ///  - a cached move's `match_puzzle_hash` (the pre-move state needing redo)
    ///
    /// Matching is strictly by puzzle hash.  Each game matches at most one
    /// coin.  Games with no PH match will not appear in the returned map;
    /// the caller is responsible for emitting terminal errors for them.
    pub fn set_state_for_coins(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        unroll_coin: &CoinString,
        coins: &[(PuzzleHash, Amount)],
    ) -> Result<HashMap<CoinString, OnChainGameState>, Error> {
        let mut res = HashMap::new();
        let unroll_coin_id = unroll_coin.to_coin_id();

        let cached_moves: Vec<(GameID, PuzzleHash)> = self
            .cached_last_actions
            .iter()
            .filter_map(|entry| {
                if let CachedPotatoRegenerateLastHop::PotatoMoveHappening(d) = entry {
                    Some((d.game_id, d.match_puzzle_hash.clone()))
                } else {
                    None
                }
            })
            .collect();

        let mut matched_game_ids: HashSet<GameID> = HashSet::new();

        for (coin_ph, coin_amt) in coins.iter() {
            let coin_id = CoinString::from_parts(&unroll_coin_id, coin_ph, coin_amt);

            let live_latest = self.live_games.iter().find(|g| {
                !matched_game_ids.contains(&g.game_id)
                    && g.last_referee_puzzle_hash == *coin_ph
                    && g.get_amount() == *coin_amt
            });
            let live_redo = if live_latest.is_none() {
                cached_moves.iter().find_map(|(gid, mph)| {
                    if *mph == *coin_ph && !matched_game_ids.contains(gid) {
                        self.live_games
                            .iter()
                            .find(|g| g.game_id == *gid && g.get_amount() == *coin_amt)
                    } else {
                        None
                    }
                })
            } else {
                None
            };

            if let Some(live_game) = live_latest {
                matched_game_ids.insert(live_game.game_id);
                res.insert(
                    coin_id,
                    OnChainGameState {
                        game_id: live_game.game_id,
                        puzzle_hash: coin_ph.clone(),
                        our_turn: live_game.is_my_turn(),
                        state_number: self.state_number,
                        accept: AcceptTransactionState::Waiting,
                        pending_slash_amount: None,
                        cheating_move_mover_share: None,
                        accepted: false,
                        notification_sent: false,
                        game_timeout: live_game.get_game_timeout(),
                        game_finished: live_game.is_game_over(),
                    },
                );
                continue;
            }

            if let Some(live_game) = live_redo {
                matched_game_ids.insert(live_game.game_id);
                res.insert(
                    coin_id,
                    OnChainGameState {
                        game_id: live_game.game_id,
                        puzzle_hash: coin_ph.clone(),
                        our_turn: true,
                        state_number: self.state_number,
                        accept: AcceptTransactionState::Waiting,
                        pending_slash_amount: None,
                        cheating_move_mover_share: None,
                        accepted: false,
                        notification_sent: false,
                        game_timeout: live_game.get_game_timeout(),
                        game_finished: live_game.is_game_over(),
                    },
                );
                continue;
            }

            let pending_match = self
                .pending_accept_timeouts
                .iter()
                .find(|p| p.last_referee_puzzle_hash == *coin_ph && p.get_amount() == *coin_amt);
            if let Some(pending) = pending_match {
                res.insert(
                    coin_id,
                    OnChainGameState {
                        game_id: pending.game_id,
                        puzzle_hash: coin_ph.clone(),
                        our_turn: true,
                        state_number: self.state_number,
                        accept: AcceptTransactionState::Waiting,
                        pending_slash_amount: None,
                        cheating_move_mover_share: None,
                        accepted: true,
                        notification_sent: false,
                        game_timeout: pending.get_game_timeout(),
                        game_finished: false,
                    },
                );
                continue;
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

        for p in self.proposed_games.iter() {
            if p.game_id == *game_id {
                return Some(p.referee.is_my_turn());
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

    pub fn save_game_state(&self, game_id: &GameID) -> Result<(Rc<Referee>, PuzzleHash), Error> {
        let idx = self.get_game_by_id(game_id)?;
        Ok(self.live_games[idx].save_referee_state())
    }

    pub fn restore_game_state(
        &mut self,
        game_id: &GameID,
        referee: Rc<Referee>,
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
    ) -> Result<Spend, Error> {
        let idx = self.get_game_by_id(game_id)?;
        self.live_games[idx].get_transaction_for_move(allocator, game_coin)
    }

    pub fn get_game_outcome_puzzle_hash(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
    ) -> Result<PuzzleHash, Error> {
        let idx = self.get_game_by_id(game_id)?;
        self.live_games[idx].outcome_puzzle_hash(env.allocator)
    }

    /// Extract cached move data (including saved S' referee) from
    /// `cached_last_actions` for a specific game, removing that entry.
    pub fn take_cached_move_for_game(
        &mut self,
        game_id: &GameID,
    ) -> Option<Rc<PotatoMoveCachedData>> {
        let pos = self.cached_last_actions.iter().position(|entry| {
            matches!(entry, CachedPotatoRegenerateLastHop::PotatoMoveHappening(d) if d.game_id == *game_id)
        });
        if let Some(idx) = pos {
            if let CachedPotatoRegenerateLastHop::PotatoMoveHappening(data) =
                self.cached_last_actions.remove(idx)
            {
                return Some(data);
            }
        }
        None
    }

    pub fn on_chain_our_move(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        readable_move: &ReadableMove,
        entropy: Hash,
        existing_coin: &CoinString,
    ) -> Result<(PuzzleHash, PuzzleHash, usize, GameMoveDetails, Spend), Error> {
        let game_idx = self.get_game_by_id(game_id)?;

        let last_puzzle_hash = self.live_games[game_idx].last_puzzle_hash();
        let state_number = self.state_number;

        let move_result = self.live_games[game_idx].internal_make_move(
            env.allocator,
            readable_move,
            entropy,
            state_number,
        )?;

        let tx =
            self.live_games[game_idx].get_transaction_for_move(env.allocator, existing_coin)?;

        let post_outcome = self.live_games[game_idx].outcome_puzzle_hash(env.allocator)?;

        Ok((
            last_puzzle_hash,
            post_outcome,
            self.state_number,
            move_result.details.clone(),
            tx,
        ))
    }

    pub fn game_coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
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
        let state_number = self.state_number;

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
                    TheirTurnCoinSpentResult::Expected(state_number, ph, amt, None),
                ));
            }
        }

        let spent_result = self.live_games[live_game_idx].their_turn_coin_spent(
            env.allocator,
            coin_string,
            conditions,
            state_number,
        )?;
        Ok(CoinSpentInformation::TheirSpend(spent_result))
    }

    /// Simple forward-only redo check.  `set_state_for_coins` already matched
    /// the game coin to the live game by amount.  We just check if the cached
    /// Check whether a pending redo move for this coin would result in zero
    /// reward for us (post-redo our_current_share == 0).  Used by the
    /// zero-reward early-out scan at unroll time.
    pub fn is_redo_zero_reward(&self, coin: &CoinString, game_id: &GameID) -> bool {
        let has_redo = self.cached_last_actions.iter().any(|entry| {
            if let CachedPotatoRegenerateLastHop::PotatoMoveHappening(move_data) = entry {
                move_data.game_id == *game_id
                    && coin
                        .to_parts()
                        .map(|(_, ph, _)| ph == move_data.match_puzzle_hash)
                        .unwrap_or(false)
            } else {
                false
            }
        });
        if !has_redo {
            return false;
        }
        // After the redo, our share is determined by the saved post-move
        // referee.  If the referee is not cached (serialization round-trip),
        // we can't check — be conservative and return false.
        for entry in &self.cached_last_actions {
            if let CachedPotatoRegenerateLastHop::PotatoMoveHappening(move_data) = entry {
                if move_data.game_id == *game_id {
                    if let Some(ref saved_ref) = move_data.saved_post_move_referee {
                        return saved_ref
                            .get_our_current_share()
                            .map(|share| share == Amount::default())
                            .unwrap_or(false);
                    }
                }
            }
        }
        false
    }

    pub fn has_redo_for_game_coin(&self, coin: &CoinString, game_id: &GameID) -> bool {
        self.cached_last_actions.iter().any(|entry| {
            if let CachedPotatoRegenerateLastHop::PotatoMoveHappening(move_data) = entry {
                move_data.game_id == *game_id
                    && coin
                        .to_parts()
                        .map(|(_, ph, _)| ph == move_data.match_puzzle_hash)
                        .unwrap_or(false)
            } else {
                false
            }
        })
    }

    pub fn accept_or_timeout_game_on_chain(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        coin: &CoinString,
    ) -> Result<Option<Spend>, Error> {
        if let Ok(game_idx) = self.get_game_by_id(game_id) {
            let tx = self.live_games[game_idx].get_transaction_for_timeout(env.allocator, coin)?;
            self.live_games.remove(game_idx);
            Ok(tx)
        } else if let Some(idx) = self
            .pending_accept_timeouts
            .iter()
            .position(|g| g.game_id == *game_id)
        {
            let tx = self.pending_accept_timeouts[idx]
                .get_transaction_for_timeout(env.allocator, coin)?;
            self.pending_accept_timeouts.remove(idx);
            Ok(tx)
        } else {
            Ok(None)
        }
    }

    pub fn get_game_state_id(&self, env: &mut ChannelHandlerEnv<'_>) -> Result<Hash, Error> {
        let mut bytes: Vec<u8> = Vec::with_capacity(self.live_games.len() * 32);
        for l in self.live_games.iter() {
            let ph = l.current_puzzle_hash(env.allocator)?;
            bytes.extend_from_slice(ph.bytes());
        }
        Ok(Sha256Input::Bytes(&bytes).hash())
    }
}
