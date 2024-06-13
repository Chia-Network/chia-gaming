pub mod game;
pub mod game_handler;
pub mod types;

use std::borrow::{Borrow, BorrowMut};

use rand::prelude::*;

use clvm_traits::ToClvm;
use clvmr::allocator::NodePtr;
use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;

use crate::channel_handler::types::{
    CachedPotatoRegenerateLastHop, ChannelCoin, ChannelCoinInfo, ChannelHandlerEnv, ChannelHandlerInitiationData,
    ChannelHandlerInitiationResult, ChannelHandlerPrivateKeys, CoinSpentAccept,
    CoinSpentDisposition, CoinSpentMoveUp, CoinSpentResult, DispositionResult, GameStartInfo,
    LiveGame, MoveResult, OnChainGameCoin, PotatoAcceptCachedData, PotatoMoveCachedData,
    PotatoSignatures, ReadableMove, ReadableUX, UnrollCoin, UnrollCoinConditionInputs,
};
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    ChiaIdentity, agg_sig_me_message, partial_signer, private_to_public_key,
    puzzle_for_pk, puzzle_hash_for_pk, sign_agg_sig_me, standard_solution_unsafe,
};
use crate::common::types::{
    usize_from_atom, Aggsig, Amount, CoinCondition, CoinID, CoinString, Error, GameID, IntoErr,
    Node, PrivateKey, PublicKey, Puzzle, PuzzleHash, RefereeID, Sha256tree,
    SpecificTransactionBundle, SpendRewardResult, ToQuotedProgram, TransactionBundle,
};
use crate::referee::RefereeMaker;

pub struct CoinDataForReward {
    coin_string: CoinString,
    parent: CoinID,
    puzzle_hash: PuzzleHash,
    amount: Amount,
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
/// Conditions that the uonrll coin makes needs a rem to ensure that we know
/// the latest game state number.
#[derive(Default)]
pub struct ChannelHandler {
    private_keys: ChannelHandlerPrivateKeys,

    my_referee_public_key: PublicKey,

    their_channel_coin_public_key: PublicKey,
    their_unroll_coin_public_key: PublicKey,
    their_referee_puzzle_hash: PuzzleHash,

    my_out_of_game_balance: Amount,
    their_out_of_game_balance: Amount,
    have_potato: bool,

    cached_last_action: Option<CachedPotatoRegenerateLastHop>,

    // Has a parity between the two players of whether have_potato means odd
    // or even, but odd-ness = have-potato is arbitrary.
    current_state_number: usize,
    // Increments per game started.
    next_nonce_number: usize,

    state_channel: ChannelCoinInfo,
    unroll: UnrollCoin,

    game_id_of_most_recent_move: Option<GameID>,
    game_id_of_most_recent_created_game: Option<GameID>,
    game_id_of_most_recent_accepted_game: Option<GameID>,
    referee_of_most_recent_accepted_game: Option<RefereeID>,

    // Live games
    live_games: Vec<LiveGame>,
}

impl ChannelHandler {
    pub fn new(private_keys: ChannelHandlerPrivateKeys) -> Self {
        ChannelHandler {
            private_keys,
            ..ChannelHandler::default()
        }
    }

    pub fn construct_with_rng<R: Rng>(rng: &mut R) -> ChannelHandler {
        ChannelHandler::new(rng.gen())
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

    pub fn unroll_coin_condition_inputs(
        &self,
        state_number: usize,
        puzzle_hashes_and_amounts: &[(PuzzleHash, Amount)]
    ) -> UnrollCoinConditionInputs {
        UnrollCoinConditionInputs {
            ref_pubkey: self.my_referee_public_key.clone(),
            their_referee_puzzle_hash: self.their_referee_puzzle_hash.clone(),
            have_potato: self.have_potato,
            state_number,
            my_balance: self.my_out_of_game_balance.clone(),
            their_balance: self.their_out_of_game_balance.clone(),
            puzzle_hashes_and_amounts: puzzle_hashes_and_amounts.to_vec(),
        }
    }

    pub fn state_channel_coin(&self) -> Result<&ChannelCoin, Error> {
        if let Some(ssc) = self.state_channel.coin.as_ref() {
            Ok(ssc)
        } else {
            Err(Error::StrErr(
                "send_potato_clean_shutdown without state_channel_coin".to_string(),
            ))
        }
    }

    /// Return the right public key to use for a clean shutdown.
    pub fn clean_shutdown_public_key(&self) -> PublicKey {
        private_to_public_key(&self.private_keys.my_channel_coin_private_key)
    }

    /// Return the right amount to use for a clean shutdown coin output.
    pub fn clean_shutdown_amount(&self) -> Amount {
        self.my_out_of_game_balance.clone()
    }

    pub fn create_conditions_and_signature_of_channel_coin<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        state_number: usize,
    ) -> Result<(NodePtr, NodePtr, Aggsig), Error> {
        let default_conditions = self.unroll.compute_unroll_coin_conditions(
            env,
            &self.unroll_coin_condition_inputs(
                state_number,
                &[]
            )
        )?;
        let default_conditions_hash = Node(default_conditions).sha256tree(env.allocator);
        let unroll_coin_parent = self.state_channel_coin()?;
        let unroll_puzzle = env.curried_unroll_puzzle(0, default_conditions_hash)?;
        let unroll_puzzle_hash = unroll_puzzle.sha256tree(env.allocator);
        let create_conditions = vec![Node(
            (
                CREATE_COIN,
                (
                    unroll_puzzle_hash.clone(),
                    (self.state_channel.amount.clone(), ()),
                ),
            )
                .to_clvm(env.allocator)
                .into_gen()?,
        )];
        let create_conditions_obj = create_conditions.to_clvm(env.allocator).into_gen()?;
        let create_conditions_with_rem =
            self.unroll.prepend_rem_conditions(env, state_number, create_conditions_obj)?;

        let (solution, signature) =
            unroll_coin_parent.get_solution_and_signature_from_conditions(
                env,
                &self.private_keys.my_channel_coin_private_key,
                create_conditions_with_rem,
                &self.get_aggregate_channel_public_key()
            )?;

        Ok((create_conditions_with_rem, solution, signature))
    }

    fn get_aggregate_unroll_public_key(&self) -> PublicKey {
        let public_key = private_to_public_key(&self.private_keys.my_unroll_coin_private_key);
        public_key + self.their_unroll_coin_public_key.clone()
    }

    fn get_aggregate_channel_public_key(&self) -> PublicKey {
        let public_key = private_to_public_key(&self.private_keys.my_channel_coin_private_key);
        public_key + self.their_channel_coin_public_key.clone()
    }

    fn setup_unroll_coin<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>
    ) -> Result<(), Error> {
        // Set the 'default conditions' and 'default conditions hash' needed for
        // the unroll coin.
        let referee_public_key = private_to_public_key(
            &self.private_keys.my_referee_private_key
        );
        self.unroll.setup_default_conditions(
            env,
            &self.unroll_coin_condition_inputs(0, &[])
        )?;
        let inputs = self.unroll_coin_condition_inputs(0, &[]);
        self.unroll.update(
            env,
            &self.private_keys.my_unroll_coin_private_key,
            &self.their_unroll_coin_public_key,
            // XXX might need to mutate slightly.
            &inputs
        )?;

        Ok(())
    }

    pub fn initiate<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        initiation: &ChannelHandlerInitiationData,
    ) -> Result<ChannelHandlerInitiationResult, Error> {
        let our_channel_pubkey =
            private_to_public_key(&self.private_keys.my_channel_coin_private_key);
        let our_unroll_pubkey =
            private_to_public_key(&self.private_keys.my_unroll_coin_private_key);
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
        self.my_referee_public_key = private_to_public_key(
            &self.private_keys.my_referee_private_key
        );
        self.have_potato = initiation.we_start_with_potato;
        self.unroll.started_with_potato = self.have_potato;
        self.their_channel_coin_public_key = initiation.their_channel_pubkey.clone();
        self.their_unroll_coin_public_key = initiation.their_unroll_pubkey.clone();
        self.their_referee_puzzle_hash = initiation.their_referee_puzzle_hash.clone();
        self.my_out_of_game_balance = initiation.my_contribution.clone();
        self.their_out_of_game_balance = initiation.their_contribution.clone();

        let aggregate_public_key = self.get_aggregate_channel_public_key();
        let state_channel_coin_puzzle_hash =
            puzzle_hash_for_pk(env.allocator, &aggregate_public_key)?;
        self.state_channel.coin = Some(ChannelCoin::new(CoinString::from_parts(
            &initiation.launcher_coin_id,
            &state_channel_coin_puzzle_hash,
            &self.state_channel.amount,
        )));

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

        // We need a spend of the channel coin to sign.
        // The seq number is zero.
        // There are no game coins and a balance for both sides.
        self.setup_unroll_coin(env)?;

        let shared_puzzle_hash = puzzle_hash_for_pk(env.allocator, &aggregate_public_key)?;
        eprintln!("aggregate_public_key {aggregate_public_key:?}");
        eprintln!("shared_puzzle_hash {shared_puzzle_hash:?}");
        let curried_unroll_puzzle = self.unroll.make_curried_unroll_puzzle(
            env,
            &self.get_aggregate_unroll_public_key(),
            self.current_state_number,
        )?;
        let curried_unroll_puzzle_hash = Node(curried_unroll_puzzle).sha256tree(env.allocator);
        let create_unroll_coin_conditions = (
            (
                CREATE_COIN,
                (
                    curried_unroll_puzzle_hash,
                    (self.state_channel.amount.clone(), ()),
                ),
            ),
            (),
        )
            .to_clvm(env.allocator)
            .into_gen()?;
        let quoted_create_unroll_coin_conditions =
            create_unroll_coin_conditions.to_quoted_program(env.allocator)?;
        let create_unroll_coin_conditions_hash =
            quoted_create_unroll_coin_conditions.sha256tree(env.allocator);

        let signature = partial_signer(
            &self.private_keys.my_channel_coin_private_key,
            &aggregate_public_key,
            &create_unroll_coin_conditions_hash.bytes(),
        );

        self.state_channel.spend = TransactionBundle {
            puzzle: puzzle_for_pk(env.allocator, &aggregate_public_key)?,
            solution: quoted_create_unroll_coin_conditions.to_nodeptr(),
            signature: signature.clone(),
        };

        Ok(ChannelHandlerInitiationResult {
            channel_puzzle_hash_up: shared_puzzle_hash,
            my_initial_channel_half_signature_peer: signature,
        })
    }

    pub fn finish_handshake<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        their_initial_channel_hash_signature: &Aggsig,
    ) -> Result<(), Error> {
        let aggregate_public_key = self.get_aggregate_channel_public_key();
        // let state_channel_coin =
        //     if let Some(ssc) = self.state_channel_coin_string.as_ref() {
        //         ssc.to_coin_id()
        //     } else {
        //         return Err(Error::StrErr("send_potato_clean_shutdown without state_channel_coin".to_string()));
        //     };

        let hash_of_initial_channel_coin_solution =
            Node(self.state_channel.spend.solution).sha256tree(env.allocator);

        eprintln!(
            "our {} sig {:?}",
            self.unroll.started_with_potato, self.state_channel.spend.signature
        );
        eprintln!("their sig {:?}", their_initial_channel_hash_signature);
        let combined_signature = self.state_channel.spend.signature.clone()
            + their_initial_channel_hash_signature.clone();

        if !combined_signature.verify(
            &aggregate_public_key,
            &hash_of_initial_channel_coin_solution.bytes(),
        ) {
            return Err(Error::StrErr(
                "finish_handshake: Signature verify failed for other party's signature".to_string(),
            ));
        }

        self.state_channel.spend.signature = combined_signature;
        Ok(())
    }

    pub fn update_cached_unroll_state<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        state_number_for_spend: usize,
    ) -> Result<PotatoSignatures, Error> {
        let (_channel_coin_conditions, _, channel_coin_signature) =
            self.create_conditions_and_signature_of_channel_coin(env, state_number_for_spend)?;

        let new_game_coins_on_chain: Vec<(PuzzleHash, Amount)> = self
            .get_new_game_coins_on_chain(env, None, &[], None)
            .iter()
            .filter_map(|ngc| ngc.coin_string_up.as_ref().and_then(|c| c.to_parts()))
            .map(|(_, puzzle_hash, amount)| (puzzle_hash, amount))
            .collect();

        let unroll_conditions = self.unroll.compute_unroll_coin_conditions(
            env,
            &self.unroll_coin_condition_inputs(
                state_number_for_spend,
                &new_game_coins_on_chain
            )
        )?;
        let quoted_conditions = unroll_conditions.to_quoted_program(env.allocator)?;
        let quoted_conditions_hash = quoted_conditions.sha256tree(env.allocator);
        let unroll_public_key =
            private_to_public_key(&self.private_keys.my_unroll_coin_private_key);
        let unroll_aggregate_key =
            unroll_public_key.clone() + self.their_unroll_coin_public_key.clone();
        let unroll_signature = partial_signer(
            &self.private_keys.my_unroll_coin_private_key,
            &unroll_aggregate_key,
            &quoted_conditions_hash.bytes(),
        );

        self.unroll.unroll_coin_spend_signature = unroll_signature.clone();

        Ok(PotatoSignatures {
            my_channel_half_signature_peer: channel_coin_signature,
            my_unroll_half_signature_peer: unroll_signature,
        })
    }

    pub fn send_empty_potato<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
    ) -> Result<PotatoSignatures, Error> {
        // We let them spend a state number 1 higher but nothing else changes.
        self.current_state_number += 1;
        self.update_cache_for_potato_send(None);

        self.update_cached_unroll_state(env, self.current_state_number)
    }

    pub fn verify_channel_coin_from_peer_signatures<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        their_channel_half_signature: &Aggsig,
        conditions: NodePtr,
    ) -> Result<(NodePtr, Aggsig, bool), Error> {
        let aggregate_public_key = self.get_aggregate_channel_public_key();
        let state_channel_coin = self.state_channel_coin()?;
        let spend = self.state_channel_coin()?;
        let (solution, signature) =
            spend.get_solution_and_signature_from_conditions(
                env,
                &self.private_keys.my_channel_coin_private_key,
                conditions,
                &aggregate_public_key
            )?;

        let quoted_conditions = conditions.to_quoted_program(env.allocator)?;
        let quoted_conditions_hash = quoted_conditions.sha256tree(env.allocator);
        let full_signature = signature.aggregate(their_channel_half_signature);
        let message_to_verify = agg_sig_me_message(
            &quoted_conditions_hash.bytes(),
            &state_channel_coin.to_coin_id(),
            &env.agg_sig_me_additional_data,
        );

        Ok((
            solution,
            signature,
            full_signature.verify(&aggregate_public_key, &message_to_verify),
        ))
    }

    pub fn received_potato_verify_signatures<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        signatures: &PotatoSignatures,
        state_number_for_spend: usize,
    ) -> Result<(), Error> {
        let (conditions, _, _) =
            self.create_conditions_and_signature_of_channel_coin(env, state_number_for_spend)?;
        eprintln!(
            "channel spend conditions {}",
            disassemble(env.allocator.allocator(), conditions, None)
        );

        if !self
            .verify_channel_coin_from_peer_signatures(
                env,
                &signatures.my_channel_half_signature_peer,
                conditions,
            )?
            .2
        {
            return Err(Error::StrErr(
                "bad channel verify".to_string(),
            ));
        }

        // Check the signature of the unroll coin spend.
        let (_curried_unroll_puzzle, unroll_puzzle_solution) = self.unroll.make_unroll_puzzle_solution(
            env,
            &self.get_aggregate_unroll_public_key(),
            state_number_for_spend,
        )?;
        let quoted_unroll_puzzle_solution =
            unroll_puzzle_solution.to_quoted_program(env.allocator)?;
        let quoted_unroll_puzzle_solution_hash =
            quoted_unroll_puzzle_solution.sha256tree(env.allocator);

        let unroll_public_key =
            private_to_public_key(&self.private_keys.my_unroll_coin_private_key);
        let aggregate_unroll_public_key =
            unroll_public_key.clone() + self.their_unroll_coin_public_key.clone();
        let aggregate_unroll_signature = signatures.my_unroll_half_signature_peer.clone()
            + self.unroll.unroll_coin_spend_signature.clone();
        if !aggregate_unroll_signature.verify(
            &aggregate_unroll_public_key,
            &quoted_unroll_puzzle_solution_hash.bytes(),
        ) {
            return Err(Error::StrErr(
                "bad unroll signature verify".to_string(),
            ));
        }

        Ok(())
    }

    pub fn received_empty_potato<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        signatures: &PotatoSignatures,
    ) -> Result<(), Error> {
        self.received_potato_verify_signatures(env, signatures, self.current_state_number + 1)?;

        // We have the potato.
        self.have_potato = true;
        self.current_state_number += 1;
        self.unroll.unroll_state_number = self.current_state_number;

        self.update_cached_unroll_state(env, self.current_state_number)?;

        Ok(())
    }

    pub fn add_games<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        start_info_list: &[GameStartInfo],
    ) -> Result<(), Error> {
        for g in start_info_list.iter() {
            let new_game_nonce = self.next_nonce_number;
            self.next_nonce_number += 1;

            let referee_identity = ChiaIdentity::new(
                &mut env.allocator,
                self.private_keys.my_referee_private_key.clone()
            )?;
            self.live_games.push(LiveGame {
                game_id: g.game_id.clone(),
                referee_maker: Box::new(RefereeMaker::new(
                    env.referee_coin_puzzle.clone(),
                    env.referee_coin_puzzle_hash.clone(),
                    g,
                    referee_identity,
                    &self.their_referee_puzzle_hash,
                    new_game_nonce,
                )?),
            });
        }

        Ok(())
    }

    pub fn send_potato_start_game<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        my_contribution_this_game: Amount,
        their_contribution_this_game: Amount,
        start_info_list: &[GameStartInfo],
    ) -> Result<PotatoSignatures, Error> {
        // let my_new_balance = self.my_out_of_game_balance.clone() - my_contribution_this_game.clone();
        // let their_new_balance = self.their_out_of_game_balance.clone() - their_contribution_this_game.clone();

        // We let them spend a state number 1 higher but nothing else changes.
        self.update_cache_for_potato_send(Some(CachedPotatoRegenerateLastHop::PotatoCreatedGame(
            start_info_list.iter().map(|g| g.game_id.clone()).collect(),
            my_contribution_this_game.clone(),
            their_contribution_this_game.clone(),
        )));

        self.have_potato = false;
        self.current_state_number += 1;
        self.add_games(env, start_info_list)?;

        self.update_cached_unroll_state(env, self.current_state_number)
    }

    pub fn received_potato_start_game<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        signatures: &PotatoSignatures,
        start_info_list: &[GameStartInfo],
    ) -> Result<(), Error> {
        self.received_potato_verify_signatures(
            env,
            signatures,
            self.current_state_number + 1
        )?;

        // We have the potato.
        self.have_potato = true;
        self.current_state_number += 1;
        self.unroll.unroll_state_number = self.current_state_number;

        self.add_games(env, start_info_list)?;

        self.update_cached_unroll_state(env, self.current_state_number)?;

        Ok(())
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
    ) -> Result<MoveResult, Error> {
        let game_idx = self.get_game_by_id(game_id)?;

        let referee_maker: &mut RefereeMaker = self.live_games[game_idx].referee_maker.borrow_mut();
        let referee_result =
            referee_maker.my_turn_make_move(env.rng, env.allocator, readable_move)?;

        let puzzle_hash = referee_result.puzzle_hash_for_unroll.clone();
        let amount = referee_result.details.basic.mover_share.clone();

        self.have_potato = false;
        self.current_state_number += 1;
        // We let them spend a state number 1 higher but nothing else changes.
        self.update_cache_for_potato_send(Some(
            CachedPotatoRegenerateLastHop::PotatoMoveHappening(PotatoMoveCachedData {
                game_id: game_id.clone(),
                puzzle_hash,
                amount,
            }),
        ));

        let signatures = self.update_cached_unroll_state(env, self.current_state_number)?;

        Ok(MoveResult {
            signatures,
            game_move: referee_result.details.clone()
        })
    }

    pub fn received_potato_move<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        game_id: &GameID,
        move_result: &MoveResult,
    ) -> Result<(NodePtr, Vec<u8>), Error> {
        let game_idx = self.get_game_by_id(game_id)?;

        let referee_maker: &mut RefereeMaker = self.live_games[game_idx].referee_maker.borrow_mut();
        let their_move_result = referee_maker.their_turn_move_off_chain(
            env.allocator,
            &move_result.game_move
        )?;

        self.received_potato_verify_signatures(
            env,
            &move_result.signatures,
            self.current_state_number + 1,
        )?;

        // We have the potato.
        self.have_potato = true;
        self.current_state_number += 1;
        self.unroll.unroll_state_number = self.current_state_number;

        // Needs to know their puzzle_hash_for_unroll so we can keep it to do
        // the unroll spend.

        // Check whether the unroll_puzzle_hash is right.
        // Check whether the spend signed in the Move Result is valid by using
        // the unroll puzzle hash that was given to us.
        self.update_cached_unroll_state(env, self.current_state_number)?;

        Ok((their_move_result.readable_move, their_move_result.message))
    }

    pub fn received_message<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        game_id: &GameID,
        message: &[u8],
    ) -> Result<ReadableUX, Error> {
        let game_idx = self.get_game_by_id(game_id)?;

        self.live_games[game_idx]
            .referee_maker
            .receive_readable(env.allocator, message)
    }

    pub fn send_potato_accept<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        game_id: &GameID,
    ) -> Result<(PotatoSignatures, Amount), Error> {
        let game_idx = self.get_game_by_id(game_id)?;

        // referee maker is removed and will be destroyed when we leave this
        // function.
        let live_game = self.live_games.remove(game_idx);

        let puzzle_hash = live_game.referee_maker.get_current_puzzle_hash();

        self.current_state_number += 1;
        let amount = live_game.referee_maker.get_our_current_share();
        let at_stake = live_game.referee_maker.get_amount();

        self.have_potato = false;
        self.update_cache_for_potato_send(if amount == Amount::default() {
            None
        } else {
            Some(CachedPotatoRegenerateLastHop::PotatoAccept(
                PotatoAcceptCachedData {
                    game_id: game_id.clone(),
                    puzzle_hash,
                    live_game,
                    at_stake_amount: at_stake,
                    our_share_amount: amount.clone(),
                },
            ))
        });

        let signatures = self.update_cached_unroll_state(env, self.current_state_number)?;

        Ok((signatures, amount))
    }

    pub fn received_potato_accept<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        _signautures: &PotatoSignatures,
        game_id: &GameID,
    ) -> Result<(), Error> {
        let game_idx = self.get_game_by_id(game_id)?;

        // XXX We need to check the signatures

        self.live_games.remove(game_idx);

        // We have the potato.
        self.have_potato = true;
        self.current_state_number += 1;
        self.unroll.unroll_state_number = self.current_state_number;

        self.update_cached_unroll_state(env, self.current_state_number)?;

        Ok(())
    }

    /// Uses the channel coin key to post standard format coin generation to the
    /// real blockchain via a TransactionBundle.
    pub fn send_potato_clean_shutdown<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        conditions: NodePtr,
    ) -> Result<TransactionBundle, Error> {
        assert!(self.have_potato);
        let aggregate_public_key = self.get_aggregate_channel_public_key();
        let spend = self.state_channel_coin()?;

        let (solution, signature) =
            spend.get_solution_and_signature_from_conditions(
                env,
                &self.private_keys.my_channel_coin_private_key,
                conditions,
                &aggregate_public_key
            )?;

        Ok(TransactionBundle {
            solution,
            signature,
            puzzle: puzzle_for_pk(env.allocator, &aggregate_public_key)?,
        })
    }

    pub fn state_channel_coin_solution_and_signature<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        conditions: NodePtr,
    ) -> Result<(NodePtr, Aggsig), Error> {
        let aggregate_public_key = self.get_aggregate_channel_public_key();
        let spend = self.state_channel_coin()?;
        let (solution, signature) =
            spend.get_solution_and_signature_from_conditions(
                env,
                &self.private_keys.my_channel_coin_private_key,
                conditions,
                &aggregate_public_key
            )?;

        Ok((solution, signature))
    }

    pub fn received_potato_clean_shutdown<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        their_channel_half_signature: &Aggsig,
        conditions: NodePtr,
    ) -> Result<TransactionBundle, Error> {
        let aggregate_public_key = self.get_aggregate_channel_public_key();

        assert!(!self.have_potato);
        let (solution, signature, verified) = self.verify_channel_coin_from_peer_signatures(
            env,
            &their_channel_half_signature,
            conditions,
        )?;

        if !verified {
            return Err(Error::StrErr(
                "received_potato_clean_shutdown full signature didn't verify".to_string(),
            ));
        }

        Ok(TransactionBundle {
            solution,
            signature,
            puzzle: puzzle_for_pk(env.allocator, &aggregate_public_key)?,
        })
    }

    fn break_out_conditions_for_spent_coin<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        conditions: NodePtr,
    ) -> Result<Vec<Vec<u8>>, Error> {
        // Figure out our state number vs the one given in conditions.
        let rem_conditions: Vec<Vec<u8>> = CoinCondition::from_nodeptr(env.allocator, conditions)
            .iter()
            .filter_map(|c| {
                if let CoinCondition::Rem(data) = c {
                    return data.first().cloned();
                }

                None
            })
            .collect();

        if rem_conditions.len() < 2 {
            return Err(Error::StrErr(
                "Wrong number of rems in conditions".to_string(),
            ));
        }

        Ok(rem_conditions)
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
    pub fn channel_coin_spent<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        conditions: NodePtr,
    ) -> Result<(TransactionBundle, bool), Error> {
        // prepend_rem_conditions(env, self.current_state_number, result_coins.to_clvm(env.allocator).into_gen()?)
        let rem_conditions = self.break_out_conditions_for_spent_coin(env, conditions)?;

        let state_number = if let Some(state_number) = usize_from_atom(&rem_conditions[0]) {
            state_number
        } else {
            return Err(Error::StrErr("Unconvertible state number".to_string()));
        };

        let our_parity = self.unroll.unroll_state_number & 1;
        let their_parity = state_number & 1;

        if state_number > self.unroll.unroll_state_number {
            return Err(Error::StrErr("Reply from the future".to_string()));
        } else if state_number < self.unroll.unroll_state_number {
            if our_parity == their_parity {
                return Err(Error::StrErr(
                    "We're superceding ourselves from the past?".to_string(),
                ));
            }

            // Superceding state no timeout
            // Provide a reveal of the unroll puzzle.
            // Provide last unroll conditions
            // Should have a cached signature for unrolling

            // Full unroll puzzle reveal includes the curried info,
            let (curried_unroll_puzzle, unroll_puzzle_solution) = self
                .unroll.make_unroll_puzzle_solution(
                    env,
                    &self.get_aggregate_unroll_public_key(),
                    state_number,
                )?;

            Ok((
                TransactionBundle {
                    puzzle: Puzzle::from_nodeptr(curried_unroll_puzzle),
                    solution: unroll_puzzle_solution,
                    signature: self.unroll.unroll_coin_spend_signature.clone(),
                },
                false,
            ))
        } else if state_number == self.unroll.unroll_state_number {
            // Timeout
            let (curried_unroll_puzzle, unroll_puzzle_solution) = self
                .unroll.make_unroll_puzzle_solution(
                    env,
                    &self.get_aggregate_unroll_public_key(),
                    state_number,
                )?;

            Ok((
                TransactionBundle {
                    puzzle: Puzzle::from_nodeptr(curried_unroll_puzzle),
                    solution: unroll_puzzle_solution,
                    signature: Aggsig::default(),
                },
                true,
            ))
        } else if state_number == self.current_state_number {
            // Different timeout, construct the conditions based on the current
            // state.  (different because we're not using the conditions we
            // have cached).
            let (curried_unroll_puzzle, unroll_puzzle_solution) =
                self.unroll.make_unroll_puzzle_solution(
                    env,
                    &self.get_aggregate_unroll_public_key(),
                    state_number,
                )?;

            Ok((
                TransactionBundle {
                    puzzle: Puzzle::from_nodeptr(curried_unroll_puzzle),
                    solution: unroll_puzzle_solution,
                    signature: Aggsig::default(),
                },
                true,
            ))
        } else {
            Err(Error::StrErr(format!(
                "Unhandled relationship between state numbers {state_number} {}",
                self.unroll.unroll_state_number
            )))
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
        } else if state_number != self.unroll.unroll_state_number {
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
                    disposition: CoinSpentDisposition::CancelledUX(ids.iter().cloned().collect()),
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
                    cached.live_game.referee_maker.get_transaction_for_move(
                        env.allocator,
                        &game_coin,
                        &env.agg_sig_me_additional_data,
                    )?;

                Ok(Some(DispositionResult {
                    disposition: CoinSpentDisposition::Accept(CoinSpentAccept {
                        game_id: cached.game_id.clone(),
                        spend: SpecificTransactionBundle {
                            coin: unroll_coin.clone(),
                            bundle: spend_transaction.bundle.clone(),
                        },
                        reward_coin: spend_transaction.reward_coin,
                    }),
                    skip_game: Vec::default(),
                    skip_coin_id: None,
                    our_contribution_adjustment: Amount::default(),
                }))
            }
            Some(CachedPotatoRegenerateLastHop::PotatoMoveHappening(cached)) => {
                let game_idx = if let Some(game_idx) = self
                    .live_games
                    .iter()
                    .position(|g| g.game_id == cached.game_id)
                {
                    game_idx
                } else {
                    return Err(Error::StrErr(
                        "cached move with no matching game left".to_string(),
                    ));
                };

                let game_coin = CoinString::from_parts(
                    &unroll_coin.to_coin_id(),
                    &cached.puzzle_hash,
                    &cached.amount,
                );

                let spend_transaction = self.live_games[game_idx]
                    .referee_maker
                    .get_transaction_for_move(
                        env.allocator,
                        &game_coin,
                        &env.agg_sig_me_additional_data,
                    )?;

                // Existing game coin is in the before state.
                Ok(Some(DispositionResult {
                    disposition: CoinSpentDisposition::Move(CoinSpentMoveUp {
                        game_id: cached.game_id.clone(),
                        spend_before_game_coin: SpecificTransactionBundle {
                            coin: game_coin.clone(),
                            bundle: spend_transaction.bundle.clone(),
                        },
                        after_update_game_coin: spend_transaction.reward_coin.clone(),
                    }),
                    skip_coin_id: Some(cached.game_id.clone()),
                    skip_game: Vec::default(),
                    our_contribution_adjustment: Amount::default(),
                }))
            }
        }
    }

    pub fn get_new_game_coins_on_chain<R: Rng>(
        &self,
        _env: &mut ChannelHandlerEnv<R>,
        unroll_coin: Option<&CoinID>,
        skip_game: &[GameID],
        skip_coin_id: Option<&GameID>,
    ) -> Vec<OnChainGameCoin> {
        // It's ok to not have a proper coin id here when we only want
        // the puzzle hashes and amounts.
        let parent_coin_id = unroll_coin.cloned().unwrap_or_default();

        self.live_games
            .iter()
            .filter(|game| !skip_game.contains(&game.game_id))
            .map(|game| {
                let coin = if skip_coin_id == Some(&game.game_id) {
                    None
                } else {
                    Some(CoinString::from_parts(
                        &parent_coin_id,
                        &game.referee_maker.get_current_puzzle_hash(),
                        &game.referee_maker.get_amount(),
                    ))
                };

                OnChainGameCoin {
                    game_id_up: game.game_id.clone(),
                    coin_string_up: coin,
                    referee_up: game.referee_maker.borrow(),
                }
            })
            .collect()
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
    pub fn unroll_coin_spent<'a, R: Rng>(
        &'a self,
        env: &mut ChannelHandlerEnv<R>,
        unroll_coin: &CoinString,
        conditions: NodePtr,
    ) -> Result<CoinSpentResult<'a>, Error> {
        let rem_conditions = self.break_out_conditions_for_spent_coin(env, conditions)?;

        let state_number = if let Some(state_number) = usize_from_atom(&rem_conditions[0]) {
            state_number
        } else {
            return Err(Error::StrErr("Unconvertible state number".to_string()));
        };

        let disposition =
            self.get_cached_disposition_for_spent_result(
                env,
                unroll_coin,
                state_number
            )?;

        // return list of triples of game_id, coin_id, referee maker pulling from a list of pairs of (id, ref maker)
        let new_game_coins_on_chain = self.get_new_game_coins_on_chain(
            env,
            Some(&unroll_coin.to_coin_id()),
            &disposition.as_ref().map(|d| d.skip_game.clone()).unwrap_or_default(),
            disposition.as_ref().and_then(|d| d.skip_coin_id.as_ref()),
        );

        // coin with = parent is the unroll coin id and whose puzzle hash is ref and amount is my vanilla amount.
        let referee_public_key = private_to_public_key(&self.referee_private_key());
        let referee_puzzle_hash = puzzle_hash_for_pk(env.allocator, &referee_public_key)?;
        let adjusted_amount = disposition
            .as_ref()
            .map(|d| d.our_contribution_adjustment.clone())
            .unwrap_or_else(|| Amount::default());

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
        let spend_coin_puzzle = puzzle_for_pk(env.allocator, &referee_pk)?;

        for c in coins.iter() {
            if let Some((parent, ph, amount)) = c.to_parts() {
                assert_eq!(ph, referee_puzzle_hash);
                total_amount += amount.clone();
                exploded_coins.push(CoinDataForReward {
                    coin_string: c.clone(),
                    parent,
                    puzzle_hash: ph,
                    amount,
                });
            } else {
                return Err(Error::StrErr(
                    "ill formed coin passed to spend coin rewards".to_string(),
                ));
            }
        }

        let mut coins_with_solutions = Vec::default();

        for (i, coin) in exploded_coins.iter().enumerate() {
            let parent_id = coin.coin_string.to_coin_id();
            let conditions = if i == 0 {
                (CREATE_COIN, (parent_id.clone(), (total_amount.clone(), ())))
                    .to_clvm(env.allocator)
                    .into_gen()?
            } else {
                ().to_clvm(env.allocator).into_gen()?
            };

            let quoted_program = conditions.to_quoted_program(env.allocator)?;
            let quoted_program_hash = quoted_program.sha256tree(env.allocator);
            let signature = sign_agg_sig_me(
                &self.referee_private_key(),
                &quoted_program_hash.bytes(),
                &parent_id,
                &env.agg_sig_me_additional_data,
            );

            coins_with_solutions.push(TransactionBundle {
                puzzle: spend_coin_puzzle.clone(),
                solution: standard_solution_unsafe(
                    env.allocator,
                    &self.referee_private_key(),
                    conditions,
                )?
                .0,
                signature,
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
}
