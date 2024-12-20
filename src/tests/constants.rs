use crate::common::types::PublicKey;
use lazy_static::lazy_static;

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

    pub static ref PK1: [u8; 48] = [
        0x97,
        0xf1,
        0xd3,
        0xa7,
        0x31,
        0x97,
        0xd7,
        0x94,
        0x26,
        0x95,
        0x63,
        0x8c,
        0x4f,
        0xa9,
        0xac,
        0x0f,
        0xc3,
        0x68,
        0x8c,
        0x4f,
        0x97,
        0x74,
        0xb9,
        0x05,
        0xa1,
        0x4e,
        0x3a,
        0x3f,
        0x17,
        0x1b,
        0xac,
        0x58,
        0x6c,
        0x55,
        0xe8,
        0x3f,
        0xf9,
        0x7a,
        0x1a,
        0xef,
        0xfb,
        0x3a,
        0xf0,
        0x0a,
        0xdb,
        0x22,
        0xc6,
        0xbb
    ];

    pub static ref PK2: [u8; 48] = [
        0xa5,
        0x72,
        0xcb,
        0xea,
        0x90,
        0x4d,
        0x67,
        0x46,
        0x88,
        0x08,
        0xc8,
        0xeb,
        0x50,
        0xa9,
        0x45,
        0x0c,
        0x97,
        0x21,
        0xdb,
        0x30,
        0x91,
        0x28,
        0x01,
        0x25,
        0x43,
        0x90,
        0x2d,
        0x0a,
        0xc3,
        0x58,
        0xa6,
        0x2a,
        0xe2,
        0x8f,
        0x75,
        0xbb,
        0x8f,
        0x1c,
        0x7c,
        0x42,
        0xc3,
        0x9a,
        0x8c,
        0x55,
        0x29,
        0xbf,
        0x0f,
        0x4e
    ];

    pub static ref STANDARD_PUZZLE_HASH: [u8; 32] = [
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
        0x52
    ];

    pub static ref THEIR_STATE_PUBKEY: PublicKey = {
        PublicKey::from_bytes([
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
            0xcd,
        ]).expect("should be a real pubkey")
    };

    pub static ref THEIR_UNROLL_PUBKEY: PublicKey = {
        PublicKey::from_bytes([
            0x99,
            0xf7,
            0xa7,
            0x96,
            0xf1,
            0x4c,
            0x63,
            0x98,
            0xc4,
            0x14,
            0x94,
            0x3a,
            0x2d,
            0x0c,
            0xbc,
            0x39,
            0xcf,
            0x47,
            0x2c,
            0x15,
            0xec,
            0x32,
            0x84,
            0x01,
            0x0e,
            0x57,
            0xaa,
            0x62,
            0x73,
            0x59,
            0x78,
            0xe9,
            0x84,
            0x3d,
            0x09,
            0x98,
            0xf5,
            0x41,
            0xa1,
            0xa9,
            0x29,
            0x95,
            0xa0,
            0x55,
            0x2d,
            0x9b,
            0x1c,
            0x42,
        ]).expect("should be a public key")
    };

    pub static ref KEY_PAIR_PRIVATE: [u8; 32] = [
        0x36,
        0xb4,
        0x90,
        0x05,
        0x73,
        0x44,
        0xc9,
        0x87,
        0x1d,
        0xf1,
        0xaa,
        0xda,
        0x4d,
        0xc8,
        0x46,
        0xb8,
        0xf0,
        0x18,
        0x02,
        0x10,
        0x0a,
        0xde,
        0xf5,
        0xba,
        0x09,
        0x84,
        0x6d,
        0x07,
        0xd2,
        0x28,
        0x73,
        0x90
    ];

    pub static ref KEY_PAIR_PUBLIC: [u8; 48] = [
        0xa3,
        0xbb,
        0xce,
        0xd3,
        0x3d,
        0x27,
        0x32,
        0x9d,
        0xa1,
        0xe3,
        0x60,
        0xff,
        0x4b,
        0x0f,
        0x00,
        0xdb,
        0x17,
        0x47,
        0xee,
        0xe8,
        0xe6,
        0x6c,
        0x0c,
        0x0a,
        0xe4,
        0x50,
        0xf9,
        0x0b,
        0x76,
        0x0f,
        0x42,
        0x97,
        0x22,
        0x16,
        0xc2,
        0xff,
        0x02,
        0x76,
        0x36,
        0xae,
        0xeb,
        0x52,
        0x68,
        0xbc,
        0x2b,
        0xe2,
        0xce,
        0xdb
    ];

    pub static ref KEY_PAIR_PARTIAL_SIGNER_TEST_RESULT: [u8; 96] = [
        0xa7,
        0xa2,
        0xb6,
        0xdf,
        0xeb,
        0x26,
        0xbc,
        0xe9,
        0x16,
        0x35,
        0x96,
        0x93,
        0x0b,
        0xf0,
        0xc8,
        0x2e,
        0xf4,
        0xcc,
        0xb3,
        0x65,
        0xb5,
        0x38,
        0x29,
        0x56,
        0x7d,
        0xc1,
        0x95,
        0x74,
        0x3d,
        0x3b,
        0x51,
        0x5c,
        0x63,
        0x5f,
        0xb5,
        0x34,
        0xcb,
        0xfd,
        0xbb,
        0x08,
        0x90,
        0xf3,
        0x66,
        0x57,
        0xb2,
        0x2b,
        0xad,
        0x3f,
        0x06,
        0xe7,
        0x4a,
        0x4f,
        0xcc,
        0xe0,
        0xd8,
        0x13,
        0xf1,
        0x8a,
        0x9b,
        0x38,
        0xcb,
        0x7c,
        0xaa,
        0x6a,
        0x69,
        0x8a,
        0xf3,
        0x63,
        0xa1,
        0x04,
        0x5d,
        0x25,
        0x47,
        0xc3,
        0x82,
        0x42,
        0x4f,
        0x23,
        0xb3,
        0xdc,
        0x0f,
        0x64,
        0xf7,
        0x1d,
        0x7e,
        0x62,
        0xcb,
        0x25,
        0x03,
        0x28,
        0x21,
        0x96,
        0x08,
        0x0d,
        0xc9,
        0x11
    ];

    pub static ref KEY_PAIR_SYNTHETIC_PUBLIC_KEY: [u8; 48] = [
        0x93,
        0xbd,
        0x85,
        0x12,
        0x8d,
        0x0e,
        0x9f,
        0xbc,
        0xfc,
        0xa5,
        0x47,
        0xb9,
        0x64,
        0xbd,
        0x31,
        0x80,
        0x77,
        0x7c,
        0x6f,
        0xe9,
        0xfa,
        0xd8,
        0x08,
        0xdd,
        0xa4,
        0x15,
        0xbb,
        0x32,
        0x88,
        0x70,
        0x22,
        0x86,
        0x47,
        0x74,
        0xb5,
        0xff,
        0x04,
        0x45,
        0x2b,
        0x88,
        0xbc,
        0x98,
        0x29,
        0x40,
        0x8f,
        0xb7,
        0xf8,
        0x87
    ];
}
