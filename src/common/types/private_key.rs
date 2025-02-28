use std::ops::{Add, AddAssign};

use serde::de::Visitor;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use rand::distributions::Standard;
use rand::prelude::*;

use clvmr::allocator::NodePtr;

use chia_bls;
use chia_bls::signature::{sign, verify};
use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};

use crate::common::types::all::IntoErr;
use crate::common::types::coin_id::Hash;
use crate::common::types::error::Error;

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

impl Distribution<PrivateKey> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> PrivateKey {
        let hash: Hash = rng.gen();
        PrivateKey(chia_bls::SecretKey::from_seed(hash.bytes()))
    }
}

pub struct SerdeByteConsumer;

impl Visitor<'_> for SerdeByteConsumer {
    type Value = Vec<u8>;
    fn expecting(&self, fmt: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        fmt.write_str("expected bytes")
    }
    fn visit_bytes<E>(self, v: &[u8]) -> Result<Self::Value, E> {
        Ok(v.to_vec())
    }
}

/// Aggsig
#[derive(Clone, Eq, PartialEq, Debug, Default)]
pub struct Aggsig(chia_bls::Signature);

impl Serialize for Aggsig {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let bytes = self.bytes();
        serializer.serialize_bytes(&bytes)
    }
}

impl<'de> Deserialize<'de> for Aggsig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let b = SerdeByteConsumer;
        let bytes = deserializer.deserialize_bytes(b);
        let mut fixed_bytes: [u8; 96] = [0; 96];
        for v in bytes.into_iter().take(1) {
            for (i, b) in v.into_iter().enumerate() {
                fixed_bytes[i] = b;
            }
        }
        Aggsig::from_bytes(fixed_bytes)
            .map_err(|e| serde::de::Error::custom(format!("couldn't make aggsig: {e:?}")))
    }
}

impl Aggsig {
    pub fn from_bls(bls: chia_bls::Signature) -> Aggsig {
        Aggsig(bls)
    }

    pub fn from_bytes(by: [u8; 96]) -> Result<Aggsig, Error> {
        Ok(Aggsig(chia_bls::Signature::from_bytes(&by).into_gen()?))
    }

    pub fn from_slice(by: &[u8]) -> Result<Aggsig, Error> {
        if by.len() != 96 {
            return Err(Error::StrErr("bad aggsig length".to_string()));
        }
        let mut fixed: [u8; 96] = [0; 96];
        for (i, b) in by.iter().enumerate() {
            fixed[i % 96] = *b;
        }
        Aggsig::from_bytes(fixed)
    }

    pub fn bytes(&self) -> [u8; 96] {
        self.0.to_bytes()
    }

    pub fn to_bls(&self) -> chia_bls::Signature {
        self.0.clone()
    }

    pub fn verify(&self, public_key: &PublicKey, msg: &[u8]) -> bool {
        verify(&self.0, &public_key.to_bls(), msg)
    }

    pub fn aggregate(&self, other: &Aggsig) -> Aggsig {
        let mut result = self.0.clone();
        result.aggregate(&other.0);
        Aggsig(result)
    }

    pub fn scalar_multiply(&mut self, int_bytes: &[u8]) {
        self.0.scalar_multiply(int_bytes)
    }
}

impl AddAssign for Aggsig {
    fn add_assign(&mut self, rhs: Self) {
        self.0 += &rhs.0;
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
        encoder.encode_atom(clvm_traits::Atom::Borrowed(&self.0.to_bytes()))
    }
}

///
/// Private Key
#[derive(Clone, Debug)]
pub struct PrivateKey(chia_bls::SecretKey);

impl Default for PrivateKey {
    fn default() -> Self {
        PrivateKey(chia_bls::SecretKey::from_seed(&[0; 32]))
    }
}

impl AddAssign for PrivateKey {
    fn add_assign(&mut self, rhs: Self) {
        self.0 += &rhs.0;
    }
}

impl Add for PrivateKey {
    type Output = PrivateKey;

    fn add(mut self, rhs: Self) -> PrivateKey {
        self += rhs;
        self
    }
}

impl PrivateKey {
    pub fn from_bls(sk: chia_bls::SecretKey) -> PrivateKey {
        PrivateKey(sk)
    }

    pub fn from_bytes(by: &[u8; 32]) -> Result<PrivateKey, Error> {
        Ok(PrivateKey::from_bls(
            chia_bls::SecretKey::from_bytes(by).into_gen()?,
        ))
    }

    pub fn to_bls(&self) -> &chia_bls::SecretKey {
        &self.0
    }

    pub fn sign<Msg: AsRef<[u8]>>(&self, msg: Msg) -> Aggsig {
        Aggsig(sign(&self.0, msg))
    }

    pub fn bytes(&self) -> [u8; 32] {
        self.0.to_bytes()
    }
}
