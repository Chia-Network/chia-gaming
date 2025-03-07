use num_bigint::{BigInt, Sign};
use num_traits::cast::ToPrimitive;

pub fn usize_from_atom(a: &[u8]) -> Option<usize> {
    let bi = BigInt::from_bytes_be(Sign::Plus, a);
    bi.to_usize()
}

pub fn _i32_from_atom(a: &[u8]) -> Option<i32> {
    let bi = BigInt::from_signed_bytes_be(a);
    bi.to_i32()
}

pub fn i64_from_atom(a: &[u8]) -> Option<i64> {
    let bi = BigInt::from_signed_bytes_be(a);
    bi.to_i64()
}

pub fn u64_from_atom(a: &[u8]) -> Option<u64> {
    let bi = BigInt::from_bytes_be(Sign::Plus, a);
    bi.to_u64()
}
