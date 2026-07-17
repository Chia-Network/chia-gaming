pub mod krunk_dict_tree;

use chia_protocol::Bytes;
use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;

use crate::common::load_clvm::{read_hex_puzzle, read_krunk_dict_dat};
use crate::common::types::{AllocEncoder, GameType, Program};
use crate::session_phases::types::GameFactory;
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
    let calpoker_factory = read_hex_puzzle(
        allocator,
        "clsp/games/calpoker/calpoker_include_calpoker_factory.hex",
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
            program: Some(calpoker_factory.to_program()),
        },
    );
    let spacepoker_factory = read_hex_puzzle(
        allocator,
        "clsp/games/spacepoker/spacepoker_include_spacepoker_factory.hex",
    )
    .expect("should load");
    game_type_map.insert(
        GameType(b"spacepoker".to_vec()),
        GameFactory {
            program: Some(spacepoker_factory.to_program()),
        },
    );

    let krunk_factory_raw = read_hex_puzzle(
        allocator,
        "clsp/games/krunk/krunk_include_krunk_factory.hex",
    )
    .expect("should load krunk factory");
    let (dict_pubkey, dict_tree) =
        read_krunk_dict_dat(allocator, "clsp/games/krunk/krunk_signed_dict_tree.dat")
            .expect("should load krunk dict dat");
    let krunk_factory_node = CurriedProgram {
        program: krunk_factory_raw,
        args: clvm_curried_args!(dict_pubkey, dict_tree),
    }
    .to_clvm(allocator)
    .expect("curry krunk factory");
    let krunk_factory = Program::from_nodeptr(allocator, krunk_factory_node).expect("ok");
    game_type_map.insert(
        GameType(b"krunk".to_vec()),
        GameFactory {
            program: Some(krunk_factory.into()),
        },
    );

    game_type_map.insert(
        GameType(b"debug".to_vec()),
        GameFactory {
            program: Some(debug_game.into()),
        },
    );
    game_type_map
}
