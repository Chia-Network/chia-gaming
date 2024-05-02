use rand::prelude::*;

use clvmr::allocator::{Allocator, NodePtr};
use clvm_traits::ToClvm;

use crate::common::constants::{CREATE_COIN, REM};
use crate::common::types::{Aggsig, Amount, CoinString, GameID, PuzzleHash, PublicKey, RefereeID, Error, Hash, IntoErr, Sha256tree, Node, SpentResult, TransactionBundle, SpendRewardResult, Program, ToQuotedProgram, PrivateKey};
use crate::common::standard_coin::{private_to_public_key, puzzle_hash_for_pk, aggregate_public_keys, standard_solution_partial, unsafe_sign_partial, solution_for_conditions, puzzle_for_pk, agg_sig_me_message};
use crate::channel_handler::types::{ChannelHandlerEnv, ChannelHandlerPrivateKeys, UnrollCoinSignatures, ChannelHandlerInitiationData, ChannelHandlerInitiationResult, PotatoSignatures, GameStartInfo, ReadableMove, MoveResult, ReadableUX, CoinSpentResult};

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

    pub fn channel_private_key(&self) -> PrivateKey {
        self.private_keys.my_channel_coin_private_key.clone()
    }

    pub fn unroll_private_key(&self) -> PrivateKey {
        self.private_keys.my_unroll_coin_private_key.clone()
    }

    /// Return the right public key to use for a clean shutdown.
    pub fn clean_shutdown_public_key(&self) -> PublicKey {
        private_to_public_key(&self.private_keys.my_channel_coin_private_key)
    }

    /// Return the right amount to use for a clean shutdown coin output.
    pub fn clean_shutdown_amount(&self) -> Amount {
        self.my_out_of_game_balance.clone()
    }

    pub fn prepend_state_number_rem_to_conditions(&self, env: &mut ChannelHandlerEnv, state_number: usize, conditions: NodePtr) -> Result<NodePtr, Error> {
        // Add rem condition for the state number
        let rem_condition = (REM, (state_number, ()));
        (rem_condition, Node(conditions)).to_clvm(env.allocator).into_gen()
    }

    /// Returns a list of create coin conditions which the unroll coin should do.
    /// We don't care about the parent coin id since we're not constraining it.
    ///
    /// The order is important and the first two coins' order are determined by
    /// whether the potato was ours first.
    pub fn get_unroll_coin_conditions(
        &self,
        env: &mut ChannelHandlerEnv,
        my_balance: &Amount,
        their_balance: &Amount,
        puzzle_hashes_and_amounts: &[(PuzzleHash, Amount)]
    ) -> Result<NodePtr, Error> {
        let their_first_coin = (CREATE_COIN, (self.their_referee_puzzle_hash.clone(), (their_balance.clone(), ())));

        // Our ref is a standard puzzle whose public key is our ref pubkey.
        let ref_pubkey = private_to_public_key(&self.private_keys.my_referee_private_key);
        let standard_puzzle_hash_of_ref = puzzle_hash_for_pk(env.allocator, &ref_pubkey)?;

        let our_first_coin = (CREATE_COIN, (standard_puzzle_hash_of_ref, (my_balance.clone(), ())));

        let (start_coin_one, start_coin_two) =
            if self.started_with_potato {
                (our_first_coin, their_first_coin)
            } else {
                (their_first_coin, our_first_coin)
            };

        let start_coin_one_clvm = start_coin_one.to_clvm(env.allocator).into_gen()?;
        let start_coin_two_clvm = start_coin_two.to_clvm(env.allocator).into_gen()?;
        let mut result_coins: Vec<Node> = vec![
            Node(start_coin_one_clvm),
            Node(start_coin_two_clvm),
        ];

        // Signatures for the unroll puzzle are always unsafe.
        // Signatures for the channel puzzle are always safe (std format).
        // Meta puzzle for the unroll can't be standard.
        for (ph, a) in puzzle_hashes_and_amounts.iter() {
            let clvm_conditions = (CREATE_COIN, (ph.clone(), (a.clone(), ()))).to_clvm(env.allocator).into_gen()?;
            result_coins.push(Node(clvm_conditions));
        }

        Ok((result_coins).to_clvm(env.allocator).into_gen()?)
    }

    pub fn create_conditions_and_signature_of_channel_coin(&self, env: &mut ChannelHandlerEnv) -> Result<(NodePtr, Aggsig), Error> {
        let amount_of_unroll_coin = self.my_out_of_game_balance.clone() + self.their_out_of_game_balance.clone();
        let default_conditions = self.get_unroll_coin_conditions(env, &self.my_out_of_game_balance, &self.their_out_of_game_balance, &[])?;
        let default_conditions_hash = Node(default_conditions).sha256tree(env.allocator);
        let unroll_coin_parent =
            if let Some(coin_string) = self.state_channel_coin_string.as_ref() {
                coin_string.to_coin_id()
            } else {
                return Err(Error::Channel("create_conditions_and_signature_of_channel_coin without having created state_channel_coin_string".to_string()));
            };
        let unroll_puzzle = env.curried_unroll_puzzle(0, default_conditions_hash)?;
        let unroll_puzzle_hash = unroll_puzzle.sha256tree(env.allocator);
        let create_conditions = vec![
            Node((CREATE_COIN, (unroll_puzzle_hash.clone(), (amount_of_unroll_coin, ()))).to_clvm(env.allocator).into_gen()?)
        ];
        let create_conditions_obj = create_conditions.to_clvm(env.allocator).into_gen()?;
        let channel_coin_public_key = private_to_public_key(&self.private_keys.my_channel_coin_private_key);
        let aggregated_key_for_unroll_create = aggregate_public_keys(&channel_coin_public_key, &self.their_channel_coin_public_key);
        standard_solution_partial(
            env.allocator,
            &self.private_keys.my_unroll_coin_private_key,
            &unroll_coin_parent,
            create_conditions_obj,
            &aggregated_key_for_unroll_create,
            &env.agg_sig_me_additional_data
        )
    }

    pub fn create_conditions_and_signature_to_spend_unroll_coin(&self, env: &mut ChannelHandlerEnv, conditions: NodePtr) -> Result<(NodePtr, Aggsig), Error> {
        // Should make together two signatures.  One for the unroll coin and
        // one to spend the unroll coin.
        let unroll_private_key = &self.private_keys.my_unroll_coin_private_key;
        let conditions_hash = Node(conditions).sha256tree(env.allocator);
        let unroll_pubkey = private_to_public_key(&unroll_private_key);
        let aggregate_key_for_unroll_unsafe_sig = aggregate_public_keys(&unroll_pubkey, &self.their_unroll_coin_public_key);
        let to_spend_unroll_sig = unsafe_sign_partial(unroll_private_key, &aggregate_key_for_unroll_unsafe_sig, &conditions_hash.bytes());
        Ok((conditions.clone(), to_spend_unroll_sig))
    }

    pub fn state_channel_unroll_signature(&self, env: &mut ChannelHandlerEnv, conditions: NodePtr) -> Result<UnrollCoinSignatures, Error> {
        let (_, to_create_unroll_sig) = self.create_conditions_and_signature_of_channel_coin(env)?;
        let (_, to_spend_unroll_sig) = self.create_conditions_and_signature_of_channel_coin(env)?;

        Ok(UnrollCoinSignatures {
            to_create_unroll_coin: to_create_unroll_sig,
            to_spend_unroll_coin: to_spend_unroll_sig
        })
    }

    pub fn initiate(&mut self, env: &mut ChannelHandlerEnv, initiation: &ChannelHandlerInitiationData) -> Result<ChannelHandlerInitiationResult, Error> {
        let our_channel_pubkey = private_to_public_key(&self.private_keys.my_channel_coin_private_key);
        let our_unroll_pubkey = private_to_public_key(&self.private_keys.my_unroll_coin_private_key);
        if initiation.their_channel_pubkey == our_channel_pubkey {
            return Err(Error::Channel("Duplicated channel coin public key".to_string()));
        }

        if initiation.their_unroll_pubkey == our_unroll_pubkey {
            return Err(Error::Channel("Duplicated unroll coin public key".to_string()));
        }

        let combined_state_channel_pubkey = aggregate_public_keys(&our_channel_pubkey, &initiation.their_channel_pubkey);
        let state_channel_coin_puzzle_hash = puzzle_hash_for_pk(env.allocator, &combined_state_channel_pubkey)?;
        let state_channel_coin_amt = initiation.my_contribution.clone() + initiation.their_contribution.clone();
        self.state_channel_coin_string = Some(CoinString::from_parts(&initiation.launcher_coin_id, &state_channel_coin_puzzle_hash, &state_channel_coin_amt));

        self.have_potato = initiation.we_start_with_potato;
        self.started_with_potato = self.have_potato;
        self.their_channel_coin_public_key = initiation.their_channel_pubkey.clone();
        eprintln!("their channel pubkey (init) {:?} vs {:?}", self.their_channel_coin_public_key, initiation.their_channel_pubkey);
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
        let combined_public_key = aggregate_public_keys(&our_channel_pubkey, &self.their_channel_coin_public_key);
        let shared_puzzle_hash = puzzle_hash_for_pk(env.allocator, &combined_public_key)?;

        // Signature signs the conditions.
        // Seems like the conditions are the DEFAULT_CONDITIONS of the state
        // channel unroll.

        // We need a spend of the channel coin to sign.
        // The seq number is zero.
        // There are no game coins and a balance for both sides.

        let default_conditions = self.get_unroll_coin_conditions(env, &self.my_out_of_game_balance, &self.their_out_of_game_balance, &[])?;
        let default_conditions_hash = Node(default_conditions).sha256tree(env.allocator);
        let signature = self.private_keys.my_channel_coin_private_key.sign(&default_conditions_hash.bytes());

        Ok(ChannelHandlerInitiationResult {
            channel_puzzle_hash_up: shared_puzzle_hash,
            my_initial_channel_half_signature_peer: signature,
        })
    }

    pub fn finish_handshake(&mut self, env: &mut ChannelHandlerEnv, their_initial_channel_hash_signature: &Aggsig) -> Result<(), Error> {
        self.last_channel_aggsig = their_initial_channel_hash_signature.clone();
        Ok(())
    }

    pub fn send_empty_potato(&mut self, env: &mut ChannelHandlerEnv) -> PotatoSignatures {
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

    pub fn received_message(&mut self, _allocator: &mut Allocator, _game_id: &GameID, _message: NodePtr) -> Result<ReadableUX, Error> {
        todo!();
    }

    pub fn send_potato_accept(&mut self, _allocator: &mut Allocator, _game_id: &GameID) -> (PotatoSignatures, Amount) {
        todo!();
    }

    pub fn received_potato_accept(&mut self, _allocator: &mut Allocator, _signautures: &PotatoSignatures, _game_id: &GameID) -> Result<(), Error> {
        todo!();
    }

    /// Uses the channel coin key to post standard format coin generation to the
    /// real blockchain via a TransactionBundle.
    pub fn send_potato_clean_shutdown(&self, env: &mut ChannelHandlerEnv, conditions: NodePtr) -> Result<TransactionBundle, Error> {
        assert!(self.have_potato);
        let pubkey = private_to_public_key(&self.private_keys.my_channel_coin_private_key);
        eprintln!("our_channel_coin_public_key (send) {:?}", pubkey);
        eprintln!("their_channel_coin_public_key (send) {:?}", self.their_channel_coin_public_key);
        let aggregate_public_key = pubkey.clone() + self.their_channel_coin_public_key.clone();
        eprintln!("aggregate_public_key: {aggregate_public_key:?}");
        let state_channel_coin =
            if let Some(ssc) = self.state_channel_coin_string.as_ref() {
                ssc.to_coin_id()
            } else {
                return Err(Error::StrErr("send_potato_clean_shutdown without state_channel_coin".to_string()));
            };

        let (solution, signature) =
            standard_solution_partial(
                env.allocator,
                &self.private_keys.my_channel_coin_private_key,
                &state_channel_coin,
                conditions,
                &aggregate_public_key,
                &env.agg_sig_me_additional_data
            )?;
        Ok(TransactionBundle {
            solution,
            signature,
            puzzle: puzzle_for_pk(env.allocator, &aggregate_public_key)?,
        })
    }

    pub fn received_potato_clean_shutdown(&self, env: &mut ChannelHandlerEnv, their_channel_half_signature: &Aggsig, conditions: NodePtr) -> Result<TransactionBundle, Error> {
        assert!(!self.have_potato);
        let pubkey = private_to_public_key(&self.private_keys.my_channel_coin_private_key);
        eprintln!("our_channel_coin_public_key (recv) {:?}", pubkey);
        eprintln!("their_channel_coin_public_key (recv) {:?}", self.their_channel_coin_public_key);
        let aggregate_public_key = pubkey.clone() + self.their_channel_coin_public_key.clone();
        eprintln!("aggregate_public_key: {aggregate_public_key:?}");
        let state_channel_coin =
            if let Some(ssc) = self.state_channel_coin_string.as_ref() {
                ssc.to_coin_id()
            } else {
                return Err(Error::StrErr("send_potato_clean_shutdown without state_channel_coin".to_string()));
            };

        let (solution, signature) =
            standard_solution_partial(
                env.allocator,
                &self.private_keys.my_channel_coin_private_key,
                &state_channel_coin,
                conditions,
                &aggregate_public_key,
                &env.agg_sig_me_additional_data
            )?;

        let quoted_conditions = conditions.to_quoted_program(env.allocator)?;
        let quoted_conditions_hash = quoted_conditions.sha256tree(env.allocator);
        let full_signature = signature.aggregate(their_channel_half_signature);
        let message_to_verify = agg_sig_me_message(
            &quoted_conditions_hash.bytes(),
            &state_channel_coin,
            &env.agg_sig_me_additional_data
        );
        if !full_signature.verify(&aggregate_public_key, &message_to_verify) {
            return Err(Error::StrErr("received_potato_clean_shutdown full signature didn't verify".to_string()));
        }
        Ok(TransactionBundle {
            solution,
            signature,
            puzzle: puzzle_for_pk(env.allocator, &aggregate_public_key)?,
        })
    }

    /// Ensure that we include the last state sequence number in a memo so we can
    /// possibly supercede an earlier unroll.
    pub fn get_channel_coin_spend(&self, _allocator: &mut Allocator) -> TransactionBundle {
        todo!();
    }

    pub fn channel_coin_spent(&self, _allocator: &mut Allocator, _condition: NodePtr) -> Result<SpentResult, Error> {
        todo!();
    }

    pub fn unroll_coin_spent<'a>(&'a self, _allocator: &mut Allocator, _conditions: NodePtr) -> Result<CoinSpentResult<'a>, Error> {
        todo!();
    }

    pub fn spend_reward_coins(&self, _allocator: &mut Allocator, _coins: &[CoinString], _target_puzzle_hash: &PuzzleHash) -> SpendRewardResult {
        todo!();
    }
}
