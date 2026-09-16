use num_bigint::BigInt;
use num_traits::cast::ToPrimitive;

pub fn usize_from_atom(a: &[u8]) -> Option<usize> {
    let bi = BigInt::from_signed_bytes_be(a);
    bi.to_usize()
}

pub fn i64_from_atom(a: &[u8]) -> Option<i64> {
    let bi = BigInt::from_signed_bytes_be(a);
    bi.to_i64()
}

pub fn u64_from_atom(a: &[u8]) -> Option<u64> {
    let bi = BigInt::from_signed_bytes_be(a);
    bi.to_u64()
}

#[cfg(test)]
mod tests {
    use super::{u64_from_atom, usize_from_atom};

    #[test]
    fn unsigned_atom_parsers_follow_clvm_sign_encoding() {
        assert_eq!(u64_from_atom(&[]), Some(0));
        assert_eq!(u64_from_atom(&[0x7f]), Some(127));
        assert_eq!(u64_from_atom(&[0x00, 0xff]), Some(255));
        assert_eq!(u64_from_atom(&[0xff]), None);
        assert_eq!(usize_from_atom(&[0x80]), None);
    }
}
