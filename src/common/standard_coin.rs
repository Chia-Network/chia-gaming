use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::read_to_string;
use std::rc::Rc;

use hex::FromHex;
use log::debug;
use num_bigint::{BigInt, Sign};

use chia_bls;

use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;

use clvmr::serde::node_from_bytes;
use clvmr::NodePtr;

use crate::utils::{number_from_u8, u8_from_number};

use crate::utils::map_m;

use crate::common::constants::{
    A_KW, CREATE_COIN, C_KW, DEFAULT_HIDDEN_PUZZLE_HASH, DEFAULT_PUZZLE_HASH, GROUP_ORDER, ONE,
    Q_KW, Q_KW_TREEHASH, TWO,
};
use crate::common::types;
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, BrokenOutCoinSpendInfo, CoinCondition, CoinID, Hash, IntoErr,
    Node, PrivateKey, Program, ProgramRef, PublicKey, Puzzle, PuzzleHash, Sha256Input, Sha256tree,
    ToQuotedProgram,
};

thread_local! {
    pub static PRESET_FILES: RefCell<HashMap<String, String>> = RefCell::default();
}

pub fn wasm_deposit_file(name: &str, data: &str) {
    PRESET_FILES.with(|p| {
        p.borrow_mut().insert(name.to_string(), data.to_string());
    });
}

pub fn hex_to_sexp(allocator: &mut AllocEncoder, hex_data: &str) -> Result<NodePtr, types::Error> {
    let hex_stream = Vec::<u8>::from_hex(hex_data.trim()).into_gen()?;
    node_from_bytes(allocator.allocator(), &hex_stream).into_gen()
}

pub fn read_hex_puzzle(allocator: &mut AllocEncoder, name: &str) -> Result<Puzzle, types::Error> {
    let hex_data = if let Some(data) = PRESET_FILES.with(|p| p.borrow().get(name).cloned()) {
        data
    } else {
        read_to_string(name).into_gen()?
    };
    let hex_sexp = hex_to_sexp(allocator, &hex_data)?;
    Puzzle::from_nodeptr(allocator, hex_sexp)
}

pub fn get_standard_coin_puzzle(allocator: &mut AllocEncoder) -> Result<Puzzle, types::Error> {
    read_hex_puzzle(
        allocator,
        "resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex",
    )
}

fn group_order_int() -> BigInt {
    BigInt::from_bytes_be(Sign::Plus, &GROUP_ORDER)
}

fn calculate_synthetic_offset(public_key: &PublicKey, hidden_puzzle_hash: &PuzzleHash) -> BigInt {
    let mut blob_input = public_key.bytes().to_vec();
    blob_input.extend_from_slice(hidden_puzzle_hash.bytes());
    let blob = Sha256Input::Bytes(&blob_input).hash();
    BigInt::from_bytes_be(Sign::Plus, blob.bytes()) % group_order_int()
}

#[test]
fn test_calculate_synthetic_offset() {
    let pk_bytes: [u8; 48] = [
        0xa3, 0xbb, 0xce, 0xd3, 0x3d, 0x27, 0x32, 0x9d, 0xa1, 0xe3, 0x60, 0xff, 0x4b, 0x0f, 0x00,
        0xdb, 0x17, 0x47, 0xee, 0xe8, 0xe6, 0x6c, 0x0c, 0x0a, 0xe4, 0x50, 0xf9, 0x0b, 0x76, 0x0f,
        0x42, 0x97, 0x22, 0x16, 0xc2, 0xff, 0x02, 0x76, 0x36, 0xae, 0xeb, 0x52, 0x68, 0xbc, 0x2b,
        0xe2, 0xce, 0xdb,
    ];
    let pk = PublicKey::from_bytes(pk_bytes).expect("should be ok");
    let default_hidden_puzzle_hash = PuzzleHash::from_bytes(DEFAULT_HIDDEN_PUZZLE_HASH);
    let offset = calculate_synthetic_offset(&pk, &default_hidden_puzzle_hash);
    let want_offset_bytes = [
        0x69, 0x51, 0x33, 0xf4, 0x61, 0x0a, 0x5e, 0x50, 0x7b, 0x2f, 0x24, 0x98, 0x22, 0x21, 0x91,
        0xde, 0x54, 0x6e, 0xeb, 0x53, 0x90, 0x46, 0x34, 0x52, 0x74, 0x61, 0x39, 0x71, 0x4f, 0x05,
        0x94, 0x65,
    ];
    let want_offset = number_from_u8(&want_offset_bytes);
    assert_eq!(offset, want_offset);
}

pub fn calculate_synthetic_secret_key(
    secret_key: &PrivateKey,
    hidden_puzzle_hash: &Hash,
) -> Result<PrivateKey, types::Error> {
    let secret_exponent_bytes = secret_key.bytes();
    let secret_exponent = number_from_u8(&secret_exponent_bytes);
    let public_key = private_to_public_key(secret_key);
    let synthetic_secret_offset = calculate_synthetic_offset(
        &public_key,
        &PuzzleHash::from_hash(hidden_puzzle_hash.clone()),
    );
    let synthetic_secret_exponent = (secret_exponent + synthetic_secret_offset) % group_order_int();
    let private_key_bytes_right = u8_from_number(synthetic_secret_exponent);
    let mut private_key_bytes: [u8; 32] = [0; 32];
    for (i, b) in private_key_bytes_right.iter().enumerate() {
        private_key_bytes[i + 32 - private_key_bytes.len()] = *b;
    }
    PrivateKey::from_bytes(&private_key_bytes)
        .map(Ok)
        .unwrap_or_else(|e| Err(format!("calculate_synthetic_public_key: {e:?}")))
        .into_gen()
}

pub fn calculate_synthetic_public_key(
    public_key: &PublicKey,
    hidden_puzzle_hash: &PuzzleHash,
) -> Result<PublicKey, types::Error> {
    let private_key_int = calculate_synthetic_offset(public_key, hidden_puzzle_hash);
    let (_, private_key_bytes_right) = private_key_int.to_bytes_be();
    let mut private_key_bytes: [u8; 32] = [0; 32];
    for (i, b) in private_key_bytes_right.iter().enumerate() {
        private_key_bytes[i + 32 - private_key_bytes.len()] = *b;
    }
    let synthetic_offset = PrivateKey::from_bytes(&private_key_bytes)
        .map(Ok)
        .unwrap_or_else(|e| Err(format!("calculate_synthetic_public_key: {e:?}")))
        .into_gen()?;
    let public_of_synthetic = private_to_public_key(&synthetic_offset);
    Ok(public_key.clone() + public_of_synthetic)
}

#[test]
fn test_calculate_synthetic_public_key() {
    let pk_bytes: [u8; 48] = [
        0xa3, 0xbb, 0xce, 0xd3, 0x3d, 0x27, 0x32, 0x9d, 0xa1, 0xe3, 0x60, 0xff, 0x4b, 0x0f, 0x00,
        0xdb, 0x17, 0x47, 0xee, 0xe8, 0xe6, 0x6c, 0x0c, 0x0a, 0xe4, 0x50, 0xf9, 0x0b, 0x76, 0x0f,
        0x42, 0x97, 0x22, 0x16, 0xc2, 0xff, 0x02, 0x76, 0x36, 0xae, 0xeb, 0x52, 0x68, 0xbc, 0x2b,
        0xe2, 0xce, 0xdb,
    ];
    let pk = PublicKey::from_bytes(pk_bytes).expect("should be ok");
    let default_hidden_puzzle_hash = PuzzleHash::from_bytes(DEFAULT_HIDDEN_PUZZLE_HASH);
    let spk =
        calculate_synthetic_public_key(&pk, &default_hidden_puzzle_hash).expect("should be ok");
    let want_spk_bytes: [u8; 48] = [
        0x93, 0xbd, 0x85, 0x12, 0x8d, 0x0e, 0x9f, 0xbc, 0xfc, 0xa5, 0x47, 0xb9, 0x64, 0xbd, 0x31,
        0x80, 0x77, 0x7c, 0x6f, 0xe9, 0xfa, 0xd8, 0x08, 0xdd, 0xa4, 0x15, 0xbb, 0x32, 0x88, 0x70,
        0x22, 0x86, 0x47, 0x74, 0xb5, 0xff, 0x04, 0x45, 0x2b, 0x88, 0xbc, 0x98, 0x29, 0x40, 0x8f,
        0xb7, 0xf8, 0x87,
    ];
    let want_spk = PublicKey::from_bytes(want_spk_bytes).expect("should be ok");
    assert_eq!(spk, want_spk);
}

pub fn puzzle_for_synthetic_public_key(
    allocator: &mut AllocEncoder,
    standard_coin_puzzle: &Puzzle,
    synthetic_public_key: &PublicKey,
) -> Result<Puzzle, types::Error> {
    let curried_program = CurriedProgram {
        program: standard_coin_puzzle,
        args: clvm_curried_args!(synthetic_public_key.clone()),
    };
    let nodeptr = curried_program.to_clvm(allocator).into_gen()?;
    Puzzle::from_nodeptr(allocator, nodeptr)
}

fn hash_of_consed_parameter_hash(environment: &Hash, parameter: &Hash) -> Hash {
    Sha256Input::Array(vec![
        Sha256Input::Bytes(&TWO),
        Sha256Input::Hashed(vec![Sha256Input::Bytes(&ONE), Sha256Input::Bytes(&C_KW)]),
        Sha256Input::Hashed(vec![
            Sha256Input::Bytes(&TWO),
            Sha256Input::Hashed(vec![
                Sha256Input::Bytes(&TWO),
                Sha256Input::Hashed(vec![Sha256Input::Bytes(&ONE), Sha256Input::Bytes(&Q_KW)]),
                Sha256Input::Hash(parameter),
            ]),
            Sha256Input::Hashed(vec![
                Sha256Input::Bytes(&TWO),
                Sha256Input::Hash(environment),
                Sha256Input::Hashed(vec![Sha256Input::Bytes(&ONE)]),
            ]),
        ]),
    ])
    .hash()
}

pub fn curry_and_treehash(
    hash_of_quoted_mod_hash: &PuzzleHash,
    hashed_arguments: &[PuzzleHash],
) -> PuzzleHash {
    let mut env = Sha256Input::Bytes(&[1, 1]).hash();

    for arg in hashed_arguments.iter().rev() {
        env = hash_of_consed_parameter_hash(&env, arg.hash());
    }

    PuzzleHash::from_hash(
        Sha256Input::Array(vec![
            Sha256Input::Bytes(&TWO),
            Sha256Input::Hashed(vec![Sha256Input::Bytes(&ONE), Sha256Input::Bytes(&A_KW)]),
            Sha256Input::Hashed(vec![
                Sha256Input::Bytes(&TWO),
                Sha256Input::Hash(hash_of_quoted_mod_hash.hash()),
                Sha256Input::Hashed(vec![
                    Sha256Input::Bytes(&TWO),
                    Sha256Input::Hash(&env),
                    Sha256Input::Hashed(vec![Sha256Input::Bytes(&ONE)]),
                ]),
            ]),
        ])
        .hash(),
    )
}

pub fn calculate_hash_of_quoted_mod_hash(mod_hash: &PuzzleHash) -> Hash {
    Sha256Input::Array(vec![
        Sha256Input::Bytes(&TWO),
        Sha256Input::Hash(&Q_KW_TREEHASH),
        Sha256Input::Hash(mod_hash.hash()),
    ])
    .hash()
}

pub fn puzzle_hash_for_synthetic_public_key(
    allocator: &mut AllocEncoder,
    synthetic_public_key: &PublicKey,
) -> Result<PuzzleHash, types::Error> {
    let quoted_mod_hash = PuzzleHash::from_hash(calculate_hash_of_quoted_mod_hash(
        &PuzzleHash::from_bytes(DEFAULT_PUZZLE_HASH),
    ));
    let public_key_hash =
        Node(synthetic_public_key.to_clvm(allocator).into_gen()?).sha256tree(allocator);
    Ok(curry_and_treehash(&quoted_mod_hash, &[public_key_hash]))
}

#[test]
fn test_puzzle_for_synthetic_public_key() {
    let mut allocator = AllocEncoder::new();
    let expect_hex = "ff02ffff01ff02ffff01ff02ffff03ff0bffff01ff02ffff03ffff09ff05ffff1dff0bffff1effff0bff0bffff02ff06ffff04ff02ffff04ff17ff8080808080808080ffff01ff02ff17ff2f80ffff01ff088080ff0180ffff01ff04ffff04ff04ffff04ff05ffff04ffff02ff06ffff04ff02ffff04ff17ff80808080ff80808080ffff02ff17ff2f808080ff0180ffff04ffff01ff32ff02ffff03ffff07ff0580ffff01ff0bffff0102ffff02ff06ffff04ff02ffff04ff09ff80808080ffff02ff06ffff04ff02ffff04ff0dff8080808080ffff01ff0bffff0101ff058080ff0180ff018080ffff04ffff01b0a3bbced33d27329da1e360ff4b0f00db1747eee8e66c0c0ae450f90b760f42972216c2ff027636aeeb5268bc2be2cedbff018080";
    let expect_program = hex_to_sexp(&mut allocator, &expect_hex).expect("should be good hex");
    let expect_hash = Node(expect_program).sha256tree(&mut allocator);

    let pk_bytes: [u8; 48] = [
        0xa3, 0xbb, 0xce, 0xd3, 0x3d, 0x27, 0x32, 0x9d, 0xa1, 0xe3, 0x60, 0xff, 0x4b, 0x0f, 0x00,
        0xdb, 0x17, 0x47, 0xee, 0xe8, 0xe6, 0x6c, 0x0c, 0x0a, 0xe4, 0x50, 0xf9, 0x0b, 0x76, 0x0f,
        0x42, 0x97, 0x22, 0x16, 0xc2, 0xff, 0x02, 0x76, 0x36, 0xae, 0xeb, 0x52, 0x68, 0xbc, 0x2b,
        0xe2, 0xce, 0xdb,
    ];
    let pk = PublicKey::from_bytes(pk_bytes).expect("should be ok");

    let standard_coin_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should read");
    let puzzle_for_synthetic_public_key =
        puzzle_for_synthetic_public_key(&mut allocator, &standard_coin_puzzle, &pk)
            .expect("should work");
    assert_eq!(
        puzzle_for_synthetic_public_key.sha256tree(&mut allocator),
        expect_hash
    );
    assert_eq!(
        expect_hash,
        puzzle_hash_for_synthetic_public_key(&mut allocator, &pk).expect("should make")
    );
}

pub fn puzzle_for_pk(
    allocator: &mut AllocEncoder,
    public_key: &PublicKey,
) -> Result<Puzzle, types::Error> {
    let standard_puzzle = get_standard_coin_puzzle(allocator)?;
    let synthetic_public_key = calculate_synthetic_public_key(
        public_key,
        &PuzzleHash::from_bytes(DEFAULT_HIDDEN_PUZZLE_HASH),
    )?;
    puzzle_for_synthetic_public_key(allocator, &standard_puzzle, &synthetic_public_key)
}

pub fn puzzle_hash_for_pk(
    allocator: &mut AllocEncoder,
    public_key: &PublicKey,
) -> Result<PuzzleHash, types::Error> {
    let synthetic_public_key = calculate_synthetic_public_key(
        public_key,
        &PuzzleHash::from_bytes(DEFAULT_HIDDEN_PUZZLE_HASH),
    )?;
    puzzle_hash_for_synthetic_public_key(allocator, &synthetic_public_key)
}

#[test]
fn test_puzzle_for_pk() {
    let mut allocator = AllocEncoder::new();

    let pk_bytes: [u8; 48] = [
        0xa3, 0xbb, 0xce, 0xd3, 0x3d, 0x27, 0x32, 0x9d, 0xa1, 0xe3, 0x60, 0xff, 0x4b, 0x0f, 0x00,
        0xdb, 0x17, 0x47, 0xee, 0xe8, 0xe6, 0x6c, 0x0c, 0x0a, 0xe4, 0x50, 0xf9, 0x0b, 0x76, 0x0f,
        0x42, 0x97, 0x22, 0x16, 0xc2, 0xff, 0x02, 0x76, 0x36, 0xae, 0xeb, 0x52, 0x68, 0xbc, 0x2b,
        0xe2, 0xce, 0xdb,
    ];
    let pk = PublicKey::from_bytes(pk_bytes).expect("should be ok");

    let want_puzzle_for_pk = "ff02ffff01ff02ffff01ff02ffff03ff0bffff01ff02ffff03ffff09ff05ffff1dff0bffff1effff0bff0bffff02ff06ffff04ff02ffff04ff17ff8080808080808080ffff01ff02ff17ff2f80ffff01ff088080ff0180ffff01ff04ffff04ff04ffff04ff05ffff04ffff02ff06ffff04ff02ffff04ff17ff80808080ff80808080ffff02ff17ff2f808080ff0180ffff04ffff01ff32ff02ffff03ffff07ff0580ffff01ff0bffff0102ffff02ff06ffff04ff02ffff04ff09ff80808080ffff02ff06ffff04ff02ffff04ff0dff8080808080ffff01ff0bffff0101ff058080ff0180ff018080ffff04ffff01b093bd85128d0e9fbcfca547b964bd3180777c6fe9fad808dda415bb32887022864774b5ff04452b88bc9829408fb7f887ff018080";
    let want_puzzle = hex_to_sexp(&mut allocator, want_puzzle_for_pk).expect("should be ok hex");
    let want_puzzle_hash = Node(want_puzzle).sha256tree(&mut allocator);

    let got_puzzle = puzzle_for_pk(&mut allocator, &pk).expect("should be ok");
    let got_puzzle_hash = got_puzzle.sha256tree(&mut allocator);

    let predicted_puzzle_hash = puzzle_hash_for_pk(&mut allocator, &pk).expect("should be ok");

    assert_eq!(want_puzzle_hash, got_puzzle_hash);
    assert_eq!(got_puzzle_hash, predicted_puzzle_hash);
}

pub fn solution_for_delegated_puzzle(
    allocator: &mut AllocEncoder,
    delegated_puzzle: Program,
    solution: NodePtr,
) -> Result<NodePtr, types::Error> {
    let solution_form = (0, (delegated_puzzle, (Node(solution), ())))
        .to_clvm(allocator)
        .into_gen()?;
    Ok(solution_form)
}

pub fn solution_for_conditions(
    allocator: &mut AllocEncoder,
    conditions: NodePtr,
) -> Result<NodePtr, types::Error> {
    let delegated_puzzle = conditions.to_quoted_program(allocator)?;
    let nil = allocator.allocator().nil();
    solution_for_delegated_puzzle(allocator, delegated_puzzle, nil)
}

// Ported from: https://github.com/richardkiss/chialisp_stdlib/blob/bram-api/chialisp_stdlib/nightly/signing.clinc

// returns a signer which takes a value to be signed and returns an aggsig which
// needs to be combined with the rest of the signature
pub fn partial_signer(
    private_key: &PrivateKey,
    final_public_key: &PublicKey,
    value: &[u8],
) -> Aggsig {
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

// XXX Make one step conversions to puzzle hash and puzzle for private key.
pub fn private_to_public_key(private_key: &types::PrivateKey) -> types::PublicKey {
    let sk = private_key.to_bls();
    PublicKey::from_bls(sk.public_key())
}

pub fn unsafe_sign_partial<Msg: AsRef<[u8]>>(sk: &PrivateKey, pk: &PublicKey, msg: Msg) -> Aggsig {
    let mut aug_msg = pk.bytes().to_vec();
    aug_msg.extend_from_slice(msg.as_ref());
    Aggsig::from_bls(chia_bls::sign_raw(sk.to_bls(), aug_msg))
}

// From: https://github.com/Chia-Network/chia_rs/blob/2334c842f694444da317fa7432f308f159f62d70/chia-wallet/src/wallet.rs#L1166
// which appears to still be in development.
pub fn agg_sig_me_message(
    raw_message: &[u8],
    coin_id: &CoinID,
    agg_sig_me_extra_data: &Hash,
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
    let public_key = private_to_public_key(secret_key);
    let signed = secret_key.sign(&message);
    assert!(signed.verify(&public_key, &message));
    signed
}

pub fn standard_solution_unsafe(
    allocator: &mut AllocEncoder,
    private_key: &PrivateKey,
    conditions: NodePtr,
) -> Result<BrokenOutCoinSpendInfo, types::Error> {
    let quoted_conds = conditions.to_quoted_program(allocator)?;
    let quoted_conds_hash = quoted_conds.sha256tree(allocator);
    let solution = solution_for_conditions(allocator, conditions)?;
    let solution_program = Program::from_nodeptr(allocator, solution)?;
    let message = quoted_conds_hash.bytes().to_vec();
    let (_, sig) = signer(private_key, &message);
    let conditions_program = Program::from_nodeptr(allocator, conditions)?;
    Ok(BrokenOutCoinSpendInfo {
        solution: ProgramRef::new(Rc::new(solution_program)),
        conditions: ProgramRef::new(Rc::new(conditions_program)),
        message,
        signature: sig,
    })
}

pub fn standard_solution_partial(
    allocator: &mut AllocEncoder,
    private_key: &PrivateKey,
    parent_coin: &CoinID,
    conditions: NodePtr,
    aggregate_public_key: &PublicKey,
    agg_sig_me_additional_data: &Hash,
    partial: bool,
) -> Result<BrokenOutCoinSpendInfo, types::Error> {
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
    let quoted_conds = conditions.to_quoted_program(allocator)?;
    let quoted_conds_hash = quoted_conds.sha256tree(allocator);
    let solution = solution_for_conditions(allocator, conditions)?;
    debug!("standard signing with parent coin {parent_coin:?}");
    let coin_agg_sig_me_message = agg_sig_me_message(
        quoted_conds_hash.bytes(),
        parent_coin,
        agg_sig_me_additional_data,
    );

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
    let mut one_create = false;
    for cond in conds.iter() {
        match cond {
            CoinCondition::CreateCoin(_, _) => {
                debug!("adding signature based on create coin: {aggregate_public_key:?} {coin_agg_sig_me_message:?}");
                if !one_create {
                    one_create = true;
                    add_signature(
                        &mut aggregated_signature,
                        if partial {
                            partial_signer(
                                private_key,
                                aggregate_public_key,
                                &coin_agg_sig_me_message,
                            )
                        } else {
                            private_key.sign(&coin_agg_sig_me_message)
                        },
                    );
                }
            }
            CoinCondition::AggSigMe(pubkey, data) => {
                let mut message = pubkey.bytes().to_vec();
                message.extend_from_slice(data);
                let extra_agg_sig_me_message =
                    agg_sig_me_message(&message, parent_coin, agg_sig_me_additional_data);
                add_signature(
                    &mut aggregated_signature,
                    partial_signer(private_key, pubkey, &extra_agg_sig_me_message),
                );
            }
            CoinCondition::AggSigUnsafe(pubkey, data) => {
                // It's "unsafe" because it's just a hash of the data.
                debug!("adding unsafe sig for {data:?}");
                add_signature(
                    &mut aggregated_signature,
                    partial_signer(private_key, pubkey, data),
                );
            }
            _ => {}
        }
    }

    // Assume something like create coin if nothing else.
    if aggregated_signature.is_none() {
        add_signature(
            &mut aggregated_signature,
            if partial {
                partial_signer(private_key, aggregate_public_key, &coin_agg_sig_me_message)
            } else {
                private_key.sign(&coin_agg_sig_me_message)
            },
        );
    }

    if let Some(signature) = aggregated_signature {
        let solution_program = Program::from_nodeptr(allocator, solution)?;
        let conditions_program = Program::from_nodeptr(allocator, conditions)?;
        Ok(BrokenOutCoinSpendInfo {
            solution: ProgramRef::new(Rc::new(solution_program.clone())),
            signature,
            conditions: ProgramRef::new(Rc::new(conditions_program.clone())),
            message: coin_agg_sig_me_message,
        })
    } else {
        Err(types::Error::StrErr(
            "Failed to get a signature from the spend".to_string(),
        ))
    }
}

#[derive(Clone)]
pub struct ChiaIdentity {
    pub private_key: PrivateKey,
    pub synthetic_public_key: PublicKey,
    pub public_key: PublicKey,
    pub synthetic_private_key: PrivateKey,
    pub puzzle: Puzzle,
    pub puzzle_hash: PuzzleHash,
}

impl ChiaIdentity {
    pub fn new(
        allocator: &mut AllocEncoder,
        private_key: PrivateKey,
    ) -> Result<Self, types::Error> {
        let default_hidden_puzzle_hash = Hash::from_bytes(DEFAULT_HIDDEN_PUZZLE_HASH);
        let synthetic_private_key =
            calculate_synthetic_secret_key(&private_key, &default_hidden_puzzle_hash)?;
        let public_key = private_to_public_key(&private_key);
        let synthetic_public_key = private_to_public_key(&synthetic_private_key);
        let puzzle = puzzle_for_pk(allocator, &public_key)?;
        let puzzle_hash = puzzle_hash_for_pk(allocator, &public_key)?;
        assert_eq!(puzzle.sha256tree(allocator), puzzle_hash);
        Ok(ChiaIdentity {
            private_key,
            synthetic_private_key,
            puzzle,
            puzzle_hash,
            public_key,
            synthetic_public_key,
        })
    }

    pub fn standard_solution(
        &self,
        allocator: &mut AllocEncoder,
        targets: &[(PuzzleHash, Amount)],
    ) -> Result<NodePtr, types::Error> {
        let conditions: Vec<Node> = map_m(
            |(ph, amt)| {
                Ok(Node(
                    (CREATE_COIN, (ph.clone(), (amt.clone(), ())))
                        .to_clvm(allocator)
                        .into_gen()?,
                ))
            },
            targets,
        )?;
        let conditions_converted = conditions.to_clvm(allocator).into_gen()?;
        solution_for_conditions(allocator, conditions_converted)
    }
}
