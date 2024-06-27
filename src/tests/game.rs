use rand::prelude::*;
use crate::common::types::{Amount, CoinString, Error, IntoErr, Timeout};
use crate::common::standard_coin::{ChiaIdentity, puzzle_hash_for_pk, private_to_public_key, puzzle_hash_for_synthetic_public_key};
use crate::channel_handler::game::Game;
use crate::channel_handler::types::ChannelHandlerEnv;

use crate::tests::channel_handler::ChannelHandlerGame;
use crate::tests::simulator::Simulator;

pub fn new_channel_handler_game<R: Rng>(
    simulator: &Simulator,
    env: &mut ChannelHandlerEnv<R>,
    game: &Game,
    identities: &[ChiaIdentity; 2],
    contributions: [Amount; 2],
) -> Result<(ChannelHandlerGame, CoinString), Error> {
    let mut party = ChannelHandlerGame::new(
        env,
        game.id.clone(),
        contributions.clone()
    );

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
    let coins: [Vec<CoinString>; 2] = [
        get_sufficient_coins(0)?,
        get_sufficient_coins(1)?
    ];

    // Make state channel coin.
    // Spend coin1 to person 0 creating their_amount and change (u1).
    let (u1, _) = simulator.transfer_coin_amount(
        &mut env.allocator,
        &identities[0],
        &identities[1],
        &coins[1][0],
        contributions[1].clone()
    )?;
    simulator.farm_block(&identities[0].puzzle_hash);

    // Spend coin0 to person 0 creating my_amount and change (u0).
    let (u2, _) = simulator.transfer_coin_amount(
        &mut env.allocator,
        &identities[0],
        &identities[0],
        &coins[0][0],
        contributions[0].clone()
    )?;

    simulator.farm_block(&identities[0].puzzle_hash);

    // Combine u1 and u0 into a single person aggregate key coin.
    let aggregate_public_key =
        private_to_public_key(&party.player(0).ch.channel_private_key()) +
        private_to_public_key(&party.player(1).ch.channel_private_key());

    let cc_ph = puzzle_hash_for_synthetic_public_key(
        &mut env.allocator,
        &aggregate_public_key
    )?;
    eprintln!("puzzle hash for state channel coin: {cc_ph:?}");

    let init_results = party.handshake(env, &u2.to_coin_id())?;
    // The intention i remember getting from working with bram is that channel
    // handler gives the state channel id we should spend _to_ and we create it
    // after initiate based on the info it gives and the info we have.
    let state_channel_coin = simulator.combine_coins(
        &mut env.allocator,
        &identities[0],
        &init_results[0].channel_puzzle_hash_up,
        &[u1, u2]
    )?;
    eprintln!("actual state channel coin {:?}", state_channel_coin.to_parts());

    simulator.farm_block(&identities[0].puzzle_hash);

    let _finish_hs_result1 = party
        .finish_handshake(
            env,
            1,
            &init_results[0].my_initial_channel_half_signature_peer,
        )
        .expect("should finish handshake");
    let _finish_hs_result2 = party
        .finish_handshake(
            env,
            0,
            &init_results[1].my_initial_channel_half_signature_peer,
        )
        .expect("should finish handshake");

    let timeout = Timeout::new(10);

    let (our_game_start, their_game_start) = game.symmetric_game_starts(
        &game.id,
        &contributions[0].clone(),
        &contributions[1].clone(),
        &timeout
    );
    let start_potato = party.player(0).ch.send_potato_start_game(
        env,
        &[our_game_start]
    )?;

    let solidified_state = party.player(1).ch.received_potato_start_game(
        env,
        &start_potato,
        &[their_game_start]
    )?;
    party.update_channel_coin_after_receive(&solidified_state)?;

    Ok((party, state_channel_coin))
}
