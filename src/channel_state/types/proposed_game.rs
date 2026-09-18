use serde::{Deserialize, Serialize};

use crate::common::types::{GameID, GameType, Timeout};
use crate::session_phases::proposal::ProposalParameters;

#[derive(Clone, Serialize, Deserialize)]
pub struct ProposedGame {
    /// Canonical parity-namespaced proposal ID used locally and on the wire.
    pub id: GameID,
    pub game_type: GameType,
    pub timeout: Timeout,
    pub parameters: ProposalParameters,
    pub sender_is_player_a: bool,
}
