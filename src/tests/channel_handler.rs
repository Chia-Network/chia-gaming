use std::rc::Rc;

use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use clvm_traits::ToClvm;

use crate::channel_handler::game_handler::GameHandler;

use crate::channel_handler::types::{
    read_unroll_metapuzzle, read_unroll_puzzle, ChannelHandlerEnv, GameStartInfo, UnrollCoin,
    UnrollCoinConditionInputs, ValidationProgram,
};
use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::standard_coin::{
    get_standard_coin_puzzle, private_to_public_key, puzzle_hash_for_pk,
};
use crate::common::types::{
    AllocEncoder, Amount, CoinID, GameID, Hash, Program, Puzzle, PuzzleHash, Sha256tree, Timeout,
};
#[cfg(feature = "sim-tests")]
use crate::test_support::game::{ChannelHandlerGame, DEFAULT_UNROLL_TIME_LOCK};

#[cfg(feature = "sim-tests")]
#[test]
fn test_smoke_can_initiate_channel_handler() {
    let mut allocator = AllocEncoder::new();
    let mut rng = ChaCha8Rng::from_seed([0; 32]);
    let unroll_metapuzzle = read_unroll_metapuzzle(&mut allocator).unwrap();
    let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
    // XXX
    let nil = allocator.allocator().nil();
    let ref_puz = Puzzle::from_nodeptr(&mut allocator, nil).expect("should work");
    let standard_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should load");
    let mut env = ChannelHandlerEnv {
        allocator: &mut allocator,
        rng: &mut rng,
        referee_coin_puzzle: ref_puz.clone(),
        referee_coin_puzzle_hash: PuzzleHash::from_hash(Hash::default()),
        referee_coin_puzzle_v1: ref_puz,
        referee_coin_puzzle_hash_v1: PuzzleHash::from_hash(Hash::default()),
        unroll_metapuzzle,
        unroll_puzzle,
        standard_puzzle,
        agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
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
        &[Amount::new(100), Amount::new(100)],
        (*DEFAULT_UNROLL_TIME_LOCK).clone(),
    )
    .expect("should build");

    game.finish_handshake(&mut env, 1)
        .expect("should finish handshake");
    game.finish_handshake(&mut env, 0)
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

#[cfg(feature = "sim-tests")]
#[test]
fn test_smoke_can_start_game() {
    let mut allocator = AllocEncoder::new();
    let mut rng = ChaCha8Rng::from_seed([0; 32]);
    let unroll_metapuzzle = read_unroll_metapuzzle(&mut allocator).unwrap();
    let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
    // XXX
    let nil = allocator.allocator().nil();
    let ref_coin_puz = Puzzle::from_nodeptr(&mut allocator, nil).expect("should work");
    let standard_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should load");
    let mut env = ChannelHandlerEnv {
        allocator: &mut allocator,
        rng: &mut rng,
        referee_coin_puzzle: ref_coin_puz.clone(),
        referee_coin_puzzle_hash: PuzzleHash::from_hash(Hash::default()),
        referee_coin_puzzle_v1: ref_coin_puz,
        referee_coin_puzzle_hash_v1: PuzzleHash::from_hash(Hash::default()),
        unroll_metapuzzle,
        unroll_puzzle,
        standard_puzzle,
        agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
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
        &[Amount::new(100), Amount::new(100)],
        (*DEFAULT_UNROLL_TIME_LOCK).clone(),
    )
    .expect("should work");

    game.finish_handshake(&mut env, 1)
        .expect("should finish handshake");

    game.finish_handshake(&mut env, 0)
        .expect("should finish handshake");

    // Set up for the spend.
    let our_share = Amount::new(100);
    let their_share = Amount::new(100);

    // Fake
    let game_handler = Rc::new(Program::from_bytes(&[0x80]));
    let initial_validation_puzzle = game_handler.clone();
    let initial_state = Program::from_bytes(&[0x80]).into();
    let initial_validation_program =
        ValidationProgram::new(env.allocator, initial_validation_puzzle);

    let timeout = Timeout::new(1337);
    let game_handler = GameHandler::TheirTurnHandler(game_handler.into());
    let _game_start_potato_sigs = game.player(1).ch.send_potato_start_game(
        &mut env,
        &[Rc::new(GameStartInfo {
            game_id: GameID::new(vec![0]),
            game_handler,
            timeout: timeout.clone(),
            my_contribution_this_game: our_share.clone(),
            their_contribution_this_game: their_share.clone(),
            initial_validation_program,
            initial_state,
            initial_move: Vec::new(),
            initial_max_move_size: 1,
            initial_mover_share: our_share.clone(),
            amount: our_share + their_share,
        })],
    );
}

#[test]
fn test_unroll_can_verify_own_signature() {
    let mut allocator = AllocEncoder::new();
    let mut rng = ChaCha8Rng::from_seed([0; 32]);
    let mut unroll_coin_1 = UnrollCoin {
        started_with_potato: true,
        state_number: 1,
        ..UnrollCoin::default()
    };

    let mut unroll_coin_2 = UnrollCoin {
        state_number: 1,
        ..UnrollCoin::default()
    };

    let private_key_1 = rng.gen();
    let private_key_2 = rng.gen();
    let public_key_1 = private_to_public_key(&private_key_1);
    let public_key_2 = private_to_public_key(&private_key_2);
    let ref_puzzle_hash_1 = puzzle_hash_for_pk(&mut allocator, &public_key_1).expect("should work");
    let ref_puzzle_hash_2 = puzzle_hash_for_pk(&mut allocator, &public_key_2).expect("should work");

    let unroll_metapuzzle = read_unroll_metapuzzle(&mut allocator).unwrap();
    let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
    let nil = allocator.allocator().nil();
    let ref_coin_puz = Puzzle::from_nodeptr(&mut allocator, nil).expect("should work");
    let ref_coin_ph = ref_coin_puz.sha256tree(&mut allocator);
    let standard_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should load");
    let mut env = ChannelHandlerEnv {
        allocator: &mut allocator,
        rng: &mut rng,
        referee_coin_puzzle: ref_coin_puz.clone(),
        referee_coin_puzzle_hash: ref_coin_ph.clone(),
        referee_coin_puzzle_v1: ref_coin_puz,
        referee_coin_puzzle_hash_v1: ref_coin_ph.clone(),
        unroll_metapuzzle,
        unroll_puzzle,
        standard_puzzle,
        agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
    };

    let inputs_1 = UnrollCoinConditionInputs {
        ref_pubkey: public_key_1.clone(),
        their_referee_puzzle_hash: ref_puzzle_hash_2.clone(),
        my_balance: Amount::new(0),
        their_balance: Amount::new(100),
        puzzle_hashes_and_amounts: vec![],
        rem_condition_state: 0,
    };

    let _sig1 = unroll_coin_1
        .update(&mut env, &private_key_1, &public_key_2, &inputs_1)
        .expect("should work");

    let inputs_2 = UnrollCoinConditionInputs {
        ref_pubkey: public_key_2.clone(),
        their_referee_puzzle_hash: ref_puzzle_hash_1.clone(),
        my_balance: inputs_1.their_balance.clone(),
        their_balance: inputs_1.my_balance.clone(),
        ..inputs_1
    };

    let sig2 = unroll_coin_2
        .update(&mut env, &private_key_2, &public_key_1, &inputs_2)
        .expect("should work");

    let aggregate_unroll_public_key = public_key_1.clone() + public_key_2.clone();

    assert!(unroll_coin_1
        .verify(&mut env, &aggregate_unroll_public_key, &sig2,)
        .expect("should verify"));
}
