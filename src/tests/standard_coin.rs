use clvm_traits::ToClvm;

use rand_chacha::ChaCha8Rng;
use rand::{Rng, SeedableRng};

use clvm_tools_rs::classic::clvm_tools::stages::stage_0::{DefaultProgramRunner, TRunProgram};
use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;

use crate::common::constants::DEFAULT_HIDDEN_PUZZLE_HASH;
use crate::common::standard_coin::{puzzle_for_pk, hex_to_sexp, private_to_public_key, unsafe_sign_partial, get_standard_coin_puzzle, partial_signer, puzzle_hash_for_pk, calculate_synthetic_public_key, standard_solution};
use crate::common::types::{PublicKey, Sha256tree, PrivateKey, AllocEncoder, Aggsig, PuzzleHash, Node, ToQuotedProgram};
use crate::tests::constants::{EXPECTED_PUZZLE_HEX, TEST_PUBLIC_KEY_BYTES, KEY_PAIR_PUBLIC, KEY_PAIR_PRIVATE, KEY_PAIR_PARTIAL_SIGNER_TEST_RESULT, STANDARD_PUZZLE_HASH, KEY_PAIR_SYNTHETIC_PUBLIC_KEY};

#[test]
fn test_standard_puzzle() {
    let mut allocator = AllocEncoder::new();
    let test_key = PublicKey::from_bytes(TEST_PUBLIC_KEY_BYTES.clone()).expect("should be a public key");
    let puzzle = puzzle_for_pk(&mut allocator, &test_key).expect("should work");
    let puzzle_hash = puzzle.sha256tree(&mut allocator);
    let expected_puzzle = hex_to_sexp(&mut allocator, EXPECTED_PUZZLE_HEX.clone()).expect("should convert");
    let expected_hash = Node(expected_puzzle).sha256tree(&mut allocator);
    assert_eq!(expected_hash, puzzle_hash);
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
    let want_signature = Aggsig::from_bytes(KEY_PAIR_PARTIAL_SIGNER_TEST_RESULT.clone()).expect("should work");

    let result_sig = partial_signer(&private_key, &public_key, b"hello test");

    assert_eq!(want_signature, result_sig);
}

#[test]
fn test_standard_puzzle_form() {
    let mut allocator = AllocEncoder::new();
    let std_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should work");
    assert_eq!(std_puzzle.sha256tree(&mut allocator), PuzzleHash::from_bytes(STANDARD_PUZZLE_HASH.clone()));
}

#[test]
fn test_calculate_synthetic_public_key() {
    let public_key = PublicKey::from_bytes(KEY_PAIR_PUBLIC.clone()).expect("should work");
    let synthetic_public_key = PublicKey::from_bytes(KEY_PAIR_SYNTHETIC_PUBLIC_KEY.clone()).expect("should work");
    let hidden_puzzle_hash = DEFAULT_HIDDEN_PUZZLE_HASH.clone();
    assert_eq!(
        calculate_synthetic_public_key(&public_key, &hidden_puzzle_hash).expect("should work"),
        synthetic_public_key
    );
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
    let synthetic_public_key = calculate_synthetic_public_key(&public_key, &DEFAULT_HIDDEN_PUZZLE_HASH).expect("should compute");
    let puzzle = puzzle_for_pk(&mut allocator, &public_key).expect("should work");
    let puzzle_hash = puzzle_hash_for_pk(&mut allocator, &public_key).expect("should work");
    let conditions = ((51, (puzzle_hash.clone(), (99, ()))), ()).to_clvm(&mut allocator).expect("should work");
    let quoted_conditions = conditions.to_quoted_program(&mut allocator).expect("should quote");
    let quoted_conditions_hash = quoted_conditions.sha256tree(&mut allocator);
    let expected_added_condition = (50, (synthetic_public_key, (quoted_conditions_hash.clone(), ())));
    let (solution, signature) = standard_solution(&mut allocator, &mut &private_key, conditions).expect("should work");
    let expected_full_conditions = (expected_added_condition, Node(conditions)).to_clvm(&mut allocator).expect("should work");
    eprintln!("solution {}", disassemble(allocator.allocator(), solution, None));
    let runner = DefaultProgramRunner::new();
    let puzzle_node = puzzle.to_clvm(&mut allocator).expect("should convert");
    let res = runner.run_program(
        allocator.allocator(),
        puzzle_node,
        solution,
        None
    ).expect("should run");
    assert_eq!(
        disassemble(allocator.allocator(), res.1, None),
        disassemble(allocator.allocator(), expected_full_conditions, None)
    );
    assert!(signature.verify(&public_key, &quoted_conditions_hash.bytes()));
}
