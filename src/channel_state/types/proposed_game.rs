use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::common::types::{Amount, GameID, PuzzleHash};
use crate::referee::Referee;

#[derive(Clone, Serialize, Deserialize)]
pub struct ProposedGame {
    pub game_id: GameID,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<GameID>,
    pub initial_puzzle_hash: PuzzleHash,
    pub referee: Rc<Referee>,
    pub my_contribution: Amount,
    pub their_contribution: Amount,
}

impl ProposedGame {
    pub fn new(
        game_id: GameID,
        group_id: Option<GameID>,
        initial_puzzle_hash: PuzzleHash,
        referee: Rc<Referee>,
        my_contribution: Amount,
        their_contribution: Amount,
    ) -> Self {
        ProposedGame {
            game_id,
            group_id,
            initial_puzzle_hash,
            referee,
            my_contribution,
            their_contribution,
        }
    }
}
