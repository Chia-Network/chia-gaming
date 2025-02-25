use std::rc::Rc;

pub mod calpoker;

use crate::common::standard_coin::read_hex_puzzle;
use crate::common::types::{AllocEncoder, Program};
use crate::potato_handler::types::GameType;
use std::collections::BTreeMap;

pub fn poker_collection(allocator: &mut AllocEncoder) -> BTreeMap<GameType, Rc<Program>> {
    let mut game_type_map = BTreeMap::new();
    let calpoker_factory = read_hex_puzzle(allocator, "clsp/calpoker_include_calpoker_factory.hex")
        .expect("should load");

    game_type_map.insert(
        GameType(b"calpoker".to_vec()),
        calpoker_factory.to_program(),
    );
    game_type_map
}
