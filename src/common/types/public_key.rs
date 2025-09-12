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
        hex::encode(&self.bytes()).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for PublicKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let st = String::deserialize(deserializer)?;
        let slice = hex::decode(&st).unwrap();
        Ok(PublicKey::from_slice(&slice).unwrap())
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
        let mut bytes: [u8; 48] = [0; 48];
        for (i, b) in slice.iter().enumerate() {
            bytes[i % 48] = *b;
        }
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
