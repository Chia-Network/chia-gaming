use lazy_static::lazy_static;

use clvmr::Allocator;

use crate::common::standard_coin::{puzzle_for_pk, hex_to_sexp};
use crate::common::types::{PublicKey, Sha256tree};

lazy_static! {
    pub static ref TEST_PUBLIC_KEY_BYTES: Vec<u8> = vec![
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

    pub static ref EXPECTED_PUZZLE_HEX: String = "ff02ffff01ff02ffff01ff02ffff03ff0bffff01ff02ffff03ffff09ff05ffff1dff0bffff1effff0bff0bffff02ff06ffff04ff02ffff04ff17ff8080808080808080ffff01ff02ff17ff2f80ffff01ff088080ff0180ffff01ff04ffff04ff04ffff04ff05ffff04ffff02ff06ffff04ff02ffff04ff17ff80808080ff80808080ffff02ff17ff2f808080ff0180ffff04ffff01ff32ff02ffff03ffff07ff0580ffff01ff0bffff0102ffff02ff06ffff04ff02ffff04ff09ff80808080ffff02ff06ffff04ff02ffff04ff0dff8080808080ffff01ff0bffff0101ff058080ff0180ff018080ffff04ffff01b0885aeb185acfe6fc9a526880a16b23361b2c70866fb0630b7afa10c65bcfff6dac781d0b4a566dcf52073527d2ae796bff018080".to_string();
}

#[test]
fn test_standard_puzzle() {
    let mut allocator = Allocator::new();
    let test_key = PublicKey::from_bytes(&TEST_PUBLIC_KEY_BYTES);
    let puzzle = puzzle_for_pk(&mut allocator, &test_key).expect("should work");
    let puzzle_hash = puzzle.sha256tree(&mut allocator);
    let expected_puzzle = hex_to_sexp(&mut allocator, EXPECTED_PUZZLE_HEX.clone()).expect("should convert");
    let expected_hash = expected_puzzle.sha256tree(&mut allocator);
    assert_eq!(expected_hash, puzzle_hash);
}
