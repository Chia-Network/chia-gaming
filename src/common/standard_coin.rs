use std::io;
use std::fs::read_to_string;

use lazy_static::lazy_static;

use num_bigint::{BigInt, Sign};

use chia_bls;

use clvm_traits::{ToClvm, ToClvmError, clvm_curried_args};

use clvmr::allocator::{Allocator, NodePtr};
use clvmr::reduction::EvalErr;

use clvm_tools_rs::classic::clvm::syntax_error::SyntaxErr;
use clvm_tools_rs::classic::clvm::__type_compatibility__::{Bytes, BytesFromType, Stream, UnvalidatedBytesFromType, sha256};
use clvm_tools_rs::classic::clvm::serialize::{sexp_from_stream, SimpleCreateCLVMObject};
use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;
use clvm_utils::CurriedProgram;

use crate::common::types;
use crate::common::types::{PublicKey, Puzzle, PuzzleHash, ClvmObject, ToClvmObject, AllocEncoder, IntoErr, Aggsig};

lazy_static! {
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
    let (_, mut private_key_bytes_right) = private_key_int.to_bytes_be();
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
        args: clvm_curried_args!(PublicKey::from_bls(synthetic_public_key))
    };
    let nodeptr = curried_program.to_clvm(&mut AllocEncoder(allocator)).into_gen()?;
    let dis = disassemble(allocator, nodeptr, None);
    Ok(Puzzle::from_nodeptr(nodeptr))
}

pub fn puzzle_for_pk(allocator: &mut Allocator, standard_coin_puzzle: &Puzzle, public_key: &PublicKey, hidden_puzzle_hash: &PuzzleHash) -> Result<Puzzle, types::Error> {
    chia_bls::PublicKey::from_bytes(public_key.bytes()).into_gen().and_then(|g1| {
        let synthetic_public_key = calculate_synthetic_public_key(&g1, hidden_puzzle_hash)?;
        Ok(puzzle_for_synthetic_public_key(allocator, standard_coin_puzzle, &synthetic_public_key)?)
    })
}

pub fn standard_solution(allocator: &mut Allocator, conditions: ClvmObject) -> Result<ClvmObject, types::Error> {
    Ok(ClvmObject::from_nodeptr((0, (conditions, (0, 0))).to_clvm(&mut AllocEncoder(allocator)).into_gen()?))
}

pub fn private_to_public_key(private_key: &types::PrivateKey) -> Result<types::PublicKey, types::Error> {
    let sk = private_key.to_bls()?;
    let pubkey = sk.public_key();
    Ok(PublicKey::from_bytes(&pubkey.to_bytes()))
}

pub fn aggregate_public_keys(pk1: &PublicKey, pk2: &PublicKey) -> Result<types::PublicKey, types::Error> {
    let pk1_bls = pk1.to_bls()?;
    let pk2_bls = pk2.to_bls()?;
    Ok(PublicKey::from_bytes(&(pk1_bls + &pk2_bls).to_bytes()))
}

pub fn aggregate_signatures(as1: &Aggsig, as2: &Aggsig) -> Result<types::Aggsig, types::Error> {
    let mut as1_bls = as1.to_bls()?;
    let as2_bls = as2.to_bls()?;
    as1_bls.aggregate(&as2_bls);
    Ok(Aggsig::from_bytes(as1_bls.to_bytes()))
}
