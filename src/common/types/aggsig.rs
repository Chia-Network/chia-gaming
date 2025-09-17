use std::ops::{Add, AddAssign};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use clvmr::allocator::NodePtr;

use chia_bls;
use chia_bls::signature::verify;
use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};

use crate::common::types::{Error, IntoErr, PublicKey};

/// Aggsig
#[derive(Clone, Eq, PartialEq, Debug, Default)]
pub struct Aggsig(pub chia_bls::Signature);

impl Serialize for Aggsig {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        hex::encode(&self.bytes()).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Aggsig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let st = String::deserialize(deserializer)?;
        let slice = hex::decode(&st).unwrap();
        Ok(Aggsig::from_slice(&slice).unwrap())
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
