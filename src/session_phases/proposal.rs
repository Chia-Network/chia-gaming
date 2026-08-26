use std::fmt;

use clvm_traits::ToClvm;
use clvmr::NodePtr;
#[cfg(test)]
use serde::de::MapAccess;
use serde::de::{self, SeqAccess, Visitor};
#[cfg(test)]
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::common::types::{AllocEncoder, Amount, Error, GameType, Program, Timeout};
use crate::utils::enlist;

/// Bencodex-native game parameters. Rust converts this value to CLVM only when
/// invoking the game factory; game-facing frontend code never handles CLVM.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProposalParameters {
    Null,
    Bool(bool),
    Integer(i128),
    Bytes(Vec<u8>),
    Text(String),
    List(Vec<ProposalParameters>),
    #[cfg(test)]
    RawClvmPair(Box<ProposalParameters>, Box<ProposalParameters>),
}

impl ProposalParameters {
    fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        match self {
            Self::Null | Self::Bool(false) => Ok(NodePtr::NIL),
            Self::Bool(true) => allocator.allocator().new_atom(&[1]).map_err(Error::ClvmErr),
            Self::Integer(value) => value.to_clvm(allocator).map_err(Error::EncodeErr),
            Self::Bytes(value) => allocator
                .allocator()
                .new_atom(value)
                .map_err(Error::ClvmErr),
            Self::Text(value) => allocator
                .allocator()
                .new_atom(value.as_bytes())
                .map_err(Error::ClvmErr),
            Self::List(values) => {
                let nodes = values
                    .iter()
                    .map(|value| value.to_nodeptr(allocator))
                    .collect::<Result<Vec<_>, _>>()?;
                enlist(allocator.allocator(), &nodes).map_err(Error::ClvmErr)
            }
            #[cfg(test)]
            Self::RawClvmPair(first, rest) => {
                let first = first.to_nodeptr(allocator)?;
                let rest = rest.to_nodeptr(allocator)?;
                allocator
                    .allocator()
                    .new_pair(first, rest)
                    .map_err(Error::ClvmErr)
            }
        }
    }

    pub fn to_program(&self, allocator: &mut AllocEncoder) -> Result<Program, Error> {
        let node = self.to_nodeptr(allocator)?;
        Program::from_nodeptr(allocator, node)
    }

    #[cfg(test)]
    pub fn from_program_for_testing(
        allocator: &mut AllocEncoder,
        program: &Program,
    ) -> Result<Self, Error> {
        use clvmr::allocator::SExp;

        fn convert(
            allocator: &clvmr::Allocator,
            node: NodePtr,
        ) -> Result<ProposalParameters, Error> {
            match allocator.sexp(node) {
                SExp::Atom => Ok(ProposalParameters::Bytes(
                    allocator.atom(node).as_ref().to_vec(),
                )),
                SExp::Pair(first, rest) => Ok(ProposalParameters::RawClvmPair(
                    Box::new(convert(allocator, first)?),
                    Box::new(convert(allocator, rest)?),
                )),
            }
        }

        let node = program.to_nodeptr(allocator)?;
        convert(allocator.allocator(), node)
    }
}

impl Serialize for ProposalParameters {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Null => serializer.serialize_unit(),
            Self::Bool(value) => serializer.serialize_bool(*value),
            Self::Integer(value) => serializer.serialize_i128(*value),
            Self::Bytes(value) => serializer.serialize_bytes(value),
            Self::Text(value) => serializer.serialize_str(value),
            Self::List(values) => values.serialize(serializer),
            #[cfg(test)]
            Self::RawClvmPair(first, rest) => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("$test_clvm_pair", &(first, rest))?;
                map.end()
            }
        }
    }
}

struct ProposalParametersVisitor;

impl<'de> Visitor<'de> for ProposalParametersVisitor {
    type Value = ProposalParameters;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a null, boolean, integer, byte string, text string, or list")
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(ProposalParameters::Null)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(ProposalParameters::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(ProposalParameters::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(ProposalParameters::Integer(i128::from(value)))
    }

    fn visit_i128<E>(self, value: i128) -> Result<Self::Value, E> {
        Ok(ProposalParameters::Integer(value))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(ProposalParameters::Integer(i128::from(value)))
    }

    fn visit_u128<E>(self, value: u128) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        i128::try_from(value)
            .map(ProposalParameters::Integer)
            .map_err(|_| E::custom("proposal parameter integer exceeds i128"))
    }

    fn visit_bytes<E>(self, value: &[u8]) -> Result<Self::Value, E> {
        Ok(ProposalParameters::Bytes(value.to_vec()))
    }

    fn visit_byte_buf<E>(self, value: Vec<u8>) -> Result<Self::Value, E> {
        Ok(ProposalParameters::Bytes(value))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(ProposalParameters::Text(value.to_string()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(ProposalParameters::Text(value))
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = seq.next_element()? {
            values.push(value);
        }
        Ok(ProposalParameters::List(values))
    }

    #[cfg(test)]
    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let key = map
            .next_key::<String>()?
            .ok_or_else(|| de::Error::custom("proposal parameter dictionaries are unsupported"))?;
        if key != "$test_clvm_pair" {
            return Err(de::Error::custom(
                "proposal parameter dictionaries are unsupported",
            ));
        }
        let (first, rest): (ProposalParameters, ProposalParameters) = map.next_value()?;
        if map.next_key::<String>()?.is_some() {
            return Err(de::Error::custom(
                "proposal parameter dictionaries are unsupported",
            ));
        }
        Ok(ProposalParameters::RawClvmPair(
            Box::new(first),
            Box::new(rest),
        ))
    }
}

impl<'de> Deserialize<'de> for ProposalParameters {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(ProposalParametersVisitor)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameProposal {
    pub player_a_contribution: Amount,
    pub player_b_contribution: Amount,
    pub sender_is_player_a: bool,
    pub game_type: GameType,
    pub timeout: Timeout,
    pub parameters: ProposalParameters,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bencodex_round_trips_structured_parameters() {
        let parameters = ProposalParameters::List(vec![
            ProposalParameters::Integer(42),
            ProposalParameters::Bool(true),
            ProposalParameters::Bytes(vec![0, 255]),
            ProposalParameters::Text("unit".to_string()),
            ProposalParameters::Null,
        ]);
        let encoded = bencodex::to_vec(&parameters).expect("encode parameters");
        let decoded: ProposalParameters =
            bencodex::from_slice(&encoded).expect("decode parameters");
        assert_eq!(decoded, parameters);
    }

    #[test]
    fn structured_parameters_convert_to_canonical_clvm() {
        let mut allocator = AllocEncoder::new();
        let parameters = ProposalParameters::List(vec![
            ProposalParameters::Integer(42),
            ProposalParameters::Integer(0),
            ProposalParameters::Integer(-1),
            ProposalParameters::Bool(true),
            ProposalParameters::Bool(false),
            ProposalParameters::Bytes(vec![0xaa]),
        ]);
        let program = parameters
            .to_program(&mut allocator)
            .expect("convert to clvm");

        assert_eq!(
            program.bytes(),
            &[
                0xff, 42, 0xff, 0x80, 0xff, 0x81, 0xff, 0xff, 1, 0xff, 0x80, 0xff, 0x81, 0xaa,
                0x80,
            ]
        );
    }

    #[test]
    fn bencodex_dictionary_is_not_a_proposal_parameter() {
        let error = bencodex::from_slice::<ProposalParameters>(b"de")
            .expect_err("dictionary should be rejected");
        assert!(format!("{error:?}").contains("dictionaries are unsupported"));
    }
}
