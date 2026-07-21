use crate::channel_state::types::LiveGame;
use crate::common::types::{Aggsig, Amount, GameID, Program, PuzzleHash};
use crate::referee::Referee;
use serde::{Deserialize, Serialize};
use std::rc::Rc;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StateUpdateSignatures {
    // Half signed thing signing to the new state.
    pub channel_half_sig: Aggsig,
    // Half signed thing allowing you to supercede an earlier state to this one.
    pub unroll_preempt_half_sig: Aggsig,
}

#[derive(Clone, Serialize, Deserialize)]

pub struct CachedAcceptSettlement {
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub live_game: LiveGame,
    pub at_stake_amount: Amount,
    pub our_share_amount: Amount,
    pub game_finished: bool,
}

impl std::fmt::Debug for CachedAcceptSettlement {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(formatter, "CachedAcceptSettlement {{ game_id: {:?}, puzzle_hash: {:?}, live_game: .., at_stake_amount: {:?}, our_share_amount: {:?}, game_finished: {} }}", self.game_id, self.puzzle_hash, self.at_stake_amount, self.our_share_amount, self.game_finished)
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CachedSendMove {
    pub state_number: usize,
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub match_puzzle_hash: PuzzleHash,
    pub amount: Amount,
    pub saved_post_move_referee: Option<Rc<Referee>>,
    pub saved_post_move_last_ph: Option<PuzzleHash>,
}

impl std::fmt::Debug for CachedSendMove {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CachedSendMove")
            .field("state_number", &self.state_number)
            .field("game_id", &self.game_id)
            .field("puzzle_hash", &self.puzzle_hash)
            .field("match_puzzle_hash", &self.match_puzzle_hash)
            .field("amount", &self.amount)
            .field(
                "saved_post_move_referee",
                &self.saved_post_move_referee.is_some(),
            )
            .field("saved_post_move_last_ph", &self.saved_post_move_last_ph)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CachedRedoActions {
    #[serde(rename = "CachedAcceptSettlement")]
    CachedAcceptSettlement(Box<CachedAcceptSettlement>),
    CachedSendMove(Rc<CachedSendMove>),
    ProposalAccepted(GameID),
}

pub struct ChannelMoveResult {
    pub state_number: usize,
    pub readable_their_move: Rc<Program>,
    pub message: Vec<u8>,
    pub mover_share: Amount,
}
