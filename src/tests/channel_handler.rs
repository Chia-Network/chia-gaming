use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use clvm_traits::ToClvm;

use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::ChannelHandler;
use crate::channel_handler::types::{
    read_unroll_metapuzzle, read_unroll_puzzle, ChannelHandlerEnv, ChannelHandlerInitiationData,
    ChannelHandlerInitiationResult, GameStartInfo, ValidationProgram, ValidationInfo
};
use crate::common::constants::{AGG_SIG_ME_ADDITIONAL_DATA, CREATE_COIN};
use crate::common::standard_coin::{private_to_public_key, puzzle_for_pk, puzzle_hash_for_pk};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinID, Error, GameID, Hash, Puzzle, PuzzleHash,
    Sha256tree, Timeout,
};

struct ChannelHandlerParty {
    ch: ChannelHandler,
    referee: Puzzle,
    ref_puzzle_hash: PuzzleHash,
    contribution: Amount,
}

impl ChannelHandlerParty {
    fn new<R: Rng>(
        allocator: &mut AllocEncoder,
        rng: &mut R,
        contribution: Amount,
    ) -> ChannelHandlerParty {
        let ch = ChannelHandler::construct_with_rng(rng);
        let ref_key = private_to_public_key(&ch.referee_private_key());
        let referee = puzzle_for_pk(allocator, &ref_key).expect("should work");
        let ref_puzzle_hash = referee.sha256tree(allocator);
        ChannelHandlerParty {
            ch,
            contribution,
            referee,
            ref_puzzle_hash,
        }
    }
}

struct ChannelHandlerGame {
    players: [ChannelHandlerParty; 2],
}

impl ChannelHandlerGame {
    fn new<R: Rng>(
        env: &mut ChannelHandlerEnv<R>,
        contributions: [Amount; 2],
    ) -> ChannelHandlerGame {
        let player1 =
            ChannelHandlerParty::new(&mut env.allocator, &mut env.rng, contributions[0].clone());
        let player2 =
            ChannelHandlerParty::new(&mut env.allocator, &mut env.rng, contributions[1].clone());

        ChannelHandlerGame {
            players: [player1, player2],
        }
    }

    fn player(&mut self, who: usize) -> &mut ChannelHandlerParty {
        &mut self.players[who]
    }

    fn initiate<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        who: usize,
        data: &ChannelHandlerInitiationData,
    ) -> Result<ChannelHandlerInitiationResult, Error> {
        self.players[who].ch.initiate(env, data)
    }

    fn handshake<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        launcher_coin: &CoinID,
    ) -> Result<[ChannelHandlerInitiationResult; 2], Error> {
        let chi_data1 = ChannelHandlerInitiationData {
            launcher_coin_id: launcher_coin.clone(),
            we_start_with_potato: false,
            their_channel_pubkey: private_to_public_key(&self.player(1).ch.channel_private_key()),
            their_unroll_pubkey: private_to_public_key(&self.player(1).ch.unroll_private_key()),
            their_referee_puzzle_hash: self.player(1).ref_puzzle_hash.clone(),
            my_contribution: self.player(0).contribution.clone(),
            their_contribution: self.player(1).contribution.clone(),
        };
        eprintln!("initiate 1");
        let initiation_result1 = self.initiate(env, 0, &chi_data1)?;

        let chi_data2 = ChannelHandlerInitiationData {
            launcher_coin_id: launcher_coin.clone(),
            we_start_with_potato: true,
            their_channel_pubkey: private_to_public_key(&self.player(0).ch.channel_private_key()),
            their_unroll_pubkey: private_to_public_key(&self.player(0).ch.unroll_private_key()),
            their_referee_puzzle_hash: self.player(0).ref_puzzle_hash.clone(),
            my_contribution: self.player(1).contribution.clone(),
            their_contribution: self.player(0).contribution.clone(),
        };
        eprintln!("initiate 2");
        let initiation_result2 = self.initiate(env, 1, &chi_data2)?;

        Ok([initiation_result1, initiation_result2])
    }

    fn finish_handshake<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        who: usize,
        aggsig: &Aggsig,
    ) -> Result<(), Error> {
        self.players[who].ch.finish_handshake(env, aggsig)
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
    let mut env = ChannelHandlerEnv {
        allocator: &mut allocator,
        rng: &mut rng,
        referee_coin_puzzle: ref_puz,
        // XXX
        referee_coin_puzzle_hash: PuzzleHash::from_hash(Hash::default()),
        unroll_metapuzzle,
        unroll_puzzle,
        agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA.clone()),
    };
    let mut game = ChannelHandlerGame::new(&mut env, [Amount::new(100), Amount::new(100)]);

    // This coin will be spent (virtually) into the channel coin which supports
    // half-signatures so that unroll can be initated by either party.
    let launcher_coin = CoinID::default();
    let init_results = game
        .handshake(&mut env, &launcher_coin)
        .expect("should work");

    let _finish_hs_result1 = game
        .finish_handshake(
            &mut env,
            1,
            &init_results[0].my_initial_channel_half_signature_peer,
        )
        .expect("should finish handshake");
    let _finish_hs_result2 = game
        .finish_handshake(
            &mut env,
            0,
            &init_results[1].my_initial_channel_half_signature_peer,
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
    let mut env = ChannelHandlerEnv {
        allocator: &mut allocator,
        rng: &mut rng,
        referee_coin_puzzle: ref_coin_puz,
        // XXX
        referee_coin_puzzle_hash: PuzzleHash::from_hash(Hash::default()),
        unroll_metapuzzle,
        unroll_puzzle,
        agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA.clone()),
    };
    let mut game = ChannelHandlerGame::new(&mut env, [Amount::new(100), Amount::new(100)]);

    // This coin will be spent (virtually) into the channel coin which supports
    // half-signatures so that unroll can be initated by either party.
    let launcher_coin = CoinID::default();
    let init_results = game
        .handshake(&mut env, &launcher_coin)
        .expect("should work");

    let _finish_hs_result1 = game
        .finish_handshake(
            &mut env,
            1,
            &init_results[0].my_initial_channel_half_signature_peer,
        )
        .expect("should finish handshake");
    let _finish_hs_result2 = game
        .finish_handshake(
            &mut env,
            0,
            &init_results[1].my_initial_channel_half_signature_peer,
        )
        .expect("should finish handshake");

    // Set up for the spend.
    let shutdown_spend_target = puzzle_hash_for_pk(
        env.allocator,
        &game.player(1).ch.clean_shutdown_public_key(),
    )
    .expect("should give");
    let amount_to_take = game.player(1).ch.clean_shutdown_amount();
    let conditions = (
        (CREATE_COIN, (shutdown_spend_target, (amount_to_take, ()))),
        (),
    )
        .to_clvm(env.allocator)
        .expect("should create conditions");
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
    let game_start_potato_sigs = game.player(1).ch.send_potato_start_game(
        &mut env,
        our_share.clone(),
        their_share.clone(),
        &[GameStartInfo {
            game_id: GameID::new(vec![0]),
            game_handler: GameHandler::TheirTurnHandler(game_handler),
            is_my_turn: true,
            timeout: timeout.clone(),
            initial_validation_program,
            initial_state: initial_state,
            initial_move: Vec::new(),
            initial_max_move_size: 1,
            initial_mover_share: our_share.clone(),
            amount: our_share + their_share,
        }],
    );
}
