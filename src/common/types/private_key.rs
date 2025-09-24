use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::ops::{Add, AddAssign};

use rand::distributions::Standard;
use rand::prelude::*;

use chia_bls;
use chia_bls::signature::sign;

use crate::common::types::{Aggsig, Error, Hash, IntoErr};

impl Distribution<PrivateKey> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> PrivateKey {
        let hash: Hash = rng.gen();
        PrivateKey(chia_bls::SecretKey::from_seed(hash.bytes()))
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

    pub fn from_slice(slice: &[u8]) -> Result<PrivateKey, Error> {
        let mut bytes: [u8; 32] = [0; 32];
        for (i, b) in slice.iter().enumerate() {
            bytes[i % 32] = *b;
        }
        PrivateKey::from_bytes(&bytes)
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

impl Serialize for PrivateKey {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        hex::encode(self.bytes()).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for PrivateKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let st = String::deserialize(deserializer)?;
        let slice = hex::decode(&st).unwrap();
        Ok(PrivateKey::from_slice(&slice).unwrap())
    }
}
