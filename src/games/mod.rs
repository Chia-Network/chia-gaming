use std::rc::Rc;

pub mod calpoker;
pub mod calpoker_v1;

use crate::common::standard_coin::read_hex_puzzle;
use crate::common::types::{AllocEncoder, Program};
use crate::potato_handler::types::{GameFactory, GameType};
use std::collections::BTreeMap;

pub fn poker_collection(allocator: &mut AllocEncoder) -> BTreeMap<GameType, GameFactory> {
    let mut game_type_map = BTreeMap::new();
    let calpoker_factory = read_hex_puzzle(
        allocator,
        "clsp/games/calpoker-v0/calpoker_include_calpoker_factory.hex",
    )
        .expect("should load");
    let debug_game = read_hex_puzzle(
        allocator,
        "clsp/test/debug_game.hex"
    )
        .expect("should load");

    game_type_map.insert(
        GameType(b"calpoker".to_vec()),
        GameFactory {
            version: 0,
            program: calpoker_factory.to_program(),
        }
    );
    game_type_map.insert(
        GameType(b"debug".to_vec()),
        GameFactory {
            version: 1,
            program: debug_game.to_program(),
        }
    );
    game_type_map
}
