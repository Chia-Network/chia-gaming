pub mod krunk_dict_tree;

use chia_protocol::Bytes;
use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;

use crate::common::load_clvm::{read_binary_puzzle, read_hex_puzzle};
use crate::common::types::{AllocEncoder, GameType, Program};
use crate::potato_handler::types::GameFactory;
use std::collections::BTreeMap;

/// Loads the krunk dictionary from `krunkwords.txt`, embedded at compile time.
/// Words are 5 ASCII letters; one per line.
pub fn krunk_dictionary() -> Vec<Bytes> {
    include_str!("../../clsp/games/krunk/krunkwords.txt")
        .lines()
        .filter(|l| l.len() == 5)
        .map(|w| Bytes::from(w.as_bytes().to_vec()))
        .collect()
}

/// The `GameType` key for krunk in the game type map.
pub fn krunk_game_type() -> GameType {
    GameType(b"krunk".to_vec())
}

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
            program: Some(calpoker_make_proposal.to_program()),
            parser_program: Some(calpoker_parser.to_program()),
        },
    );
    let spacepoker_make_proposal = read_hex_puzzle(
        allocator,
        "clsp/games/spacepoker/spacepoker_include_spacepoker_make_proposal.hex",
    )
    .expect("should load");
    let spacepoker_parser = read_hex_puzzle(
        allocator,
        "clsp/games/spacepoker/spacepoker_include_spacepoker_parser.hex",
    )
    .expect("should load");

    game_type_map.insert(
        GameType(b"spacepoker".to_vec()),
        GameFactory {
            program: Some(spacepoker_make_proposal.to_program()),
            parser_program: Some(spacepoker_parser.to_program()),
        },
    );

    let krunk_make_proposal_raw = read_hex_puzzle(
        allocator,
        "clsp/games/krunk/krunk_include_krunk_make_proposal.hex",
    )
    .expect("should load krunk make_proposal");
    let krunk_parser_raw = read_hex_puzzle(
        allocator,
        "clsp/games/krunk/krunk_include_krunk_parser.hex",
    )
    .expect("should load krunk parser");
    let dict_tree = read_binary_puzzle(
        allocator,
        "clsp/games/krunk/krunk_signed_dict_tree.dat",
    )
    .expect("should load krunk dict tree");
    let krunk_make_proposal_node = CurriedProgram {
        program: krunk_make_proposal_raw,
        args: clvm_curried_args!(dict_tree),
    }
    .to_clvm(allocator)
    .expect("curry krunk make_proposal");
    let krunk_make_proposal =
        Program::from_nodeptr(allocator, krunk_make_proposal_node).expect("ok");
    let krunk_parser_node = CurriedProgram {
        program: krunk_parser_raw,
        args: clvm_curried_args!(dict_tree),
    }
    .to_clvm(allocator)
    .expect("curry krunk parser");
    let krunk_parser = Program::from_nodeptr(allocator, krunk_parser_node).expect("ok");
    game_type_map.insert(
        GameType(b"krunk".to_vec()),
        GameFactory {
            program: Some(krunk_make_proposal.into()),
            parser_program: Some(krunk_parser.into()),
        },
    );

    game_type_map.insert(
        GameType(b"debug".to_vec()),
        GameFactory {
            program: Some(debug_game.into()),
            parser_program: None,
        },
    );
    game_type_map
}
