pub mod peer;
pub mod sim_script;

#[cfg(test)]
pub use crate::games::calpoker::tests::sim as calpoker_sim;
#[cfg(test)]
pub use crate::games::debug as debug_game;
#[cfg(test)]
pub use crate::games::krunk::tests::sim as krunk_sim;
#[cfg(test)]
pub use crate::games::spacepoker::tests::sim as spacepoker_sim;
