use std::ops::{Add, AddAssign};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use clvmr::allocator::NodePtr;

use chia_bls;
use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};

use crate::common::types::error::Error;
use crate::common::types::IntoErr;
use crate::common::types::SerdeByteConsumer;

/// Public key
#[derive(Clone, Eq, PartialEq, Debug, Default)]
pub struct PublicKey(chia_bls::PublicKey);

impl Serialize for PublicKey {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let bytes = self.bytes();
        serializer.serialize_bytes(&bytes)
    }
}

impl<'de> Deserialize<'de> for PublicKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let b = SerdeByteConsumer;
        let bytes = deserializer.deserialize_bytes(b);
        let mut fixed_bytes: [u8; 48] = [0; 48];
        for v in bytes.into_iter().take(1) {
            for (i, b) in v.into_iter().enumerate() {
                fixed_bytes[i] = b;
            }
        }
        PublicKey::from_bytes(fixed_bytes)
            .map_err(|e| serde::de::Error::custom(format!("couldn't make pubkey: {e:?}")))
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
