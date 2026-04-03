use std::ops::{Add, AddAssign};

use serde::de::{self, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use clvmr::allocator::NodePtr;

use chia_bls;
use chia_bls::verify;
use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};

use crate::common::types::{Error, IntoErr, PublicKey};

/// BLS G2 signature stored in compressed 96-byte form.
/// Decompresses on demand for arithmetic and verification.
#[derive(Clone, Eq, PartialEq, Debug)]
pub struct Aggsig(pub [u8; 96]);

impl Default for Aggsig {
    fn default() -> Self {
        Aggsig::from_bls(chia_bls::Signature::default())
    }
}

impl Serialize for Aggsig {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if self.is_twos_complement_zero() {
            serializer.serialize_bytes(&[])
        } else {
            serializer.serialize_bytes(&self.0)
        }
    }
}

struct AggsigVisitor;

impl<'de> Visitor<'de> for AggsigVisitor {
    type Value = Aggsig;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a 96-byte signature as raw bytes (or empty for default)")
    }

    fn visit_bytes<E>(self, v: &[u8]) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        if v.is_empty() {
            Ok(Aggsig::default())
        } else {
            Aggsig::from_slice(v).map_err(|e| E::custom(format!("{e:?}")))
        }
    }

    fn visit_byte_buf<E>(self, v: Vec<u8>) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        self.visit_bytes(&v)
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut bytes = Vec::with_capacity(96);
        while let Some(b) = seq.next_element::<u8>()? {
            bytes.push(b);
        }
        if bytes.is_empty() {
            Ok(Aggsig::default())
        } else {
            Aggsig::from_slice(&bytes).map_err(|e| de::Error::custom(format!("{e:?}")))
        }
    }
}

impl<'de> Deserialize<'de> for Aggsig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_bytes(AggsigVisitor)
    }
}

impl Aggsig {
    pub fn from_bls(bls: chia_bls::Signature) -> Aggsig {
        Aggsig(bls.to_bytes())
    }

    pub fn from_bytes(by: [u8; 96]) -> Result<Aggsig, Error> {
        chia_bls::Signature::from_bytes(&by).into_gen()?;
        Ok(Aggsig(by))
    }

    pub fn from_slice(by: &[u8]) -> Result<Aggsig, Error> {
        if by.len() != 96 {
            return Err(Error::StrErr("bad aggsig length".to_string()));
        }
        let mut fixed: [u8; 96] = [0; 96];
        fixed.copy_from_slice(by);
        Aggsig::from_bytes(fixed)
    }

    pub fn bytes(&self) -> [u8; 96] {
        self.0
    }

    pub fn is_twos_complement_zero(&self) -> bool {
        self.0 == Aggsig::default().0
    }

    pub fn to_bls(&self) -> chia_bls::Signature {
        chia_bls::Signature::from_bytes(&self.0).expect("Aggsig always holds validated bytes")
    }

    pub fn verify(&self, public_key: &PublicKey, msg: &[u8]) -> bool {
        verify(&self.to_bls(), &public_key.to_bls(), msg)
    }

    pub fn aggregate(&self, other: &Aggsig) -> Aggsig {
        let mut result = self.to_bls();
        result.aggregate(&other.to_bls());
        Aggsig::from_bls(result)
    }

    pub fn scalar_multiply(&mut self, int_bytes: &[u8]) {
        let mut sig = self.to_bls();
        sig.scalar_multiply(int_bytes);
        *self = Aggsig::from_bls(sig);
    }
}

impl AddAssign for Aggsig {
    fn add_assign(&mut self, rhs: Self) {
        let mut sig = self.to_bls();
        sig += &rhs.to_bls();
        *self = Aggsig::from_bls(sig);
    }
}

impl Add for Aggsig {
    type Output = Aggsig;

    fn add(mut self, rhs: Self) -> Aggsig {
        self += rhs;
        self
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Aggsig {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        encoder.encode_atom(clvm_traits::Atom::Borrowed(&self.0))
    }
}

#[cfg(test)]
mod tests {
    use super::Aggsig;
    use crate::common::standard_coin::{private_to_public_key, signer};
    use crate::common::types::PrivateKey;

    #[test]
    fn aggsig_nonzero_serializes_to_bson_binary() {
        let sk = PrivateKey::default();
        let (_pk, sig) = signer(&sk, b"aggsig-test");
        let bson = bson::to_bson(&sig).expect("aggsig should serialize");
        match bson {
            bson::Bson::Binary(bin) => assert_eq!(bin.bytes.len(), 96),
            other => panic!("expected bson binary, got {other:?}"),
        }
    }

    #[test]
    fn aggsig_zero_serializes_as_empty_binary() {
        let sig = Aggsig::default();
        let bson = bson::to_bson(&sig).expect("aggsig should serialize");
        match bson {
            bson::Bson::Binary(bin) => assert!(bin.bytes.is_empty()),
            other => panic!("expected bson binary, got {other:?}"),
        }
    }

    #[test]
    fn aggsig_deserializes_empty_binary_to_default() {
        let bson = bson::Bson::Binary(bson::Binary {
            subtype: bson::spec::BinarySubtype::Generic,
            bytes: vec![],
        });
        let sig: Aggsig = bson::from_bson(bson).expect("empty binary should deserialize");
        assert_eq!(sig, Aggsig::default());
    }

    #[test]
    fn aggsig_rejects_hex_string_legacy_format() {
        let legacy = bson::Bson::String("deadbeef".to_string());
        let parsed: Result<Aggsig, _> = bson::from_bson(legacy);
        assert!(parsed.is_err());
    }

    #[test]
    fn public_key_stays_valid_with_sign_verify_after_roundtrip_inputs() {
        let sk = PrivateKey::default();
        let pk = private_to_public_key(&sk);
        let sig = sk.sign(b"pk-roundtrip");
        assert!(sig.verify(&pk, b"pk-roundtrip"));
    }
}
