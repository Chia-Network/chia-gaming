use chia_protocol::Bytes;
use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;

use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{AllocEncoder, Error, GameType, Program};
use crate::potato_handler::types::GameFactory;
use std::collections::BTreeMap;

/// Curry the supplied dictionary into the raw krunk `make_proposal` and
/// `parser` hexes, returning a pair of programs in the layout expected by
/// the GameFactory registry. The dictionary is the first (compile-time)
/// argument of both programs (see `krunk_generate.clinc`).
///
/// `dictionary` must be a list of single-atom 5-byte words. Use
/// [`Bytes`] (not `Vec<u8>`) to ensure each word encodes as one atom and
/// not as a list of single-byte atoms.
pub fn curry_krunk_programs(
    allocator: &mut AllocEncoder,
    dictionary: &[Bytes],
) -> Result<(Program, Program), Error> {
    let make_proposal_raw = read_hex_puzzle(
        allocator,
        "clsp/games/krunk/krunk_include_krunk_make_proposal.hex",
    )?;
    let parser_raw =
        read_hex_puzzle(allocator, "clsp/games/krunk/krunk_include_krunk_parser.hex")?;

    let dict_vec = dictionary.to_vec();
    let make_proposal_node = CurriedProgram {
        program: make_proposal_raw,
        args: clvm_curried_args!(dict_vec.clone()),
    }
    .to_clvm(allocator)
    .map_err(|e| Error::StrErr(format!("curry krunk make_proposal: {e:?}")))?;
    let make_proposal = Program::from_nodeptr(allocator, make_proposal_node)?;

    let parser_node = CurriedProgram {
        program: parser_raw,
        args: clvm_curried_args!(dict_vec),
    }
    .to_clvm(allocator)
    .map_err(|e| Error::StrErr(format!("curry krunk parser: {e:?}")))?;
    let parser = Program::from_nodeptr(allocator, parser_node)?;

    Ok((make_proposal, parser))
}

/// Loads the krunk dictionary from `krunkwords.txt`, embedded at compile time.
/// Words are 5 ASCII letters; one per line. Used to curry into the krunk
/// proposal/parser factories so both peers carry the same word list.
///
/// Each word is wrapped in `Bytes` so it encodes as a single CLVM atom rather
/// than a list of single-byte atoms (which is what `Vec<u8>` would produce).
fn krunk_dictionary() -> Vec<Bytes> {
    include_str!("../../clsp/games/krunk/krunkwords.txt")
        .lines()
        .filter(|l| l.len() == 5)
        .map(|w| Bytes::from(w.as_bytes().to_vec()))
        .collect()
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
            program: calpoker_make_proposal.to_program(),
            parser_program: Some(calpoker_parser.to_program()),
        },
    );
    game_type_map.insert(
        GameType(b"ca1poker".to_vec()),
        GameFactory {
            program: calpoker_make_proposal.to_program(),
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
            program: spacepoker_make_proposal.to_program(),
            parser_program: Some(spacepoker_parser.to_program()),
        },
    );

    // Krunk: load the proposal/parser and curry the bundled dictionary as
    // the first (compile-time) argument of each program. After currying
    // the runtime arg layout matches calpoker/spacepoker (bet_size for
    // make_proposal, wire_data for parser); see krunk_generate.clinc.
    let dictionary = krunk_dictionary();
    let (krunk_make_proposal, krunk_parser) =
        curry_krunk_programs(allocator, &dictionary).expect("curry krunk");

    game_type_map.insert(
        GameType(b"krunk".to_vec()),
        GameFactory {
            program: krunk_make_proposal.into(),
            parser_program: Some(krunk_parser.into()),
        },
    );

    game_type_map.insert(
        GameType(b"debug".to_vec()),
        GameFactory {
            program: debug_game.into(),
            parser_program: None,
        },
    );
    game_type_map
}
