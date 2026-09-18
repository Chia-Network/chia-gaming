use serde::{Deserialize, Serialize};

use crate::common::types::{GameType, LocalProposalId, Timeout, WireProposalId};
use crate::session_phases::proposal::ProposalParameters;

#[derive(Clone, Serialize, Deserialize)]
pub struct ProposedGame {
    pub local_id: LocalProposalId,
    pub origin_wire_id: Option<WireProposalId>,
    pub originated_locally: bool,
    pub game_type: GameType,
    pub timeout: Timeout,
    pub parameters: ProposalParameters,
    pub sender_is_player_a: bool,
}
