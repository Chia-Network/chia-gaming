use clvmr::allocator::{Allocator, NodePtr};

use crate::common::types::{AllocEncoder, Error};

pub struct GameGenerator {
    pub program: NodePtr,
}

pub struct HydratedGame {
    pub driver_a: NodePtr,
    pub driver_b: NodePtr,
    pub paired: bool,
    pub required_size_factor: u64,
    pub initial_max_move_size: usize,
    pub initial_validator: NodePtr,
    pub initial_validator_hash: Hash,
    pub initial_state: NodePtr,
    pub initial_mover_share_proportion: u64
}

impl GameGenerator {
    pub fn new(program: NodePtr) -> Self {
        GameGenerator { program }
    }

    pub fn generate(&self, allocator: &mut AllocEncoder) -> Result<HydratedGame, Error> {
        todo!();
    }
}
