use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;
use clvmr::{run_program, ChiaDialect};

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use log::debug;

use crate::common::constants::{DEFAULT_HIDDEN_PUZZLE_HASH, ONE, TWO};
use crate::common::load_clvm::hex_to_sexp;
use crate::common::standard_coin::{
    calculate_hash_of_quoted_mod_hash, calculate_synthetic_offset, calculate_synthetic_public_key,
    curry_and_treehash, get_standard_coin_puzzle, partial_signer, private_to_public_key,
    puzzle_for_pk, puzzle_for_synthetic_public_key, puzzle_hash_for_pk,
    puzzle_hash_for_synthetic_public_key, standard_solution_unsafe, unsafe_sign_partial,
};
use crate::common::types::{
    Aggsig, AllocEncoder, Node, PrivateKey, Program, PublicKey, PuzzleHash, Sha256Input,
    Sha256tree, ToQuotedProgram,
};
use crate::tests::constants::{
    EXPECTED_PUZZLE_HEX, KEY_PAIR_PARTIAL_SIGNER_TEST_RESULT, KEY_PAIR_PRIVATE, KEY_PAIR_PUBLIC,
    KEY_PAIR_SYNTHETIC_PUBLIC_KEY, STANDARD_PUZZLE_HASH, TEST_PUBLIC_KEY_BYTES,
};
use crate::utils::number_from_u8;

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

#[test]
fn test_standard_puzzle() {
    let mut allocator = AllocEncoder::new();
    let test_key = PublicKey::from_bytes(*TEST_PUBLIC_KEY_BYTES).expect("should be a public key");
    let puzzle = puzzle_for_pk(&mut allocator, &test_key).expect("should work");
    let puzzle_hash = puzzle.sha256tree(&mut allocator);
    let expected_puzzle =
        hex_to_sexp(&mut allocator, &EXPECTED_PUZZLE_HEX).expect("should convert");
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
fn test_calculate_synthetic_public_key_interface() {
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
    let spend_info =
        standard_solution_unsafe(&mut allocator, &private_key, conditions).expect("should work");
    let conditions_borrowed: &Program = spend_info.conditions.pref();
    let expected_full_conditions = (expected_added_condition, conditions_borrowed)
        .to_clvm(&mut allocator)
        .expect("should work");
    debug!("solution {:?}", spend_info.solution);
    let puzzle_node = puzzle.to_clvm(&mut allocator).expect("should convert");
    let solution_node = spend_info
        .solution
        .to_clvm(&mut allocator)
        .expect("should convert");
    let res = run_program(
        allocator.allocator(),
        &ChiaDialect::new(0),
        puzzle_node,
        solution_node,
        0,
    )
    .expect("should run");
    let res_1_hex = Node(res.1).to_hex(&mut allocator).unwrap();
    let expected_full_hex = Node(expected_full_conditions)
        .to_hex(&mut allocator)
        .unwrap();
    assert_eq!(res_1_hex, expected_full_hex);
    assert!(spend_info
        .signature
        .verify(&public_key, quoted_conditions_hash.bytes()));
}
