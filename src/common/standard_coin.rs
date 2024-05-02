use rand::prelude::*;
use std::fs::read_to_string;

use lazy_static::lazy_static;

use num_bigint::{BigInt, Sign, ToBigInt};
use num_traits::ops::bytes::ToBytes;

use chia_bls;

use clvm_traits::{ToClvm, clvm_curried_args};

use clvmr::allocator::{Allocator, NodePtr, SExp};

use clvm_tools_rs::classic::clvm::__type_compatibility__::{Bytes, BytesFromType, Stream, UnvalidatedBytesFromType, sha256};
use clvm_tools_rs::classic::clvm::serialize::{sexp_from_stream, SimpleCreateCLVMObject};
use clvm_tools_rs::classic::clvm::sexp::flatten;
use clvm_utils::CurriedProgram;

use crate::common::types;
use crate::common::types::{PublicKey, Puzzle, PuzzleHash, ClvmObject, AllocEncoder, IntoErr, Aggsig, Sha256tree, PrivateKey, CoinID, Program};

pub fn shatree_atom_cant_fail(by: &[u8]) -> PuzzleHash {
    let mut allocator = Allocator::new();
    let atom = allocator.new_atom(by).unwrap();
    ClvmObject::from_nodeptr(atom).sha256tree(&mut allocator)
}

lazy_static! {
    pub static ref CREATE_COIN: Vec<u8> = vec![51];

    pub static ref GROUP_ORDER: Vec<u8> = {
        vec![
            0x73,
            0xED,
            0xA7,
            0x53,
            0x29,
            0x9D,
            0x7D,
            0x48,
            0x33,
            0x39,
            0xD8,
            0x08,
            0x09,
            0xA1,
            0xD8,
            0x05,
            0x53,
            0xBD,
            0xA4,
            0x02,
            0xFF,
            0xFE,
            0x5B,
            0xFE,
            0xFF,
            0xFF,
            0xFF,
            0xFF,
            0x00,
            0x00,
            0x00,
            0x01
        ]
    };
    pub static ref DEFAULT_HIDDEN_PUZZLE_HASH: PuzzleHash = {
        let ph: [u8; 32] = [
            0x71,
            0x1d,
            0x6c,
            0x4e,
            0x32,
            0xc9,
            0x2e,
            0x53,
            0x17,
            0x9b,
            0x19,
            0x94,
            0x84,
            0xcf,
            0x8c,
            0x89,
            0x75,
            0x42,
            0xbc,
            0x57,
            0xf2,
            0xb2,
            0x25,
            0x82,
            0x79,
            0x9f,
            0x9d,
            0x65,
            0x7e,
            0xec,
            0x46,
            0x99,
        ];
        PuzzleHash::from_bytes(ph)
    };
    pub static ref DEFAULT_PUZZLE_HASH: PuzzleHash = {
        let ph: [u8; 32] = [
            0xe9,
            0xaa,
            0xa4,
            0x9f,
            0x45,
            0xba,
            0xd5,
            0xc8,
            0x89,
            0xb8,
            0x6e,
            0xe3,
            0x34,
            0x15,
            0x50,
            0xc1,
            0x55,
            0xcf,
            0xdd,
            0x10,
            0xc3,
            0xa6,
            0x75,
            0x7d,
            0xe6,
            0x18,
            0xd2,
            0x06,
            0x12,
            0xff,
            0xfd,
            0x52,
        ];
        PuzzleHash::from_bytes(ph)
    };

    pub static ref ONE_TREEHASH: PuzzleHash = {
        shatree_atom_cant_fail(&[1])
    };

    pub static ref Q_KW_TREEHASH: PuzzleHash = {
        shatree_atom_cant_fail(&[1])
    };

    pub static ref A_KW_TREEHASH: PuzzleHash = {
        shatree_atom_cant_fail(&[2])
    };

    pub static ref C_KW_TREEHASH: PuzzleHash = {
        shatree_atom_cant_fail(&[4])
    };

    pub static ref NULL_TREEHASH: PuzzleHash = {
        shatree_atom_cant_fail(&[])
    };
}
pub fn hex_to_sexp(allocator: &mut Allocator, hex_data: String) -> Result<ClvmObject, types::Error> {
    let mut hex_stream = Stream::new(Some(Bytes::new_validated(Some(UnvalidatedBytesFromType::Hex(hex_data))).into_gen()?));
    Ok(ClvmObject::from_nodeptr(sexp_from_stream(
        allocator,
        &mut hex_stream,
        Box::new(SimpleCreateCLVMObject {})
    ).map(|x| x.1).into_gen()?))
}

pub fn read_hex_puzzle(allocator: &mut Allocator, name: &str) -> Result<Puzzle, types::Error> {
    let hex_data = read_to_string(name).into_gen()?;
    Ok(Puzzle::from_nodeptr(hex_to_sexp(allocator, hex_data)?.to_nodeptr()))
}

pub fn get_standard_coin_puzzle(allocator: &mut Allocator) -> Result<Puzzle, types::Error> {
    read_hex_puzzle(allocator, "resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex")
}

pub fn get_default_hidden_puzzle(allocator: &mut Allocator) -> Result<Puzzle, types::Error> {
    read_hex_puzzle(allocator, "resources/default_hidden_puzzle.hex")
}

fn group_order_int() -> BigInt {
    BigInt::from_bytes_be(Sign::Plus, &GROUP_ORDER)
}

fn calculate_synthetic_offset(public_key: &chia_bls::PublicKey, hidden_puzzle_hash: &PuzzleHash) -> BigInt {
    let mut blob_input = public_key.to_bytes().to_vec();
    for b in hidden_puzzle_hash.bytes().iter() {
        blob_input.push(*b);
    }
    let blob = sha256(Bytes::new(Some(BytesFromType::Raw(blob_input))));
    BigInt::from_bytes_be(Sign::Plus, blob.data()) % group_order_int()
}

fn calculate_synthetic_public_key(public_key: &chia_bls::PublicKey, hidden_puzzle_hash: &PuzzleHash) -> Result<chia_bls::PublicKey, types::Error> {
    let private_key_int = calculate_synthetic_offset(public_key, hidden_puzzle_hash);
    let (_, private_key_bytes_right) = private_key_int.to_bytes_be();
    let mut private_key_bytes: [u8; 32] = [0; 32];
    for (i, b) in private_key_bytes_right.iter().enumerate() {
        private_key_bytes[i + 32 - private_key_bytes.len()] = *b;
    }
    let synthetic_offset = chia_bls::SecretKey::from_bytes(&private_key_bytes).map(Ok).unwrap_or_else(|e| Err(format!("calculate_synthetic_public_key: {e:?}"))).into_gen()?;
    Ok(public_key.clone() + &synthetic_offset.public_key())
}

pub fn puzzle_for_synthetic_public_key(allocator: &mut Allocator, standard_coin_puzzle: &Puzzle, synthetic_public_key: &chia_bls::PublicKey) -> Result<Puzzle, types::Error> {
    let curried_program = CurriedProgram {
        program: standard_coin_puzzle,
        args: clvm_curried_args!(PublicKey::from_bls(synthetic_public_key.clone()))
    };
    let nodeptr = curried_program.to_clvm(&mut AllocEncoder(allocator)).into_gen()?;
    Ok(Puzzle::from_nodeptr(nodeptr))
}

pub fn curried_values_tree_hash(allocator: &mut Allocator, arguments: &[PuzzleHash]) -> Result<PuzzleHash, types::Error> {
    if arguments.is_empty() {
        return Ok(ONE_TREEHASH.clone());
    }

    let structure = ClvmObject::from_nodeptr(
        (
            (C_KW_TREEHASH.clone(), (Q_KW_TREEHASH.clone(), arguments[0].clone())),
            (curried_values_tree_hash(allocator, &arguments[1..])?, NULL_TREEHASH.clone())
        ).to_clvm(&mut AllocEncoder(allocator)).into_gen()?
    );

    Ok(structure.sha256tree(allocator))
}

pub fn curry_and_treehash(allocator: &mut Allocator, hash_of_quoted_mod_hash: &PuzzleHash, hashed_arguments: &[PuzzleHash]) -> Result<PuzzleHash, types::Error> {
    let curried_values = curried_values_tree_hash(allocator, hashed_arguments)?;
    let structure = ClvmObject::from_nodeptr(
        (
            A_KW_TREEHASH.clone(),
            (hash_of_quoted_mod_hash, (curried_values, NULL_TREEHASH.clone()))
        ).to_clvm(&mut AllocEncoder(allocator)).into_gen()?
    );

    Ok(structure.sha256tree(allocator))
}

pub fn calculate_hash_of_quoted_mod_hash(allocator: &mut Allocator, mod_hash: &PuzzleHash) -> Result<PuzzleHash, types::Error> {
    let structure = ClvmObject::from_nodeptr(
        (Q_KW_TREEHASH.clone(), mod_hash).to_clvm(&mut AllocEncoder(allocator)).into_gen()?
    );

    Ok(structure.sha256tree(allocator))
}

pub fn puzzle_hash_for_synthetic_public_key(allocator: &mut Allocator, synthetic_public_key: &chia_bls::PublicKey) -> Result<PuzzleHash, types::Error> {
    let our_public_key = PublicKey::from_bls(synthetic_public_key.clone());
    let quoted_mod_hash = calculate_hash_of_quoted_mod_hash(allocator, &DEFAULT_PUZZLE_HASH)?;
    let public_key_hash = ClvmObject::from_nodeptr(
        our_public_key.to_clvm(&mut AllocEncoder(allocator)).into_gen()?
    ).sha256tree(allocator);
    curry_and_treehash(allocator, &quoted_mod_hash, &[public_key_hash])
}

pub fn puzzle_for_pk(allocator: &mut Allocator, public_key: &PublicKey) -> Result<Puzzle, types::Error> {
    let standard_puzzle = get_standard_coin_puzzle(allocator)?;
    let g1 = public_key.to_bls();
    let synthetic_public_key = calculate_synthetic_public_key(&g1, &DEFAULT_HIDDEN_PUZZLE_HASH)?;
    Ok(puzzle_for_synthetic_public_key(allocator, &standard_puzzle, &synthetic_public_key)?)
}

pub fn puzzle_hash_for_pk(allocator: &mut Allocator, public_key: &PublicKey) -> Result<PuzzleHash, types::Error> {
    let g1 = public_key.to_bls();
    let synthetic_public_key = calculate_synthetic_public_key(&g1, &DEFAULT_HIDDEN_PUZZLE_HASH)?;
    Ok(puzzle_hash_for_synthetic_public_key(allocator, &synthetic_public_key)?)
}

pub fn solution_for_delegated_puzzle(allocator: &mut Allocator, delegated_puzzle: Program, solution: ClvmObject) -> Result<ClvmObject, types::Error> {
    let solution_form = (0, (delegated_puzzle, (solution, ()))).to_clvm(&mut AllocEncoder(allocator)).into_gen()?;
    Ok(ClvmObject::from_nodeptr(solution_form))
}

pub fn solution_for_conditions(allocator: &mut Allocator, conditions: ClvmObject) -> Result<ClvmObject, types::Error> {
    let delegated_puzzle = conditions.to_quoted_program(allocator)?;
    let nil = ClvmObject::nil(allocator);
    solution_for_delegated_puzzle(allocator, delegated_puzzle, nil)
}

pub fn standard_solution(allocator: &mut Allocator, private_key: &PrivateKey, coin_id: &CoinID, conditions: ClvmObject) -> Result<(ClvmObject, Aggsig), types::Error> {
    let solution = solution_for_conditions(allocator, conditions)?;
    let mut exploded_conditions: Vec<NodePtr> = Vec::new();
    flatten(allocator, solution.to_nodeptr(), &mut exploded_conditions);

    for condition in exploded_conditions.iter() {
        let mut exploded_condition: Vec<NodePtr> = Vec::new();
        flatten(allocator, *condition, &mut exploded_condition);
        if exploded_condition.len() <= 2 {
            continue;
        }
        // Enough length

        if !matches!(allocator.sexp(exploded_condition[0]), SExp::Atom) {
            continue;
        }

        // Headed by an atom
        let atom_buf = allocator.atom(exploded_condition[0]);

        if atom_buf != *CREATE_COIN {
            continue;
        }

        // Is a create coin.
        todo!();
    }
    todo!();
}

#[deprecated]
pub fn standard_solution_partial(_allocator: &mut Allocator, _private_key: &PrivateKey, _coin_id: &CoinID, _conditions: ClvmObject, _aggregate_public_key: &PublicKey) -> Result<(ClvmObject, Aggsig), types::Error> {
    todo!();
}

pub fn private_to_public_key(private_key: &types::PrivateKey) -> types::PublicKey {
    let sk = private_key.to_bls();
    PublicKey::from_bls(sk.public_key())
}

pub fn aggregate_public_keys(pk1: &PublicKey, pk2: &PublicKey) -> types::PublicKey {
    let mut result = pk1.clone();
    result += pk2.clone();
    result
}

pub fn aggregate_signatures(as1: &Aggsig, as2: &Aggsig) -> types::Aggsig {
    as1.aggregate(as2)
}

pub fn unsafe_sign<Msg: AsRef<[u8]>>(sk: &PrivateKey, msg: Msg) -> Aggsig {
    sk.sign(msg)
}

pub fn unsafe_sign_partial<Msg: AsRef<[u8]>>(sk: &PrivateKey, pk: &PublicKey, msg: Msg) -> Aggsig {
    let mut aug_msg = pk.bytes().to_vec();
    aug_msg.extend_from_slice(msg.as_ref());
    Aggsig::from_bls(chia_bls::sign_raw(&sk.to_bls(), aug_msg))
}
