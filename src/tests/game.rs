use rand::prelude::*;
use crate::common::types::{Amount, Error};
use crate::common::standard_coin::ChiaIdentity;
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
) -> Result<ChannelHandlerGame, Error> {
    let party = ChannelHandlerGame::new(env, contributions);
    todo!();
}
