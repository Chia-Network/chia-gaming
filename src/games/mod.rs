pub mod krunk_dict_tree;

use chia_protocol::Bytes;
use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;

use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{Aggsig, AllocEncoder, Error, GameType, Program, PublicKey};
use crate::potato_handler::types::GameFactory;
use std::collections::BTreeMap;

/// Curry the supplied dict tree and dict_pubkey into the raw krunk
/// `make_proposal` and `parser` hexes, returning a pair of programs in the
/// layout expected by the GameFactory registry. DICT_TREE and DICT_PUBKEY
/// are the first two curried arguments of both programs (see
/// `krunk_generate.clinc`).
///
/// `dict_tree` is a pre-built balanced BST as a CLVM NodePtr (produced by
/// `krunk_dict_tree::build_dict_tree`).
pub fn curry_krunk_programs(
    allocator: &mut AllocEncoder,
    dict_tree: NodePtr,
    dict_pubkey: &[u8; 48],
) -> Result<(Program, Program), Error> {
    let make_proposal_raw = read_hex_puzzle(
        allocator,
        "clsp/games/krunk/krunk_include_krunk_make_proposal.hex",
    )?;
    let parser_raw =
        read_hex_puzzle(allocator, "clsp/games/krunk/krunk_include_krunk_parser.hex")?;

    let pk = Bytes::from(dict_pubkey.to_vec());
    let make_proposal_node = CurriedProgram {
        program: make_proposal_raw,
        args: clvm_curried_args!(dict_tree, pk.clone()),
    }
    .to_clvm(allocator)
    .map_err(|e| Error::StrErr(format!("curry krunk make_proposal: {e:?}")))?;
    let make_proposal = Program::from_nodeptr(allocator, make_proposal_node)?;

    let parser_node = CurriedProgram {
        program: parser_raw,
        args: clvm_curried_args!(dict_tree, pk),
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
pub fn krunk_dictionary() -> Vec<Bytes> {
    include_str!("../../clsp/games/krunk/krunkwords.txt")
        .lines()
        .filter(|l| l.len() == 5)
        .map(|w| Bytes::from(w.as_bytes().to_vec()))
        .collect()
}

/// Aggregate two sets of partial signatures for dictionary gaps, build the
/// signed tree, and produce the curried Krunk game factory ready for use.
///
/// Both players call this after exchanging partial signatures during the
/// handshake. The resulting `GameFactory` replaces the placeholder entry
/// in the game_types map.
pub fn build_krunk_game_factory(
    allocator: &mut AllocEncoder,
    my_partial_sigs: &[Aggsig],
    their_partial_sigs: &[Aggsig],
    aggregate_dict_pubkey: &PublicKey,
) -> Result<GameFactory, Error> {
    if my_partial_sigs.len() != their_partial_sigs.len() {
        return Err(Error::StrErr(
            "partial sig count mismatch".to_string(),
        ));
    }
    let aggregated_reachable: Vec<Aggsig> = my_partial_sigs
        .iter()
        .zip(their_partial_sigs.iter())
        .map(|(a, b)| a.aggregate(b))
        .collect();

    let dictionary = krunk_dictionary();
    let word_refs: Vec<&[u8]> = dictionary.iter().map(|b| b.as_ref()).collect();
    let aggregated_sigs =
        krunk_dict_tree::expand_signatures_for_tree(&word_refs, &aggregated_reachable);
    let dict_tree =
        krunk_dict_tree::build_signed_dict_tree_from_bytes(allocator, &dictionary, &aggregated_sigs)?;
    let pk_bytes: [u8; 48] = aggregate_dict_pubkey.bytes();
    let (make_proposal, parser) = curry_krunk_programs(allocator, dict_tree, &pk_bytes)?;
    Ok(GameFactory {
        program: make_proposal.into(),
        parser_program: Some(parser.into()),
    })
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

    // Krunk: load the proposal/parser and curry the bundled dictionary tree and
    // a placeholder dict_pubkey. The real pubkey would come from the handshake
    // (aggregate of both players' dictionary signing keys).
    let dictionary = krunk_dictionary();
    let n_words = dictionary.len();
    let placeholder_sigs: Vec<crate::common::types::Aggsig> =
        (0..=n_words).map(|_| crate::common::types::Aggsig::default()).collect();
    let dict_tree =
        krunk_dict_tree::build_signed_dict_tree_from_bytes(allocator, &dictionary, &placeholder_sigs)
            .expect("build krunk dict tree");
    let placeholder_pubkey = [0u8; 48];
    let (krunk_make_proposal, krunk_parser) =
        curry_krunk_programs(allocator, dict_tree, &placeholder_pubkey).expect("curry krunk");

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
