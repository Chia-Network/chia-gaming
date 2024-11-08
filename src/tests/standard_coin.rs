use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;
use clvm_tools_rs::classic::clvm_tools::stages::stage_0::{DefaultProgramRunner, TRunProgram};

use log::debug;

use crate::common::constants::{DEFAULT_HIDDEN_PUZZLE_HASH, ONE, TWO};
use crate::common::standard_coin::{
    calculate_hash_of_quoted_mod_hash, calculate_synthetic_public_key, curry_and_treehash,
    get_standard_coin_puzzle, hex_to_sexp, partial_signer, private_to_public_key, puzzle_for_pk,
    puzzle_hash_for_pk, standard_solution_unsafe, unsafe_sign_partial,
};
use crate::common::types::{
    Aggsig, AllocEncoder, Node, PrivateKey, PublicKey, PuzzleHash, Sha256Input, Sha256tree,
    ToQuotedProgram,
};
use crate::tests::constants::{
    EXPECTED_PUZZLE_HEX, KEY_PAIR_PARTIAL_SIGNER_TEST_RESULT, KEY_PAIR_PRIVATE, KEY_PAIR_PUBLIC,
    KEY_PAIR_SYNTHETIC_PUBLIC_KEY, STANDARD_PUZZLE_HASH, TEST_PUBLIC_KEY_BYTES,
};

#[test]
fn test_standard_puzzle() {
    let mut allocator = AllocEncoder::new();
    let test_key =
        PublicKey::from_bytes(*TEST_PUBLIC_KEY_BYTES).expect("should be a public key");
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
    let signature_combined = combined_pk.sign(message);
    let pubkey_1 = private_to_public_key(&private_key_1);
    let pubkey_2 = private_to_public_key(&private_key_2);
    let combined_pubkey = pubkey_1.clone() + pubkey_2.clone();
    let partial_sign_1 = unsafe_sign_partial(&private_key_1, &combined_pubkey, message);
    let partial_sign_2 = unsafe_sign_partial(&private_key_2, &combined_pubkey, message);
    let total_sign_from_parts = partial_sign_1 + partial_sign_2;
    assert_eq!(signature_combined, total_sign_from_parts);
}

#[test]
fn test_partial_signer() {
    let private_key = PrivateKey::from_bytes(&KEY_PAIR_PRIVATE.clone()).expect("should work");
    let public_key = PublicKey::from_bytes(*KEY_PAIR_PUBLIC).expect("should work");
    let want_signature =
        Aggsig::from_bytes(*KEY_PAIR_PARTIAL_SIGNER_TEST_RESULT).expect("should work");

    let result_sig = partial_signer(&private_key, &public_key, b"hello test");

    assert_eq!(want_signature, result_sig);
}

#[test]
fn test_standard_puzzle_form() {
    let mut allocator = AllocEncoder::new();
    let std_puzzle = get_standard_coin_puzzle(&mut allocator).expect("should work");
    assert_eq!(
        std_puzzle.sha256tree(&mut allocator),
        PuzzleHash::from_bytes(*STANDARD_PUZZLE_HASH)
    );
}

#[test]
fn test_calculate_synthetic_public_key() {
    let public_key = PublicKey::from_bytes(*KEY_PAIR_PUBLIC).expect("should work");
    let synthetic_public_key =
        PublicKey::from_bytes(*KEY_PAIR_SYNTHETIC_PUBLIC_KEY).expect("should work");
    let hidden_puzzle_hash = PuzzleHash::from_bytes(DEFAULT_HIDDEN_PUZZLE_HASH);
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
    let public_key = PublicKey::from_bytes(*KEY_PAIR_PUBLIC).expect("should work");
    let synthetic_public_key = calculate_synthetic_public_key(
        &public_key,
        &PuzzleHash::from_bytes(DEFAULT_HIDDEN_PUZZLE_HASH),
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
    let spend_info = standard_solution_unsafe(&mut allocator, &private_key, conditions)
        .expect("should work");
    let expected_full_conditions = (expected_added_condition, Node(spend_info.conditions))
        .to_clvm(&mut allocator)
        .expect("should work");
    debug!(
        "solution {}",
        disassemble(allocator.allocator(), spend_info.solution, None)
    );
    let runner = DefaultProgramRunner::new();
    let puzzle_node = puzzle.to_clvm(&mut allocator).expect("should convert");
    let res = runner
        .run_program(
            allocator.allocator(),
            puzzle_node,
            spend_info.solution,
            None,
        )
        .expect("should run");
    assert_eq!(
        disassemble(allocator.allocator(), res.1, None),
        disassemble(allocator.allocator(), expected_full_conditions, None)
    );
    assert!(spend_info
        .signature
        .verify(&public_key, quoted_conditions_hash.bytes()));
}
