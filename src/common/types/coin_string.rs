use serde::{Deserialize, Serialize};

use num_bigint::{BigInt, Sign};
use num_traits::cast::ToPrimitive;

use clvm_traits::ToClvm;

use crate::common::types::{AllocEncoder, Amount, CoinID, Error, Hash as Hash32, PuzzleHash};

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

        let parent_id = CoinID::new(Hash32::from_slice(&self.0[..32]));
        let puzzle_hash = PuzzleHash::from_hash(Hash32::from_slice(&self.0[32..64]));
        let amount_bytes = &self.0[64..];
        BigInt::from_bytes_be(Sign::Plus, amount_bytes)
            .to_u64()
            .map(|a| (parent_id, puzzle_hash, Amount::new(a)))
    }

    pub fn to_coin_id(&self) -> CoinID {
        CoinID(Hash32::new(&self.0))
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
