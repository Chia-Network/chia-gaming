use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;
use clvm_tools_rs::classic::clvm_tools::stages::stage_0::{DefaultProgramRunner, TRunProgram};

use crate::common::constants::{DEFAULT_HIDDEN_PUZZLE_HASH, ONE, TWO};
use crate::common::standard_coin::{
    calculate_hash_of_quoted_mod_hash, calculate_synthetic_public_key, curry_and_treehash,
    get_standard_coin_puzzle, hex_to_sexp, partial_signer, private_to_public_key, puzzle_for_pk,
    puzzle_hash_for_pk, standard_solution_unsafe, unsafe_sign_partial,
};
use crate::common::types::{
    Aggsig, AllocEncoder, Node, PrivateKey, PublicKey, PuzzleHash, Sha256Input, Sha256tree,
    ToQuotedProgram, Hash
};
use crate::tests::constants::{
    EXPECTED_PUZZLE_HEX, KEY_PAIR_PARTIAL_SIGNER_TEST_RESULT, KEY_PAIR_PRIVATE, KEY_PAIR_PUBLIC,
    KEY_PAIR_SYNTHETIC_PUBLIC_KEY, STANDARD_PUZZLE_HASH, TEST_PUBLIC_KEY_BYTES,
};

#[test]
fn test_standard_puzzle() {
    let mut allocator = AllocEncoder::new();
    let test_key =
        PublicKey::from_bytes(TEST_PUBLIC_KEY_BYTES.clone()).expect("should be a public key");
    let puzzle = puzzle_for_pk(&mut allocator, &test_key).expect("should work");
    let puzzle_hash = puzzle.sha256tree(&mut allocator);
    let expected_puzzle =
        hex_to_sexp(&mut allocator, EXPECTED_PUZZLE_HEX.clone()).expect("should convert");
    let expected_hash = Node(expected_puzzle).sha256tree(&mut allocator);
    assert_eq!(expected_hash, puzzle_hash);
}

#[test]
fn test_public_key_add() {
    let mut rng = ChaCha8Rng::from_seed([0; 32]);
    let private_key_1: PrivateKey = rng.gen();
    let private_key_2: PrivateKey = rng.gen();
    let pk1 = private_to_public_key(&private_key_1);
    let pk2 = private_to_public_key(&private_key_2);
    assert_ne!(pk1, pk2);
    let pk3 = pk1.clone() + pk2.clone();
    assert_ne!(pk3, pk1);
    assert_ne!(pk3, pk2);
}

#[test]
fn test_bram_2_of_2_signature() {
    let mut rng = ChaCha8Rng::from_seed([0; 32]);
    let private_key_1: PrivateKey = rng.gen();
    let private_key_2: PrivateKey = rng.gen();
    let combined_pk = private_key_1.clone() + private_key_2.clone();
    let message = b"hi there";
    let signature_combined = combined_pk.sign(&message);
    let pubkey_1 = private_to_public_key(&private_key_1);
    let pubkey_2 = private_to_public_key(&private_key_2);
    let combined_pubkey = pubkey_1.clone() + pubkey_2.clone();
    let partial_sign_1 = unsafe_sign_partial(&private_key_1, &combined_pubkey, &message);
    let partial_sign_2 = unsafe_sign_partial(&private_key_2, &combined_pubkey, &message);
    let total_sign_from_parts = partial_sign_1 + partial_sign_2;
    assert_eq!(signature_combined, total_sign_from_parts);
}

#[test]
fn test_partial_signer() {
    let private_key = PrivateKey::from_bytes(&KEY_PAIR_PRIVATE.clone()).expect("should work");
    let public_key = PublicKey::from_bytes(KEY_PAIR_PUBLIC.clone()).expect("should work");
    let want_signature =
        Aggsig::from_bytes(KEY_PAIR_PARTIAL_SIGNER_TEST_RESULT.clone()).expect("should work");

    let result_sig = partial_signer(&private_key, &public_key, b"hello test");

    assert_eq!(want_signature, result_sig);
}

#[test]
fn test_standard_puzzle_form() {
    let mut allocator = AllocEncoder::new();
    let std_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should work");
    assert_eq!(
        std_puzzle.sha256tree(&mut allocator),
        PuzzleHash::from_bytes(STANDARD_PUZZLE_HASH.clone())
    );
}

#[test]
fn test_calculate_synthetic_public_key() {
    let public_key = PublicKey::from_bytes(KEY_PAIR_PUBLIC.clone()).expect("should work");
    let synthetic_public_key =
        PublicKey::from_bytes(KEY_PAIR_SYNTHETIC_PUBLIC_KEY.clone()).expect("should work");
    let hidden_puzzle_hash = PuzzleHash::from_bytes(DEFAULT_HIDDEN_PUZZLE_HASH.clone());
    assert_eq!(
        calculate_synthetic_public_key(&public_key, &hidden_puzzle_hash).expect("should work"),
        synthetic_public_key
    );
}

#[test]
fn test_curry_and_treehash() {
    let mut allocator = AllocEncoder::new();

    let from_hasher = Sha256Input::Array(vec![
        Sha256Input::Bytes(&TWO),
        Sha256Input::Hashed(vec![Sha256Input::Bytes(&ONE), Sha256Input::Bytes(&ONE)]),
        Sha256Input::Hashed(vec![
            Sha256Input::Bytes(&TWO),
            Sha256Input::Hashed(vec![Sha256Input::Bytes(&ONE), Sha256Input::Bytes(&TWO)]),
            Sha256Input::Hashed(vec![
                Sha256Input::Bytes(&TWO),
                Sha256Input::Hashed(vec![Sha256Input::Bytes(&ONE), Sha256Input::Bytes(&[3])]),
                Sha256Input::Hashed(vec![Sha256Input::Bytes(&ONE)]),
            ]),
        ]),
    ])
    .hash();

    let program = (1, (2, (3, ())))
        .to_clvm(&mut allocator)
        .expect("should work");
    let program_hash = Node(program).sha256tree(&mut allocator);

    assert_eq!(PuzzleHash::from_hash(from_hasher), program_hash);

    let curried_program = CurriedProgram {
        program: Node(program),
        args: clvm_curried_args!("test1", "test2"),
    }
    .to_clvm(&mut allocator)
    .expect("should work");
    let curried_program_hash = Node(curried_program).sha256tree(&mut allocator);

    let quoted_program = program
        .to_quoted_program(&mut allocator)
        .expect("should quote");
    let quoted_program_hash = quoted_program.sha256tree(&mut allocator);
    let quoted_mod_hash = calculate_hash_of_quoted_mod_hash(&program_hash);
    assert_eq!(PuzzleHash::from_hash(quoted_mod_hash), quoted_program_hash);

    let arg1 = "test1".to_clvm(&mut allocator).expect("should cvt");
    let arg1_hash = Node(arg1).sha256tree(&mut allocator);
    let arg2 = "test2".to_clvm(&mut allocator).expect("should cvt");
    let arg2_hash = Node(arg2).sha256tree(&mut allocator);

    let pre_hashed = curry_and_treehash(&quoted_program_hash, &[arg1_hash, arg2_hash]);
    assert_eq!(curried_program_hash, pre_hashed);
}

#[test]
// From: https://github.com/richardkiss/chialisp_stdlib/blob/bram-api/tests/test_signing.py
// Thanks for giving this concise explanation.
fn test_standard_puzzle_solution_maker() {
    // (defun standard_puzzle_solution_maker (conditions private_key)
    // make a standard puzzle (which we've already tested)
    // come up with a bogus list of conditions
    // call this
    // run the puzzle with the results of this
    // compare to conditions

    let mut allocator = AllocEncoder::new();
    let private_key = PrivateKey::from_bytes(&KEY_PAIR_PRIVATE.clone()).expect("should work");
    let public_key = PublicKey::from_bytes(KEY_PAIR_PUBLIC.clone()).expect("should work");
    let synthetic_public_key = calculate_synthetic_public_key(
        &public_key,
        &PuzzleHash::from_bytes(DEFAULT_HIDDEN_PUZZLE_HASH.clone()),
    )
    .expect("should compute");
    let puzzle = puzzle_for_pk(&mut allocator, &public_key).expect("should work");
    let puzzle_hash = puzzle_hash_for_pk(&mut allocator, &public_key).expect("should work");
    let conditions = ((51, (puzzle_hash.clone(), (99, ()))), ())
        .to_clvm(&mut allocator)
        .expect("should work");
    let quoted_conditions = conditions
        .to_quoted_program(&mut allocator)
        .expect("should quote");
    let quoted_conditions_hash = quoted_conditions.sha256tree(&mut allocator);
    let expected_added_condition = (
        50,
        (synthetic_public_key, (quoted_conditions_hash.clone(), ())),
    );
    let spend_info =
        standard_solution_unsafe(
            &mut allocator,
            &mut &private_key,
            conditions
        ).expect("should work");
    let expected_full_conditions = (expected_added_condition, Node(spend_info.conditions))
        .to_clvm(&mut allocator)
        .expect("should work");
    eprintln!(
        "solution {}",
        disassemble(allocator.allocator(), spend_info.solution, None)
    );
    let runner = DefaultProgramRunner::new();
    let puzzle_node = puzzle.to_clvm(&mut allocator).expect("should convert");
    let res = runner
        .run_program(allocator.allocator(), puzzle_node, spend_info.solution, None)
        .expect("should run");
    assert_eq!(
        disassemble(allocator.allocator(), res.1, None),
        disassemble(allocator.allocator(), expected_full_conditions, None)
    );
    assert!(spend_info.signature.verify(&public_key, &quoted_conditions_hash.bytes()));
}

#[test]
fn test_agg_sig_unsafe_signature() {
    let test_public_key = PublicKey::from_bytes([
        0xae, 0xd0, 0xb4, 0xff, 0x77, 0x3d, 0x0e, 0x1b, 0xa7, 0x32, 0x8b, 0x35, 0xb2, 0x2a, 0x34, 0x8f, 0x8e, 0x38, 0x18, 0xdd, 0x66, 0xd6, 0x0a, 0xe4, 0xb5, 0x48, 0x11, 0xb9, 0x55, 0x77, 0x9a, 0xdb, 0x56, 0xf1, 0xa9, 0xcd, 0xa7, 0xc8, 0x0d, 0xb5, 0x7f, 0x9c, 0x41, 0x4e, 0x72, 0x67, 0x6e, 0xd0
    ]).expect("should work");
    let test_message = Hash::from_slice(&[
        0x3b, 0xb2, 0xd5, 0x23, 0x74, 0xa6, 0x7d, 0xe3, 0xb7, 0x06, 0xf2, 0x9a, 0xfa, 0xbf, 0xe0, 0xda, 0xfe, 0x8e, 0xb1, 0x6e, 0xad, 0x6f, 0x72, 0x04, 0xc8, 0x7d, 0x56, 0x30, 0xb3, 0xb1, 0xac, 0x9b,
    ]);
    let signature = Aggsig::from_bytes([
        0x8c, 0x22, 0x3e, 0x64, 0x6e, 0x00, 0x09, 0xc5, 0x19, 0x3a, 0x4d, 0x7b, 0x11, 0xf1, 0x5b, 0xdc, 0x50, 0x34, 0xae, 0xc1, 0x1a, 0x86, 0x6a, 0x06, 0xb2, 0x9c, 0x13, 0x68, 0xaf, 0x79, 0x6a, 0xf3, 0x74, 0x2f, 0x2a, 0x28, 0x11, 0x2d, 0x92, 0x03, 0x6d, 0x38, 0x18, 0xd0, 0xb8, 0xa8, 0x17, 0x8b, 0x16, 0xd3, 0xc1, 0x26, 0xca, 0x2a, 0x01, 0xe7, 0x1f, 0x6f, 0xa0, 0x25, 0x47, 0x75, 0x2c, 0x05, 0x4e, 0x5b, 0x5e, 0xd4, 0xc3, 0x6b, 0xce, 0x31, 0x4b, 0xe8, 0xfe, 0x48, 0xe7, 0x9d, 0x79, 0x3d, 0xed, 0xba, 0x2a, 0x61, 0xef, 0x7a, 0x7a, 0x2f, 0xf4, 0x2d, 0x4c, 0x76, 0xca, 0x42, 0x1d, 0xd3
    ]).expect("should work");
    let private_key_1 = PrivateKey::from_bytes(&[
        0x1e, 0xa9, 0x15, 0x71, 0x5d, 0x50, 0xe3, 0x03, 0xd6, 0x41, 0xa6, 0xa3, 0x20, 0x3d, 0x06, 0x5a, 0x4d, 0xa2, 0xd7, 0x78, 0x50, 0x5e, 0x32, 0x0c, 0xc7, 0x2d, 0xc3, 0x95, 0x30, 0x42, 0x3e, 0xc4,
    ]).expect("should work");
    let private_key_2 = PrivateKey::from_bytes(&[
        0x20, 0xab, 0xec, 0x3c, 0xee, 0x6c, 0x5f, 0x8f, 0x82, 0xa0, 0xd8, 0x62, 0x92, 0x2b, 0x9f, 0xc6, 0xfc, 0xf4, 0x86, 0x1c, 0x07, 0xa9, 0x3a, 0xb6, 0x03, 0x6b, 0x36, 0xd6, 0x22, 0x82, 0x4c, 0xb2,
    ]).expect("should work");

    let try_sig_1 = unsafe_sign_partial(&private_key_1, &test_public_key, test_message.bytes());
    let try_sig_2 = unsafe_sign_partial(&private_key_2, &test_public_key, test_message.bytes());
    let computed_sig = try_sig_1 + try_sig_2;
    assert!(computed_sig.verify(&test_public_key, test_message.bytes()));
    assert_eq!(computed_sig, signature);
}
