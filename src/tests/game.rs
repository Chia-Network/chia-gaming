use rand::prelude::*;
use crate::common::types::{Amount, CoinString, Error, GameID, Hash, IntoErr, Timeout};
use crate::common::standard_coin::ChiaIdentity;
use crate::channel_handler::game::Game;
use crate::channel_handler::types::{ChannelHandlerEnv, ChannelHandlerInitiationData};

use crate::tests::channel_handler::ChannelHandlerGame;
use crate::tests::simulator::Simulator;

pub fn new_channel_handler_game<R: Rng>(
    simulator: &Simulator,
    env: &mut ChannelHandlerEnv<R>,
    game: &Game,
    identities: &[ChiaIdentity; 2],
    contributions: [Amount; 2],
) -> Result<ChannelHandlerGame, Error> {
    let mut party = ChannelHandlerGame::new(env, contributions.clone());

    // Get at least one coin for the first identity
    simulator.farm_block(&identities[0].puzzle_hash);
    // Get at least one coin for the second identity
    simulator.farm_block(&identities[1].puzzle_hash);

    let get_sufficient_coins = |i: usize| -> Result<Vec<CoinString>, Error> {
        Ok(simulator.get_my_coins(&identities[i].puzzle_hash).into_gen()?.into_iter().filter(|c| {
            if let Some((_, _, amt)) = c.to_parts() {
                return amt >= contributions[i].clone();
            }
            false
        }).collect())
    };
    let player_coins: [Vec<CoinString>; 2] = [
        get_sufficient_coins(0)?,
        get_sufficient_coins(1)?
    ];

    party.initiate(env, 0, &ChannelHandlerInitiationData {
        launcher_coin_id: player_coins[0][0].to_coin_id(),
        we_start_with_potato: true,
        their_channel_pubkey: identities[0].synthetic_public_key.clone(),
        their_unroll_pubkey: identities[0].synthetic_public_key.clone(),
        their_referee_puzzle_hash: env.referee_coin_puzzle_hash.clone(),
        my_contribution: contributions[0].clone(),
        their_contribution: contributions[1].clone(),
    })?;
    party.initiate(env, 1, &ChannelHandlerInitiationData {
        launcher_coin_id: player_coins[1][0].to_coin_id(),
        we_start_with_potato: false,
        their_channel_pubkey: identities[1].synthetic_public_key.clone(),
        their_unroll_pubkey: identities[1].synthetic_public_key.clone(),
        their_referee_puzzle_hash: env.referee_coin_puzzle_hash.clone(),
        my_contribution: contributions[1].clone(),
        their_contribution: contributions[0].clone(),
    })?;

    let amount = contributions[0].clone() + contributions[1].clone();
    let timeout = Timeout::new(10);

    let game_id_data: Hash = env.rng.gen();
    let game_id = GameID::new(game_id_data.bytes().to_vec());
    let (our_game_start, their_game_start) = game.symmetric_game_starts(
        &game_id,
        &amount,
        &timeout
    );
    let start_potato = party.player(0).ch.send_potato_start_game(
        env,
        contributions[0].clone(),
        contributions[1].clone(),
        &[our_game_start]
    )?;
    party.player(1).ch.received_potato_start_game(
        env,
        &start_potato,
        &[their_game_start]
    )?;

    Ok(party)
}
