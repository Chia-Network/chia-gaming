use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use clvmr::allocator::NodePtr;
use clvm_traits::ToClvm;
use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;

use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::types::{Amount, CoinID, Sha256tree, PrivateKey, AllocEncoder, Node, Hash, PuzzleHash, PublicKey, Puzzle, Error, Aggsig};
use crate::common::standard_coin::{private_to_public_key, calculate_synthetic_public_key, puzzle_hash_for_pk};
use crate::channel_handler::handler::ChannelHandler;
use crate::channel_handler::types::{ChannelHandlerInitiationData, ChannelHandlerEnv, ChannelHandlerInitiationResult, read_unroll_metapuzzle, read_unroll_puzzle};

struct ChannelHandlerParty {
    ch: ChannelHandler,
    unroll_metapuzzle: Puzzle,
    unroll_puzzle: Puzzle,
    referee: Puzzle,
    ref_puzzle_hash: PuzzleHash,
    contribution: Amount,
}

impl ChannelHandlerParty {
    fn new<R: Rng>(allocator: &mut AllocEncoder, rng: &mut R, unroll_metapuzzle: Puzzle, unroll_puzzle: Puzzle, contribution: Amount) -> ChannelHandlerParty {
        let ch = ChannelHandler::construct_with_rng(rng);
        let referee = Puzzle::from_nodeptr(allocator.allocator().one());
        let ref_puzzle_hash = referee.sha256tree(allocator);
        ChannelHandlerParty {
            ch,
            unroll_metapuzzle,
            unroll_puzzle,
            referee,
            ref_puzzle_hash,
            contribution
        }
    }
}

struct ChannelHandlerGame {
    players: [ChannelHandlerParty; 2]
}

impl ChannelHandlerGame {
    fn new<R: Rng>(env: &mut ChannelHandlerEnv, rng: &mut R, contributions: [Amount; 2]) -> ChannelHandlerGame {
        let player1 = ChannelHandlerParty::new(
            &mut env.allocator,
            rng,
            env.unroll_metapuzzle.clone(),
            env.unroll_puzzle.clone(),
            contributions[0].clone()
        );
        let player2 = ChannelHandlerParty::new(
            &mut env.allocator,
            rng,
            env.unroll_metapuzzle.clone(),
            env.unroll_puzzle.clone(),
            contributions[1].clone()
        );

        ChannelHandlerGame {
            players: [player1, player2]
        }
    }

    fn player(&mut self, who: usize) -> &mut ChannelHandlerParty {
        &mut self.players[who]
    }

    fn initiate(&mut self, env: &mut ChannelHandlerEnv, who: usize, data: &ChannelHandlerInitiationData) -> Result<ChannelHandlerInitiationResult, Error> {
        self.players[who].ch.initiate(env, data)
    }

    fn handshake(&mut self, env: &mut ChannelHandlerEnv, launcher_coin: &CoinID) -> Result<[ChannelHandlerInitiationResult; 2], Error> {
        let chi_data1 = ChannelHandlerInitiationData {
            launcher_coin_id: launcher_coin.clone(),
            we_start_with_potato: false,
            their_channel_pubkey: private_to_public_key(&self.player(1).ch.channel_private_key()),
            their_unroll_pubkey: private_to_public_key(&self.player(1).ch.unroll_private_key()),
            their_referee_puzzle_hash: self.player(1).ref_puzzle_hash.clone(),
            my_contribution: self.player(0).contribution.clone(),
            their_contribution: self.player(1).contribution.clone()
        };
        let initiation_result1 = self.initiate(env, 0, &chi_data1)?;
        let chi_data2 = ChannelHandlerInitiationData {
            launcher_coin_id: launcher_coin.clone(),
            we_start_with_potato: true,
            their_channel_pubkey: private_to_public_key(&self.player(0).ch.channel_private_key()),
            their_unroll_pubkey: private_to_public_key(&self.player(0).ch.unroll_private_key()),
            their_referee_puzzle_hash: self.player(0).ref_puzzle_hash.clone(),
            my_contribution: self.player(1).contribution.clone(),
            their_contribution: self.player(0).contribution.clone()
        };
        let initiation_result2 = self.initiate(env, 1, &chi_data2)?;
        Ok([initiation_result1, initiation_result2])
    }

    fn finish_handshake(&mut self, env: &mut ChannelHandlerEnv, who: usize, aggsig: &Aggsig) -> Result<(), Error> {
        self.players[who].ch.finish_handshake(env, aggsig)
    }
}

#[test]
fn test_smoke_can_initiate_channel_handler() {
    let mut allocator = AllocEncoder::new();
    let unroll_metapuzzle = read_unroll_metapuzzle(&mut allocator).unwrap();
    let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
    let mut env = ChannelHandlerEnv {
        allocator: &mut allocator,
        unroll_metapuzzle,
        unroll_puzzle,
        agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA.clone())
    };
    let mut rng = ChaCha8Rng::from_seed([0; 32]);
    let mut game = ChannelHandlerGame::new(
        &mut env,
        &mut rng,
        [Amount::new(100), Amount::new(100)]
    );

    // This coin will be spent (virtually) into the channel coin which supports
    // half-signatures so that unroll can be initated by either party.
    let launcher_coin = CoinID::default();
    let init_results = game.handshake(&mut env, &launcher_coin).expect("should work");

    let finish_hs_result1 = game.finish_handshake(&mut env, 1, &init_results[0].my_initial_channel_half_signature_peer).expect("should finish handshake");
    let finish_hs_result2 = game.finish_handshake(&mut env, 0, &init_results[1].my_initial_channel_half_signature_peer).expect("should finish handshake");

    // Set up for the spend.
    let shutdown_spend_target = puzzle_hash_for_pk(env.allocator, &game.player(1).ch.clean_shutdown_public_key()).expect("should give");
    let amount_to_take = game.player(1).ch.clean_shutdown_amount();
    let conditions = ((51, (shutdown_spend_target, (amount_to_take, ()))), ()).to_clvm(env.allocator).expect("should create conditions");
    let shutdown_transaction = game.player(1).ch.send_potato_clean_shutdown(
        &mut env,
        conditions
    ).expect("should give transaction");
    let counter_shutdown = game.player(0).ch.received_potato_clean_shutdown(
        &mut env,
        &shutdown_transaction.signature,
        conditions
    ).expect("should give counter transaction");
}

