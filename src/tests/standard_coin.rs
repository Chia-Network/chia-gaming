use lazy_static::lazy_static;

use clvmr::Allocator;
use rand_chacha::ChaCha8Rng;
use rand::{Rng, SeedableRng};

use crate::common::standard_coin::{puzzle_for_pk, hex_to_sexp, private_to_public_key, unsafe_sign, aggregate_signatures, unsafe_sign_partial};
use crate::common::types::{PublicKey, Sha256tree, PrivateKey};

lazy_static! {
    pub static ref TEST_PUBLIC_KEY_BYTES: [u8; 48] = [
        0x86,
        0xde,
        0x1d,
        0xad,
        0x40,
        0x4c,
        0x02,
        0x40,
        0x85,
        0xfb,
        0xff,
        0x64,
        0xa8,
        0x72,
        0xf0,
        0x68,
        0x4f,
        0x1b,
        0xf2,
        0x4e,
        0x16,
        0xa9,
        0xcc,
        0xa2,
        0xe6,
        0x33,
        0x25,
        0x1f,
        0x47,
        0xd7,
        0x01,
        0x71,
        0x7e,
        0xe1,
        0x03,
        0xaa,
        0x93,
        0x1c,
        0x22,
        0xec,
        0x31,
        0x4d,
        0x06,
        0x78,
        0x23,
        0x31,
        0x1b,
        0xf7
    ];

    pub static ref TEST_PUBLIC_KEY2_BYTES: [u8; 48] = [
        0xb6,
        0x4e,
        0x83,
        0xdc,
        0x97,
        0x32,
        0x20,
        0x53,
        0x77,
        0xf2,
        0x26,
        0x47,
        0xdc,
        0x38,
        0xc1,
        0xd1,
        0x97,
        0xa6,
        0x72,
        0x88,
        0x26,
        0x82,
        0x6f,
        0x69,
        0xaf,
        0x35,
        0x28,
        0x36,
        0x2b,
        0xc7,
        0xb8,
        0x3a,
        0x17,
        0x90,
        0x83,
        0xe9,
        0x82,
        0x44,
        0x8c,
        0x21,
        0x93,
        0x40,
        0xc8,
        0xdd,
        0x6b,
        0xdb,
        0x79,
        0xcd
    ];

    pub static ref EXPECTED_PUZZLE_HEX: String = "ff02ffff01ff02ffff01ff02ffff03ff0bffff01ff02ffff03ffff09ff05ffff1dff0bffff1effff0bff0bffff02ff06ffff04ff02ffff04ff17ff8080808080808080ffff01ff02ff17ff2f80ffff01ff088080ff0180ffff01ff04ffff04ff04ffff04ff05ffff04ffff02ff06ffff04ff02ffff04ff17ff80808080ff80808080ffff02ff17ff2f808080ff0180ffff04ffff01ff32ff02ffff03ffff07ff0580ffff01ff0bffff0102ffff02ff06ffff04ff02ffff04ff09ff80808080ffff02ff06ffff04ff02ffff04ff0dff8080808080ffff01ff0bffff0101ff058080ff0180ff018080ffff04ffff01b0885aeb185acfe6fc9a526880a16b23361b2c70866fb0630b7afa10c65bcfff6dac781d0b4a566dcf52073527d2ae796bff018080".to_string();
}

#[test]
fn test_standard_puzzle() {
    let mut allocator = Allocator::new();
    let test_key = PublicKey::from_bytes(TEST_PUBLIC_KEY_BYTES.clone()).expect("should be a public key");
    let puzzle = puzzle_for_pk(&mut allocator, &test_key).expect("should work");
    let puzzle_hash = puzzle.sha256tree(&mut allocator);
    let expected_puzzle = hex_to_sexp(&mut allocator, EXPECTED_PUZZLE_HEX.clone()).expect("should convert");
    let expected_hash = expected_puzzle.sha256tree(&mut allocator);
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
