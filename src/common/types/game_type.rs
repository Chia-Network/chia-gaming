use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::common::types::Hash;

/// Protocol identity of a registered game: the first generated member's
/// `initial_validation_program_hash`.
///
/// Registration discovers it by running the factory with representative valid
/// parameters; the factory program itself is not hashed as the identity.
///
/// Package keys (`calpoker`, `krunk`, …) are bootstrap-only and never appear
/// in peer messages or persisted protocol state.
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct GameType(Hash);

impl GameType {
    pub fn from_hash(hash: Hash) -> Self {
        GameType(hash)
    }

    pub fn hash(&self) -> &Hash {
        &self.0
    }

    pub fn bytes(&self) -> &[u8; 32] {
        self.0.bytes()
    }
}

impl PartialOrd for GameType {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for GameType {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.bytes().cmp(other.0.bytes())
    }
}

impl Serialize for GameType {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        hex::encode(self.0.bytes()).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for GameType {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let st = String::deserialize(deserializer)?;
        let slice = hex::decode(&st).map_err(serde::de::Error::custom)?;
        let hash = Hash::from_slice(&slice).map_err(serde::de::Error::custom)?;
        Ok(GameType::from_hash(hash))
    }
}

impl std::fmt::Display for GameType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", hex::encode(self.0.bytes()))
    }
}
