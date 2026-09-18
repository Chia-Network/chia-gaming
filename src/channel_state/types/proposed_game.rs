use serde::{Deserialize, Serialize};

use crate::common::types::{GameID, GameType, Timeout};
use crate::session_phases::proposal::ProposalParameters;

#[derive(Clone, Serialize, Deserialize)]
pub struct ProposedGame {
    /// Endpoint-local proposal handle exposed to this host.
    pub local_id: GameID,
    /// Strict parity-sequenced ID chosen by the proposal's origin.
    pub origin_wire_id: GameID,
    pub game_type: GameType,
    pub timeout: Timeout,
    pub parameters: ProposalParameters,
    pub sender_is_player_a: bool,
}
