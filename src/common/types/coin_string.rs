use std::ops::{Add, AddAssign, Sub, SubAssign};

use serde::{Deserialize, Serialize};

use num_bigint::{BigInt, Sign};
use num_traits::cast::ToPrimitive;

use rand::distributions::Standard;
use rand::prelude::*;

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;

use crate::common::types::coin_id::{atom_from_clvm, AllocEncoder, CoinID, Hash};
use crate::common::types::error::Error;

pub fn usize_from_atom(a: &[u8]) -> Option<usize> {
    let bi = BigInt::from_bytes_be(Sign::Plus, a);
    bi.to_usize()
}

pub fn i32_from_atom(a: &[u8]) -> Option<i32> {
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

/// Amount
#[derive(Default, Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct Amount(u64);

impl Amount {
    pub fn new(amt: u64) -> Amount {
        Amount(amt)
    }

    pub fn half(&self) -> Amount {
        Amount::new(self.0 / 2)
    }

    pub fn to_u64(&self) -> u64 {
        self.0
    }

    pub fn from_clvm(allocator: &mut AllocEncoder, clvm: NodePtr) -> Result<Amount, Error> {
        if let Some(val) = atom_from_clvm(allocator, clvm).and_then(|a| u64_from_atom(&a)) {
            Ok(Amount::new(val))
        } else {
            Err(Error::StrErr("bad amount".to_string()))
        }
    }
}

impl AddAssign for Amount {
    fn add_assign(&mut self, rhs: Self) {
        self.0 += rhs.0;
    }
}

impl Add for Amount {
    type Output = Amount;

    fn add(mut self, rhs: Self) -> Amount {
        self += rhs;
        self
    }
}

impl SubAssign for Amount {
    fn sub_assign(&mut self, rhs: Self) {
        self.0 -= rhs.0;
    }
}

impl Sub for Amount {
    type Output = Amount;

    fn sub(mut self, rhs: Self) -> Amount {
        self -= rhs;
        self
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Amount {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}

impl From<Amount> for u64 {
    fn from(amt: Amount) -> Self {
        amt.0
    }
}

/// Puzzle hash
#[derive(Default, Clone, Eq, PartialEq, Debug, Serialize, Deserialize, Hash)]
pub struct PuzzleHash(Hash);

impl PuzzleHash {
    pub fn from_bytes(by: [u8; 32]) -> PuzzleHash {
        PuzzleHash(Hash::from_bytes(by))
    }
    pub fn from_hash(h: Hash) -> PuzzleHash {
        PuzzleHash(h)
    }
    pub fn bytes(&self) -> &[u8] {
        self.0.bytes()
    }
    pub fn hash(&self) -> &Hash {
        &self.0
    }
}

impl Distribution<PuzzleHash> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> PuzzleHash {
        PuzzleHash::from_hash(rng.gen())
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for PuzzleHash {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        encoder.encode_atom(clvm_traits::Atom::Borrowed(&self.0 .0))
    }
}

/// Coin String
#[derive(Default, Clone, Serialize, Deserialize, Eq, PartialEq, Hash)]
pub struct CoinString(Vec<u8>);

impl std::fmt::Debug for CoinString {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        writeln!(formatter, "{:?}", self.to_parts())
    }
}

impl CoinString {
    pub fn from_bytes(bytes: &[u8]) -> CoinString {
        CoinString(bytes.to_vec())
    }

    pub fn to_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn from_parts(parent: &CoinID, puzzle_hash: &PuzzleHash, amount: &Amount) -> CoinString {
        let mut allocator = AllocEncoder::new();
        let amount_clvm = amount.to_clvm(&mut allocator).unwrap();
        let mut res = Vec::new();
        res.append(&mut parent.bytes().to_vec());
        res.append(&mut puzzle_hash.bytes().to_vec());
        res.append(&mut allocator.allocator().atom(amount_clvm).to_vec());
        CoinString(res)
    }

    pub fn to_parts(&self) -> Option<(CoinID, PuzzleHash, Amount)> {
        if self.0.len() < 64 {
            return None;
        }

        let parent_id = CoinID::new(Hash::from_slice(&self.0[..32]));
        let puzzle_hash = PuzzleHash::from_hash(Hash::from_slice(&self.0[32..64]));
        let amount_bytes = &self.0[64..];
        BigInt::from_bytes_be(Sign::Plus, amount_bytes)
            .to_u64()
            .map(|a| (parent_id, puzzle_hash, Amount::new(a)))
    }

    pub fn to_coin_id(&self) -> CoinID {
        CoinID(Hash::new(&self.0))
    }
}

pub trait GetCoinStringParts {
    type Res;

    /// Return an error if the optional coin string is improper.
    fn get_coin_string_parts(&self) -> Result<Self::Res, Error>;
}

impl GetCoinStringParts for CoinString {
    type Res = (CoinID, PuzzleHash, Amount);
    fn get_coin_string_parts(&self) -> Result<Self::Res, Error> {
        if let Some((id, ph, amt)) = self.to_parts() {
            Ok((id, ph, amt))
        } else {
            Err(Error::StrErr("improper coin string".to_string()))
        }
    }
}
impl GetCoinStringParts for &CoinString {
    type Res = (CoinID, PuzzleHash, Amount);
    fn get_coin_string_parts(&self) -> Result<Self::Res, Error> {
        (*self).get_coin_string_parts()
    }
}
impl GetCoinStringParts for Option<CoinString> {
    type Res = Option<(CoinID, PuzzleHash, Amount)>;
    fn get_coin_string_parts(&self) -> Result<Self::Res, Error> {
        if let Some(coin) = self {
            Ok(Some(coin.get_coin_string_parts()?))
        } else {
            Ok(None)
        }
    }
}
