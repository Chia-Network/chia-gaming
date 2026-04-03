use std::ops::{Add, AddAssign};

use serde::de::{self, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use clvmr::allocator::NodePtr;

use chia_bls;
use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};

use crate::common::types::error::Error;
use crate::common::types::IntoErr;

/// Public key
#[derive(Clone, Eq, PartialEq, Debug, Default)]
pub struct PublicKey(chia_bls::PublicKey);

impl Serialize for PublicKey {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bytes(&self.bytes())
    }
}

struct PublicKeyVisitor;

impl<'de> Visitor<'de> for PublicKeyVisitor {
    type Value = PublicKey;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a 48-byte public key as raw bytes")
    }

    fn visit_bytes<E>(self, v: &[u8]) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        PublicKey::from_slice(v).map_err(|e| E::custom(format!("{e:?}")))
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
        let mut bytes = Vec::with_capacity(48);
        while let Some(b) = seq.next_element::<u8>()? {
            bytes.push(b);
        }
        PublicKey::from_slice(&bytes).map_err(|e| de::Error::custom(format!("{e:?}")))
    }
}

impl<'de> Deserialize<'de> for PublicKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_bytes(PublicKeyVisitor)
    }
}

impl PublicKey {
    pub fn to_bls(&self) -> chia_bls::PublicKey {
        self.0
    }

    pub fn bytes(&self) -> [u8; 48] {
        self.0.to_bytes()
    }

    pub fn from_bytes(bytes: [u8; 48]) -> Result<PublicKey, Error> {
        Ok(PublicKey(
            chia_bls::PublicKey::from_bytes(&bytes).into_gen()?,
        ))
    }

    pub fn from_slice(slice: &[u8]) -> Result<PublicKey, Error> {
        if slice.len() != 48 {
            return Err(Error::StrErr("bad public key length".to_string()));
        }
        let mut bytes: [u8; 48] = [0; 48];
        bytes.copy_from_slice(slice);
        PublicKey::from_bytes(bytes)
    }

    pub fn from_bls(pk: chia_bls::PublicKey) -> PublicKey {
        PublicKey(pk)
    }
}

impl AddAssign for PublicKey {
    fn add_assign(&mut self, rhs: Self) {
        self.0 += &rhs.0;
    }
}

impl Add for PublicKey {
    type Output = PublicKey;

    fn add(mut self, rhs: Self) -> PublicKey {
        self += rhs;
        self
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for PublicKey {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        encoder.encode_atom(clvm_traits::Atom::Borrowed(&self.0.to_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::PublicKey;
    use crate::common::standard_coin::private_to_public_key;
    use crate::common::types::PrivateKey;

    #[test]
    fn public_key_serializes_to_bson_binary() {
        let sk = PrivateKey::default();
        let pk = private_to_public_key(&sk);
        let bson = bson::to_bson(&pk).expect("public key should serialize");
        match bson {
            bson::Bson::Binary(bin) => assert_eq!(bin.bytes.len(), 48),
            other => panic!("expected bson binary, got {other:?}"),
        }
    }

    #[test]
    fn public_key_rejects_hex_string_legacy_format() {
        let legacy = bson::Bson::String("deadbeef".to_string());
        let parsed: Result<PublicKey, _> = bson::from_bson(legacy);
        assert!(parsed.is_err());
    }
}
