use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq, PartialOrd, Ord, Hash)]
pub struct GameType(pub Vec<u8>);
