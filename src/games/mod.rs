pub mod krunk_dict_tree;

use chia_protocol::Bytes;
use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;

use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{Aggsig, AllocEncoder, Error, GameType, Program, PublicKey};
use crate::games::krunk_dict_tree::sigs_to_bytes;
use crate::potato_handler::types::{GameFactory, GameFactoryRebuild};
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
        program: Some(make_proposal.into()),
        parser_program: Some(parser.into()),
        rebuild: Some(GameFactoryRebuild::Krunk {
            words: dictionary.iter().map(|b| b.as_ref().to_vec()).collect(),
            aggregated_sigs: sigs_to_bytes(&aggregated_reachable),
            dict_pubkey: pk_bytes.to_vec(),
        }),
    })
}

impl GameFactory {
    /// If `program`/`parser_program` are missing but a `rebuild` recipe is
    /// present, reconstruct them. Used after deserializing a cradle: heavy
    /// curried CLVM is not serialized, only the small recipe.
    pub fn ensure_built(&mut self, allocator: &mut AllocEncoder) -> Result<(), Error> {
        if self.program.is_some() {
            return Ok(());
        }
        let rebuild = match self.rebuild.as_ref() {
            Some(r) => r,
            // No programs and no recipe: leave alone. Either this factory
            // will be replaced (e.g. unsigned Krunk placeholder before user
            // selects a dictionary) or the caller will hit a clear error
            // when it tries to use the program.
            None => return Ok(()),
        };
        match rebuild {
            GameFactoryRebuild::Krunk {
                words,
                aggregated_sigs,
                dict_pubkey,
            } => {
                if dict_pubkey.len() != 48 {
                    return Err(Error::StrErr(format!(
                        "GameFactoryRebuild::Krunk dict_pubkey length {} != 48",
                        dict_pubkey.len(),
                    )));
                }
                let mut pk_arr = [0u8; 48];
                pk_arr.copy_from_slice(dict_pubkey);
                let words_b: Vec<chia_protocol::Bytes> = words
                    .iter()
                    .map(|w| chia_protocol::Bytes::from(w.clone()))
                    .collect();
                let reachable_sigs = krunk_dict_tree::sigs_from_bytes(aggregated_sigs)?;
                let word_refs: Vec<&[u8]> = words_b.iter().map(|b| b.as_ref()).collect();
                let expanded =
                    krunk_dict_tree::expand_signatures_for_tree(&word_refs, &reachable_sigs);
                let dict_tree = krunk_dict_tree::build_signed_dict_tree_from_bytes(
                    allocator, &words_b, &expanded,
                )?;
                let (mp, pp) = curry_krunk_programs(allocator, dict_tree, &pk_arr)?;
                self.program = Some(mp.into());
                self.parser_program = Some(pp.into());
            }
        }
        Ok(())
    }
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
            rebuild: None,
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
            rebuild: None,
        },
    );

    // Krunk: load the proposal/parser and curry the bundled dictionary tree and
    // a placeholder dict_pubkey. The real pubkey would come from the handshake
    // (aggregate of both players' dictionary signing keys).
    game_type_map.insert(
        GameType(b"krunk".to_vec()),
        build_placeholder_krunk_game_factory(allocator).expect("build krunk placeholder"),
    );

    game_type_map.insert(
        GameType(b"debug".to_vec()),
        GameFactory {
            program: Some(debug_game.into()),
            parser_program: None,
            rebuild: None,
        },
    );
    game_type_map
}

/// Build a Krunk `GameFactory` with all-default placeholder signatures and a
/// zero dict pubkey. Used as the initial registry entry before a real
/// dictionary handshake replaces it. Includes a `rebuild` recipe so the
/// factory can be slimmed during cradle serialize/deserialize.
pub fn build_placeholder_krunk_game_factory(
    allocator: &mut AllocEncoder,
) -> Result<GameFactory, Error> {
    let dictionary = krunk_dictionary();
    let word_refs: Vec<&[u8]> = dictionary.iter().map(|b| b.as_ref()).collect();
    let reachable_count = krunk_dict_tree::reachable_gap_mask(&word_refs)
        .iter()
        .filter(|r| **r)
        .count();
    let placeholder_reachable: Vec<Aggsig> =
        (0..reachable_count).map(|_| Aggsig::default()).collect();
    let expanded =
        krunk_dict_tree::expand_signatures_for_tree(&word_refs, &placeholder_reachable);
    let dict_tree =
        krunk_dict_tree::build_signed_dict_tree_from_bytes(allocator, &dictionary, &expanded)?;
    let placeholder_pubkey = [0u8; 48];
    let (mp, pp) = curry_krunk_programs(allocator, dict_tree, &placeholder_pubkey)?;
    Ok(GameFactory {
        program: Some(mp.into()),
        parser_program: Some(pp.into()),
        rebuild: Some(GameFactoryRebuild::Krunk {
            words: dictionary.iter().map(|b| b.as_ref().to_vec()).collect(),
            aggregated_sigs: sigs_to_bytes(&placeholder_reachable),
            dict_pubkey: placeholder_pubkey.to_vec(),
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::types::Sha256tree;

    /// Round-trip a Krunk `GameFactory`:
    /// 1. Build the placeholder factory (programs populated, recipe present).
    /// 2. Capture the puzzle hashes of `program` and `parser_program`.
    /// 3. Drop the programs (simulating `#[serde(skip)]` on serialize).
    /// 4. Call `ensure_built` to rebuild from the recipe.
    /// 5. Assert the rebuilt programs hash identically.
    #[test]
    fn krunk_factory_rebuild_round_trip() {
        let mut allocator = AllocEncoder::new();
        let mut factory = build_placeholder_krunk_game_factory(&mut allocator)
            .expect("build placeholder factory");

        let original_program_hash = factory
            .program
            .as_ref()
            .expect("program present")
            .sha256tree(&mut allocator);
        let original_parser_hash = factory
            .parser_program
            .as_ref()
            .expect("parser present")
            .sha256tree(&mut allocator);

        factory.program = None;
        factory.parser_program = None;

        factory
            .ensure_built(&mut allocator)
            .expect("rebuild from recipe");

        let rebuilt_program_hash = factory
            .program
            .as_ref()
            .expect("program rebuilt")
            .sha256tree(&mut allocator);
        let rebuilt_parser_hash = factory
            .parser_program
            .as_ref()
            .expect("parser rebuilt")
            .sha256tree(&mut allocator);

        assert_eq!(rebuilt_program_hash, original_program_hash);
        assert_eq!(rebuilt_parser_hash, original_parser_hash);
    }

    /// Same round-trip but going through bencodex serialization to confirm
    /// that the slim recipe survives the wire format and the rebuilt
    /// factory matches the originals.
    #[test]
    fn krunk_factory_bencodex_round_trip() {
        let mut allocator = AllocEncoder::new();
        let factory = build_placeholder_krunk_game_factory(&mut allocator)
            .expect("build placeholder factory");

        let original_program_hash = factory
            .program
            .as_ref()
            .expect("program present")
            .sha256tree(&mut allocator);
        let original_parser_hash = factory
            .parser_program
            .as_ref()
            .expect("parser present")
            .sha256tree(&mut allocator);

        let bytes = bencodex::to_vec(&factory).expect("serialize");
        let mut roundtripped: GameFactory =
            bencodex::from_slice(&bytes).expect("deserialize");
        assert!(roundtripped.program.is_none(), "program is skipped on serde");
        assert!(
            roundtripped.parser_program.is_none(),
            "parser is skipped on serde"
        );
        assert!(
            roundtripped.rebuild.is_some(),
            "rebuild recipe survives serde"
        );
        roundtripped
            .ensure_built(&mut allocator)
            .expect("rebuild after deserialize");

        let rebuilt_program_hash = roundtripped
            .program
            .as_ref()
            .expect("program rebuilt")
            .sha256tree(&mut allocator);
        let rebuilt_parser_hash = roundtripped
            .parser_program
            .as_ref()
            .expect("parser rebuilt")
            .sha256tree(&mut allocator);

        assert_eq!(rebuilt_program_hash, original_program_hash);
        assert_eq!(rebuilt_parser_hash, original_parser_hash);
    }
}
