use serde::{Deserialize, Serialize};

use crate::common::types::{GameType, LocalProposalId, Timeout, WireProposalId};
use crate::session_phases::proposal::ProposalParameters;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProposalLifecycle {
    LocalDraft,
    LocalEmitted(WireProposalId),
    PeerPending(WireProposalId),
}

impl ProposalLifecycle {
    pub fn wire_id(self) -> Option<WireProposalId> {
        match self {
            Self::LocalDraft => None,
            Self::LocalEmitted(id) | Self::PeerPending(id) => Some(id),
        }
    }

    pub fn originated_locally(self) -> bool {
        matches!(self, Self::LocalDraft | Self::LocalEmitted(_))
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ProposedGame {
    pub local_id: LocalProposalId,
    pub lifecycle: ProposalLifecycle,
    pub game_type: GameType,
    pub timeout: Timeout,
    pub parameters: ProposalParameters,
    pub sender_is_player_a: bool,
}
