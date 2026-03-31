use serde::de::{self, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use num_bigint::{BigInt, Sign};
use num_traits::cast::ToPrimitive;

use clvm_traits::ToClvm;

use crate::common::types::{AllocEncoder, Amount, CoinID, Error, Hash as Hash32, PuzzleHash};

/// Coin String
#[derive(Default, Clone, Eq, PartialEq, Hash, PartialOrd, Ord)]
pub struct CoinString(Vec<u8>);

impl Serialize for CoinString {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bytes(&self.0)
    }
}

struct CoinStringVisitor;

impl<'de> Visitor<'de> for CoinStringVisitor {
    type Value = CoinString;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a byte array or sequence of u8")
    }

    fn visit_bytes<E>(self, v: &[u8]) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CoinString(v.to_vec()))
    }

    fn visit_byte_buf<E>(self, v: Vec<u8>) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(CoinString(v))
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut out = Vec::new();
        while let Some(b) = seq.next_element::<u8>()? {
            out.push(b);
        }
        Ok(CoinString(out))
    }
}

impl<'de> Deserialize<'de> for CoinString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(CoinStringVisitor)
    }
}

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

        let parent_id = CoinID::new(Hash32::from_slice(&self.0[..32]).ok()?);
        let puzzle_hash = PuzzleHash::from_hash(Hash32::from_slice(&self.0[32..64]).ok()?);
        let amount_bytes = &self.0[64..];
        BigInt::from_bytes_be(Sign::Plus, amount_bytes)
            .to_u64()
            .map(|a| (parent_id, puzzle_hash, Amount::new(a)))
    }

    pub fn amount(&self) -> Option<Amount> {
        if let Some((_, _, amt)) = self.to_parts() {
            Some(amt)
        } else {
            None
        }
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

#[cfg(test)]
mod tests {
    use super::CoinString;

    #[test]
    fn coin_string_serializes_to_bson_binary() {
        let coin = CoinString::from_bytes(&[1, 2, 3, 4, 5]);
        let bson = bson::to_bson(&coin).expect("coinstring should serialize");
        match bson {
            bson::Bson::Binary(bin) => {
                assert_eq!(bin.bytes, vec![1, 2, 3, 4, 5]);
            }
            other => panic!("expected bson binary, got {other:?}"),
        }
    }

    #[test]
    fn coin_string_deserializes_from_legacy_array() {
        let legacy = bson::Bson::Array(vec![
            bson::Bson::Int32(1),
            bson::Bson::Int32(2),
            bson::Bson::Int32(3),
            bson::Bson::Int32(4),
        ]);
        let coin: CoinString = bson::from_bson(legacy).expect("legacy array should deserialize");
        assert_eq!(coin.to_bytes(), &[1, 2, 3, 4]);
    }
}
