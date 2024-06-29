use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use clvm_traits::ToClvm;

use crate::channel_handler::ChannelHandler;
use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::types::{
    read_unroll_metapuzzle, read_unroll_puzzle, ChannelHandlerEnv, ChannelHandlerInitiationData,
    ChannelHandlerInitiationResult, GameStartInfo, ValidationProgram, UnrollCoin, UnrollCoinConditionInputs, ChannelCoinSpendInfo, HandshakeResult, ChannelHandlerPrivateKeys,
};
use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::standard_coin::{private_to_public_key, puzzle_for_pk, puzzle_hash_for_pk, get_standard_coin_puzzle};
use crate::common::types::{
    AllocEncoder, Amount, CoinID, Error, GameID, Hash, Puzzle, PuzzleHash,
    Sha256tree, Timeout,
};

pub struct ChannelHandlerParty {
    pub ch: ChannelHandler,
    pub init_data: ChannelHandlerInitiationResult,
    #[cfg(test)]
    pub referee: Puzzle,
    pub ref_puzzle_hash: PuzzleHash,
    pub contribution: Amount,
}

impl ChannelHandlerParty {
    pub fn new<R: Rng>(
        env: &mut ChannelHandlerEnv<R>,
        private_keys: ChannelHandlerPrivateKeys,
        referee: Puzzle,
        ref_puzzle_hash: PuzzleHash,
        data: &ChannelHandlerInitiationData,
    ) -> Result<ChannelHandlerParty, Error> {
        let (ch, init_data) = ChannelHandler::new(
            env, private_keys, data
        )?;
        Ok(ChannelHandlerParty {
            ch,
            init_data,
            contribution: data.my_contribution.clone(),
            referee,
            ref_puzzle_hash,
        })
    }
}

pub struct ChannelHandlerGame {
    pub game_id: GameID,
    pub players: [ChannelHandlerParty; 2],
    pub handshake_result: Option<HandshakeResult>,
}

impl ChannelHandlerGame {
    pub fn new<R: Rng>(
        env: &mut ChannelHandlerEnv<R>,
        game_id: GameID,
        launcher_coin_id: &CoinID,
        contributions: &[Amount; 2]
    ) -> Result<ChannelHandlerGame, Error> {
        let private_keys: [ChannelHandlerPrivateKeys; 2] = env.rng.gen();

        let make_ref_info = |env: &mut ChannelHandlerEnv<R>, id: usize| -> Result<(Puzzle, PuzzleHash), Error> {
            let ref_key = private_to_public_key(&private_keys[id].my_referee_private_key);
            let referee = puzzle_for_pk(env.allocator, &ref_key)?;
            let ref_puzzle_hash = referee.sha256tree(env.allocator);
            Ok((referee, ref_puzzle_hash))
        };

        let ref1 = make_ref_info(env, 0)?;
        let ref2 = make_ref_info(env, 1)?;
        let referees = [ref1, ref2];

        let make_party = |env: &mut ChannelHandlerEnv<R>, id: usize| -> Result<ChannelHandlerParty, Error> {
            let data = ChannelHandlerInitiationData {
                launcher_coin_id: launcher_coin_id.clone(),
                we_start_with_potato: id == 1,
                their_channel_pubkey: private_to_public_key(&private_keys[id ^ 1].my_channel_coin_private_key),
                their_unroll_pubkey: private_to_public_key(&private_keys[id ^ 1].my_unroll_coin_private_key),
                their_referee_puzzle_hash: referees[id ^ 1].1.clone(),
                my_contribution: contributions[id].clone(),
                their_contribution: contributions[id ^ 1].clone(),
            };

            ChannelHandlerParty::new(
                env,
                private_keys[id].clone(),
                referees[id].0.clone(),
                referees[id].1.clone(),
                &data
            )
        };

        let player1 = make_party(env, 0)?;
        let player2 = make_party(env, 1)?;

        Ok(ChannelHandlerGame {
            game_id,
            players: [player1, player2],
            handshake_result: None,
        })
    }

    pub fn player(&mut self, who: usize) -> &mut ChannelHandlerParty {
        &mut self.players[who]
    }

    pub fn finish_handshake<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        who: usize,
    ) -> Result<(), Error> {
        let channel_coin_0_aggsig = self.players[who^1].init_data.my_initial_channel_half_signature_peer.clone();
        let handshake_result = self.players[who].ch.finish_handshake(
            env,
            &channel_coin_0_aggsig,
        )?;
        self.handshake_result = Some(handshake_result);
        Ok(())
    }

    pub fn update_channel_coin_after_receive(&mut self, spend: &ChannelCoinSpendInfo) -> Result<(), Error> {
        if let Some(r) = &mut self.handshake_result {
            r.spend = spend.clone();
            return Ok(());
        }

        Err(Error::StrErr("not fully running".to_string()))
    }

    pub fn get_channel_coin_spend(&self) -> Result<HandshakeResult, Error> {
        if let Some(r) = &self.handshake_result {
            return Ok(r.clone());
        }

        Err(Error::StrErr("get channel handler spend when not able to unroll".to_string()))
    }
}

#[test]
fn test_smoke_can_initiate_channel_handler<'a>() {
    let mut allocator = AllocEncoder::new();
    let mut rng = ChaCha8Rng::from_seed([0; 32]);
    let unroll_metapuzzle = read_unroll_metapuzzle(&mut allocator).unwrap();
    let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
    // XXX
    let ref_puz = Puzzle::from_nodeptr(allocator.allocator().null());
    let standard_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should load");
    let mut env = ChannelHandlerEnv {
        allocator: &mut allocator,
        rng: &mut rng,
        referee_coin_puzzle: ref_puz,
        // XXX
        referee_coin_puzzle_hash: PuzzleHash::from_hash(Hash::default()),
        unroll_metapuzzle,
        unroll_puzzle,
        standard_puzzle,
        agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA.clone()),
    };
    let game_id_data: Hash = env.rng.gen();
    let game_id = GameID::new(game_id_data.bytes().to_vec());
    // This coin will be spent (virtually) into the channel coin which supports
    // half-signatures so that unroll can be initated by either party.
    let launcher_coin = CoinID::default();

    let mut game = ChannelHandlerGame::new(
        &mut env,
        game_id,
        &launcher_coin,
        &[Amount::new(100), Amount::new(100)]
    ).expect("should build");

    let _finish_hs_result1 = game
        .finish_handshake(
            &mut env,
            1,
        )
        .expect("should finish handshake");
    let _finish_hs_result2 = game
        .finish_handshake(
            &mut env,
            0,
        )
        .expect("should finish handshake");

    // Set up for the spend.
    let shutdown_spend_target = puzzle_hash_for_pk(
        env.allocator,
        &game.player(1).ch.clean_shutdown_public_key(),
    )
    .expect("should give");
    let amount_to_take = game.player(1).ch.clean_shutdown_amount();
    let conditions = ((51, (shutdown_spend_target, (amount_to_take, ()))), ())
        .to_clvm(env.allocator)
        .expect("should create conditions");
    let shutdown_transaction = game
        .player(1)
        .ch
        .send_potato_clean_shutdown(&mut env, conditions)
        .expect("should give transaction");
    let _counter_shutdown = game
        .player(0)
        .ch
        .received_potato_clean_shutdown(&mut env, &shutdown_transaction.signature, conditions)
        .expect("should give counter transaction");
}

#[test]
fn test_smoke_can_start_game() {
    let mut allocator = AllocEncoder::new();
    let mut rng = ChaCha8Rng::from_seed([0; 32]);
    let unroll_metapuzzle = read_unroll_metapuzzle(&mut allocator).unwrap();
    let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
    // XXX
    let ref_coin_puz = Puzzle::from_nodeptr(allocator.allocator().null());
    let standard_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should load");
    let mut env = ChannelHandlerEnv {
        allocator: &mut allocator,
        rng: &mut rng,
        referee_coin_puzzle: ref_coin_puz,
        // XXX
        referee_coin_puzzle_hash: PuzzleHash::from_hash(Hash::default()),
        unroll_metapuzzle,
        unroll_puzzle,
        standard_puzzle,
        agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA.clone()),
    };
    let game_id_data: Hash = env.rng.gen();
    let game_id = GameID::new(game_id_data.bytes().to_vec());
    // This coin will be spent (virtually) into the channel coin which supports
    // half-signatures so that unroll can be initated by either party.
    let launcher_coin = CoinID::default();
    let mut game = ChannelHandlerGame::new(
        &mut env,
        game_id,
        &launcher_coin,
        &[Amount::new(100), Amount::new(100)]
    ).expect("should work");

    let _finish_hs_result1 = game
        .finish_handshake(
            &mut env,
            1,
        )
        .expect("should finish handshake");

    let _finish_hs_result2 = game
        .finish_handshake(
            &mut env,
            0,
        )
        .expect("should finish handshake");

    // Set up for the spend.
    let our_share = Amount::new(100);
    let their_share = Amount::new(100);

    // Fake
    let game_handler = env.allocator.allocator().null();
    let initial_validation_puzzle = game_handler;
    let initial_state = env.allocator.allocator().null();
    let initial_validation_program = ValidationProgram::new(
        &mut env.allocator,
        initial_validation_puzzle
    );

    let timeout = Timeout::new(1337);
    let _game_start_potato_sigs = game.player(1).ch.send_potato_start_game(
        &mut env,
        &[GameStartInfo {
            game_id: GameID::new(vec![0]),
            game_handler: GameHandler::TheirTurnHandler(game_handler),
            timeout: timeout.clone(),
            my_contribution_this_game: our_share.clone(),
            their_contribution_this_game: their_share.clone(),
            initial_validation_program,
            initial_state: initial_state,
            initial_move: Vec::new(),
            initial_max_move_size: 1,
            initial_mover_share: our_share.clone(),
            amount: our_share + their_share,
        }],
    );
}

#[test]
fn test_unroll_can_verify_own_signature() {
    let mut allocator = AllocEncoder::new();
    let mut rng = ChaCha8Rng::from_seed([0; 32]);
    let mut unroll_coin_1 = UnrollCoin {
        started_with_potato: true,
        state_number: 1,
        .. UnrollCoin::default()
    };

    let mut unroll_coin_2 = UnrollCoin {
        state_number: 1,
        .. UnrollCoin::default()
    };

    let private_key_1 = rng.gen();
    let private_key_2 = rng.gen();
    let public_key_1 = private_to_public_key(&private_key_1);
    let public_key_2 = private_to_public_key(&private_key_2);
    let ref_puzzle_hash_1 = puzzle_hash_for_pk(&mut allocator, &public_key_1).expect("should work");
    let ref_puzzle_hash_2 = puzzle_hash_for_pk(&mut allocator, &public_key_2).expect("should work");

    let unroll_metapuzzle = read_unroll_metapuzzle(&mut allocator).unwrap();
    let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
    let ref_coin_puz = Puzzle::from_nodeptr(allocator.allocator().null());
    let ref_coin_ph = ref_coin_puz.sha256tree(&mut allocator);
    let standard_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should load");
    let mut env = ChannelHandlerEnv {
        allocator: &mut allocator,
        rng: &mut rng,
        referee_coin_puzzle: ref_coin_puz,
        referee_coin_puzzle_hash: ref_coin_ph.clone(),
        unroll_metapuzzle,
        unroll_puzzle,
        standard_puzzle,
        agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA.clone()),
    };

    let inputs_1 = UnrollCoinConditionInputs {
        ref_pubkey: public_key_1.clone(),
        their_referee_puzzle_hash: ref_puzzle_hash_2.clone(),
        my_balance: Amount::new(0),
        their_balance: Amount::new(100),
        puzzle_hashes_and_amounts: vec![]
    };

    let _sig1 = unroll_coin_1.update(
        &mut env,
        &private_key_1,
        &public_key_2,
        &inputs_1
    ).expect("should work");

    let inputs_2 = UnrollCoinConditionInputs {
        ref_pubkey: public_key_2.clone(),
        their_referee_puzzle_hash: ref_puzzle_hash_1.clone(),
        my_balance: inputs_1.their_balance.clone(),
        their_balance: inputs_1.my_balance.clone(),
        .. inputs_1
    };

    let sig2 = unroll_coin_2.update(
        &mut env,
        &private_key_2,
        &public_key_1,
        &inputs_2
    ).expect("should work");

    let aggregate_unroll_public_key = public_key_1.clone() + public_key_2.clone();

    assert!(unroll_coin_1.verify(
        &mut env,
        &aggregate_unroll_public_key,
        &sig2,
    ).expect("should verify"));
}
