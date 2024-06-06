use crate::common::types::{AllocEncoder, Error};
use crate::channel_handler::game::Game;

pub fn load_calpoker(allocator: &mut AllocEncoder) -> Result<Game, Error> {
    Game::new(allocator, "resources/calpoker_include_calpoker_template.hex")
}

#[test]
fn test_load_calpoker() {
    let mut allocator = AllocEncoder::new();
    let calpoker = load_calpoker(&mut allocator);
}
