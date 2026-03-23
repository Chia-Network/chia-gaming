use std::ops::{Add, AddAssign};

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
        hex::encode(self.0).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Aggsig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let st = String::deserialize(deserializer)?;
        let slice = hex::decode(&st).map_err(serde::de::Error::custom)?;
        Aggsig::from_slice(&slice).map_err(|e| serde::de::Error::custom(format!("{e:?}")))
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
