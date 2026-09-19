use serde::{Deserialize, Serialize};

/// Endpoint-local handle for a pending proposal.
#[derive(Default, Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Hash)]
pub struct LocalProposalId(pub u64);

impl std::fmt::Display for LocalProposalId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Origin-assigned parity-sequenced proposal identifier carried on the peer wire.
#[derive(Default, Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Hash)]
pub struct WireProposalId(pub u64);

impl std::fmt::Display for WireProposalId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
