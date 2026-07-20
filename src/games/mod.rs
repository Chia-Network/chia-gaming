pub mod krunk_dict_tree;

use chia_protocol::Bytes;

use crate::common::types::GameType;

/// Loads the krunk dictionary from `krunkwords.txt`, embedded at compile time.
/// Words are 5 ASCII letters; one per line.
pub fn krunk_dictionary() -> Vec<Bytes> {
    include_str!("../../clsp/games/krunk/krunkwords.txt")
        .lines()
        .filter(|l| l.len() == 5)
        .map(|w| Bytes::from(w.as_bytes().to_vec()))
        .collect()
}

/// The `GameType` key for krunk in the game type map.
pub fn krunk_game_type() -> GameType {
    GameType(b"krunk".to_vec())
}
