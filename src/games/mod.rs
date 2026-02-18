pub mod calpoker;

use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;

use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{AllocEncoder, GameType, Program};
use crate::potato_handler::types::GameFactory;
use std::collections::BTreeMap;

pub fn poker_collection(allocator: &mut AllocEncoder) -> BTreeMap<GameType, GameFactory> {
    let mut game_type_map = BTreeMap::new();
    let calpoker_make_proposal = read_hex_puzzle(
        allocator,
        "clsp/games/calpoker/calpoker_include_calpoker_make_proposal.hex",
    )
    .expect("should load");
    let calpoker_parser = read_hex_puzzle(
        allocator,
        "clsp/games/calpoker/calpoker_include_calpoker_parser.hex",
    )
    .expect("should load");
    let debug_game_raw =
        read_hex_puzzle(allocator, "clsp/test/debug_game.hex").expect("should load");
    let debug_game_node = CurriedProgram {
        program: debug_game_raw.clone(),
        args: clvm_curried_args!("factory", ()),
    }
    .to_clvm(allocator)
    .expect("cvt");
    let debug_game = Program::from_nodeptr(allocator, debug_game_node).expect("ok");

    game_type_map.insert(
        GameType(b"calpoker".to_vec()),
        GameFactory {
            version: 1,
            program: calpoker_make_proposal.to_program(),
            parser_program: Some(calpoker_parser.to_program()),
        },
    );
    game_type_map.insert(
        GameType(b"ca1poker".to_vec()),
        GameFactory {
            version: 1,
            program: calpoker_make_proposal.to_program(),
            parser_program: Some(calpoker_parser.to_program()),
        },
    );
    game_type_map.insert(
        GameType(b"debug".to_vec()),
        GameFactory {
            version: 1,
            program: debug_game.into(),
            parser_program: None,
        },
    );
    game_type_map
}
