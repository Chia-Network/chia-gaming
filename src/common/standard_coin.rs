use std::fs::read_to_string;

use num_bigint::{BigInt, Sign};

use chia_bls;

use clvm_traits::{ToClvm, clvm_curried_args};

use clvmr::allocator::NodePtr;

use clvm_tools_rs::classic::clvm::__type_compatibility__::{Bytes, BytesFromType, Stream, UnvalidatedBytesFromType, sha256};
use clvm_tools_rs::classic::clvm::serialize::{sexp_from_stream, SimpleCreateCLVMObject};

use clvm_utils::CurriedProgram;

use crate::common::constants::{GROUP_ORDER, ONE_TREEHASH, Q_KW_TREEHASH, A_KW_TREEHASH, C_KW_TREEHASH, NULL_TREEHASH, DEFAULT_PUZZLE_HASH, DEFAULT_HIDDEN_PUZZLE_HASH};
use crate::common::types;
use crate::common::types::{PublicKey, Puzzle, PuzzleHash, AllocEncoder, IntoErr, Aggsig, Sha256tree, PrivateKey, CoinID, Program, Node, ToQuotedProgram, Hash, CoinCondition};

pub fn shatree_atom_cant_fail(by: &[u8]) -> PuzzleHash {
    let mut allocator = AllocEncoder::new();
    let atom = allocator.allocator().new_atom(by).unwrap();
    Node(atom).sha256tree(&mut allocator)
}

pub fn hex_to_sexp(allocator: &mut AllocEncoder, hex_data: String) -> Result<NodePtr, types::Error> {
    let mut hex_stream = Stream::new(Some(Bytes::new_validated(Some(UnvalidatedBytesFromType::Hex(hex_data))).into_gen()?));
    Ok(sexp_from_stream(
        allocator.allocator(),
        &mut hex_stream,
        Box::new(SimpleCreateCLVMObject {})
    ).map(|x| x.1).into_gen()?)
}

pub fn read_hex_puzzle(allocator: &mut AllocEncoder, name: &str) -> Result<Puzzle, types::Error> {
    let hex_data = read_to_string(name).into_gen()?;
    Ok(Puzzle::from_nodeptr(hex_to_sexp(allocator, hex_data)?))
}

pub fn get_standard_coin_puzzle(allocator: &mut AllocEncoder) -> Result<Puzzle, types::Error> {
    read_hex_puzzle(allocator, "resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex")
}

pub fn get_default_hidden_puzzle(allocator: &mut AllocEncoder) -> Result<Puzzle, types::Error> {
    read_hex_puzzle(allocator, "resources/default_hidden_puzzle.hex")
}

fn group_order_int() -> BigInt {
    BigInt::from_bytes_be(Sign::Plus, &GROUP_ORDER)
}

fn calculate_synthetic_offset(public_key: &PublicKey, hidden_puzzle_hash: &PuzzleHash) -> BigInt {
    let mut blob_input = public_key.bytes().to_vec();
    blob_input.extend_from_slice(&mut hidden_puzzle_hash.bytes());
    let blob = sha256(Bytes::new(Some(BytesFromType::Raw(blob_input))));
    BigInt::from_bytes_be(Sign::Plus, blob.data()) % group_order_int()
}

pub fn calculate_synthetic_public_key(public_key: &PublicKey, hidden_puzzle_hash: &PuzzleHash) -> Result<PublicKey, types::Error> {
    let private_key_int = calculate_synthetic_offset(public_key, hidden_puzzle_hash);
    let (_, private_key_bytes_right) = private_key_int.to_bytes_be();
    let mut private_key_bytes: [u8; 32] = [0; 32];
    for (i, b) in private_key_bytes_right.iter().enumerate() {
        private_key_bytes[i + 32 - private_key_bytes.len()] = *b;
    }
    let synthetic_offset = PrivateKey::from_bytes(&private_key_bytes).map(Ok).unwrap_or_else(|e| Err(format!("calculate_synthetic_public_key: {e:?}"))).into_gen()?;
    let public_of_synthetic = private_to_public_key(&synthetic_offset);
    Ok(public_key.clone() + public_of_synthetic)
}

pub fn puzzle_for_synthetic_public_key(allocator: &mut AllocEncoder, standard_coin_puzzle: &Puzzle, synthetic_public_key: &PublicKey) -> Result<Puzzle, types::Error> {
    let curried_program = CurriedProgram {
        program: standard_coin_puzzle,
        args: clvm_curried_args!(synthetic_public_key.clone())
    };
    let nodeptr = curried_program.to_clvm(allocator).into_gen()?;
    Ok(Puzzle::from_nodeptr(nodeptr))
}

pub fn curried_values_tree_hash(allocator: &mut AllocEncoder, arguments: &[PuzzleHash]) -> Result<PuzzleHash, types::Error> {
    if arguments.is_empty() {
        return Ok(ONE_TREEHASH.clone());
    }

    let structure = (
        (C_KW_TREEHASH.clone(), (Q_KW_TREEHASH.clone(), arguments[0].clone())),
        (curried_values_tree_hash(allocator, &arguments[1..])?, NULL_TREEHASH.clone())
    ).to_clvm(allocator).into_gen()?;

    Ok(Node(structure).sha256tree(allocator))
}

pub fn curry_and_treehash(allocator: &mut AllocEncoder, hash_of_quoted_mod_hash: &PuzzleHash, hashed_arguments: &[PuzzleHash]) -> Result<PuzzleHash, types::Error> {
    let curried_values = curried_values_tree_hash(allocator, hashed_arguments)?;
    let structure = (
        A_KW_TREEHASH.clone(),
        (hash_of_quoted_mod_hash, (curried_values, NULL_TREEHASH.clone()))
    ).to_clvm(allocator).into_gen()?;

    Ok(Node(structure).sha256tree(allocator))
}

pub fn calculate_hash_of_quoted_mod_hash(allocator: &mut AllocEncoder, mod_hash: &PuzzleHash) -> Result<PuzzleHash, types::Error> {
    let structure =
        (Q_KW_TREEHASH.clone(), mod_hash).to_clvm(allocator).into_gen()?;

    Ok(Node(structure).sha256tree(allocator))
}

pub fn puzzle_hash_for_synthetic_public_key(allocator: &mut AllocEncoder, synthetic_public_key: &PublicKey) -> Result<PuzzleHash, types::Error> {
    let quoted_mod_hash = calculate_hash_of_quoted_mod_hash(allocator, &DEFAULT_PUZZLE_HASH)?;
    let public_key_hash = Node(synthetic_public_key.to_clvm(allocator).into_gen()?)
        .sha256tree(allocator);
    curry_and_treehash(allocator, &quoted_mod_hash, &[public_key_hash])
}

pub fn puzzle_for_pk(allocator: &mut AllocEncoder, public_key: &PublicKey) -> Result<Puzzle, types::Error> {
    let standard_puzzle = get_standard_coin_puzzle(allocator)?;
    let synthetic_public_key = calculate_synthetic_public_key(&public_key, &DEFAULT_HIDDEN_PUZZLE_HASH)?;
    Ok(puzzle_for_synthetic_public_key(allocator, &standard_puzzle, &synthetic_public_key)?)
}

pub fn puzzle_hash_for_pk(allocator: &mut AllocEncoder, public_key: &PublicKey) -> Result<PuzzleHash, types::Error> {
    let synthetic_public_key = calculate_synthetic_public_key(&public_key, &DEFAULT_HIDDEN_PUZZLE_HASH)?;
    Ok(puzzle_hash_for_synthetic_public_key(allocator, &synthetic_public_key)?)
}

pub fn solution_for_delegated_puzzle(allocator: &mut AllocEncoder, delegated_puzzle: Program, solution: NodePtr) -> Result<NodePtr, types::Error> {
    let solution_form = (0, (delegated_puzzle, (Node(solution), ()))).to_clvm(allocator).into_gen()?;
    Ok(solution_form)
}

pub fn solution_for_conditions(allocator: &mut AllocEncoder, conditions: NodePtr) -> Result<NodePtr, types::Error> {
    let delegated_puzzle = conditions.to_quoted_program(allocator)?;
    let nil = allocator.allocator().null();
    solution_for_delegated_puzzle(allocator, delegated_puzzle, nil)
}

// Ported from: https://github.com/richardkiss/chialisp_stdlib/blob/bram-api/chialisp_stdlib/nightly/signing.clinc

// returns a signer which takes a value to be signed and returns an aggsig which
// needs to be combined with the rest of the signature
pub fn partial_signer(private_key: &PrivateKey, final_public_key: &PublicKey, value: &[u8]) -> Aggsig {
    let mut message = final_public_key.bytes().to_vec();
    message.append(&mut value.to_vec());
    let mut sig = chia_bls::hash_to_g2(&message);
    sig.scalar_multiply(&private_key.bytes());
    Aggsig::from_bls(sig)
}

// returns (public_key signer)
// The signer takes a value to be signed and returns an aggsig
pub fn signer(private_key: &PrivateKey, value: &[u8]) -> (PublicKey, Aggsig) {
    let public_key = private_to_public_key(private_key);
    let sig = partial_signer(private_key, &public_key, value);
    (public_key, sig)
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

// From: https://github.com/Chia-Network/chia_rs/blob/2334c842f694444da317fa7432f308f159f62d70/chia-wallet/src/wallet.rs#L1166
// which appears to still be in development.
pub fn agg_sig_me_message(
    raw_message: &[u8],
    coin_id: &CoinID,
    agg_sig_me_extra_data: &Hash
) -> Vec<u8> {
    let mut message = Vec::with_capacity(96);
    message.extend(raw_message);
    message.extend(coin_id.bytes());
    message.extend(agg_sig_me_extra_data.bytes());
    message
}
pub fn sign_agg_sig_me(
    secret_key: &PrivateKey,
    raw_message: &[u8],
    coin_id: &CoinID,
    agg_sig_me_extra_data: &Hash,
) -> Aggsig {
    let message = agg_sig_me_message(raw_message, coin_id, agg_sig_me_extra_data);
    secret_key.sign(&message)
}

pub fn standard_solution(allocator: &mut AllocEncoder, private_key: &PrivateKey, conditions: NodePtr) -> Result<(NodePtr, Aggsig), types::Error> {
    let quoted_conds = conditions.to_quoted_program(allocator)?;
    let quoted_conds_hash = quoted_conds.sha256tree(allocator);
    let solution = solution_for_conditions(allocator, conditions)?;
    let (_, sig) = signer(private_key, &quoted_conds_hash.bytes());
    Ok((solution, sig))
}

pub fn standard_solution_partial(
    allocator: &mut AllocEncoder,
    private_key: &PrivateKey,
    unroll_coin_parent: &CoinID,
    conditions: NodePtr,
    aggregate_public_key: &PublicKey,
    agg_sig_me_additional_data: &Hash,
) -> Result<(NodePtr, Aggsig), types::Error> {
    // Fairly certain i understand that because of the property that
    // (SK1 + SK2).sign((PK1 + PK2) || msg) ==
    //   (SK1.sign(PK1 || msg) + SK2.sign(PK2 || msg))
    // We can pass in the aggregate public key as synthetic public key here.
    // Private key is the originator of one public key for this signature
    // so we should be able to add a signature with the other private key
    // in order to get a valid signature.
    //
    // Since the caller specifies the AGG_SIG conditions, they'll have what
    // they're supposed to in their pubkey field (i think).
    let standard_puzzle = get_standard_coin_puzzle(allocator)?;
    let puzzle = puzzle_for_synthetic_public_key(
        allocator, &standard_puzzle, aggregate_public_key
    )?;

    let quoted_conds = conditions.to_quoted_program(allocator)?;
    let quoted_conds_hash = quoted_conds.sha256tree(allocator);
    let solution = solution_for_conditions(allocator, conditions)?;

    let mut aggregated_signature: Option<Aggsig> = None;

    let add_signature = |aggregated_signature: &mut Option<Aggsig>, new_sig| {
        if let Some(agg) = aggregated_signature {
            *aggregated_signature = Some(agg.aggregate(&new_sig));
            return;
        }

        *aggregated_signature = Some(new_sig);
    };

    // The conditions we send in are the ones we get out in the standard coin
    // so in this case we can front load the conditions without running the puzzle.
    // Ensure we unborrow allocator before the code below.
    let conds = CoinCondition::from_nodeptr(allocator, conditions);
    for cond in conds.iter() {
        match cond {
            CoinCondition::CreateCoin(ph) => {
                let agg_sig_me_message = agg_sig_me_message(
                    &quoted_conds_hash.bytes(),
                    unroll_coin_parent,
                    agg_sig_me_additional_data
                );
                add_signature(&mut aggregated_signature, partial_signer(
                    private_key, aggregate_public_key, &agg_sig_me_message
                ));
            }
            CoinCondition::AggSigMe(pubkey, data) => {
                let mut message = pubkey.bytes().to_vec();
                message.extend_from_slice(&data);
                let agg_sig_me_message = agg_sig_me_message(
                    &message,
                    unroll_coin_parent,
                    agg_sig_me_additional_data
                );
                add_signature(&mut aggregated_signature, partial_signer(
                    private_key, &pubkey, &agg_sig_me_message
                ));
            }
            CoinCondition::AggSigUnsafe(pubkey, data) => {
                // It's "unsafe" because it's just a hash of the data.
                add_signature(&mut aggregated_signature, partial_signer(
                    private_key, &pubkey, &data
                ));
            }
        }
    }
    if let Some(sig) = aggregated_signature {
        Ok((solution, sig))
    } else {
        Err(types::Error::StrErr("Failed to get a signature from the spend".to_string()))
    }
}
