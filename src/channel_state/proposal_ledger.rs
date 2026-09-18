use serde::{Deserialize, Serialize};

use crate::channel_state::types::{ProposalLifecycle, ProposedGame};
use crate::common::types::{Error, LocalProposalId, WireProposalId};
use crate::session_phases::proposal::GameProposal;

const MAX_PROPOSALS: usize = 100;

/// Owns all pending proposal terms and the endpoint-local ↔ wire ID boundary.
#[derive(Clone, Serialize, Deserialize)]
pub struct ProposalLedger {
    next_local_id: u64,
    next_outgoing_wire_id: u64,
    next_incoming_wire_id: u64,
    pending: Vec<ProposedGame>,
}

impl ProposalLedger {
    pub fn new(is_receiver: bool) -> Self {
        Self {
            next_local_id: 0,
            next_outgoing_wire_id: if is_receiver { 0 } else { 1 },
            next_incoming_wire_id: if is_receiver { 1 } else { 0 },
            pending: Vec::new(),
        }
    }

    fn allocate_local_id(&mut self) -> Result<LocalProposalId, Error> {
        let id = LocalProposalId(self.next_local_id);
        self.next_local_id = self
            .next_local_id
            .checked_add(1)
            .ok_or_else(|| Error::StrErr("local proposal id overflow".into()))?;
        Ok(id)
    }

    fn ensure_capacity(&self) -> Result<(), Error> {
        if self.pending.len() >= MAX_PROPOSALS {
            Err(Error::StrErr(
                "too many outstanding proposals (max 100)".into(),
            ))
        } else {
            Ok(())
        }
    }

    pub fn create_outgoing(&mut self, start: &GameProposal) -> Result<LocalProposalId, Error> {
        self.ensure_capacity()?;
        let local_id = self.allocate_local_id()?;
        self.pending.push(ProposedGame {
            local_id,
            lifecycle: ProposalLifecycle::LocalDraft,
            game_type: start.game_type.clone(),
            timeout: start.timeout.clone(),
            parameters: start.parameters.clone(),
            sender_is_player_a: start.sender_is_player_a,
        });
        Ok(local_id)
    }

    pub fn emit_outgoing(&mut self, local_id: LocalProposalId) -> Result<WireProposalId, Error> {
        let proposal = self
            .pending
            .iter_mut()
            .find(|proposal| proposal.local_id == local_id)
            .ok_or_else(|| Error::StrErr(format!("no proposal with id {local_id}")))?;
        match proposal.lifecycle {
            ProposalLifecycle::LocalDraft => {}
            ProposalLifecycle::LocalEmitted(_) => {
                return Err(Error::StrErr(format!(
                    "proposal {local_id} was already emitted"
                )));
            }
            ProposalLifecycle::PeerPending(_) => {
                return Err(Error::StrErr(
                    "cannot emit a peer-origin proposal".to_string(),
                ));
            }
        }
        let wire_id = WireProposalId(self.next_outgoing_wire_id);
        self.next_outgoing_wire_id = self
            .next_outgoing_wire_id
            .checked_add(2)
            .ok_or_else(|| Error::StrErr("outgoing proposal wire id overflow".into()))?;
        proposal.lifecycle = ProposalLifecycle::LocalEmitted(wire_id);
        Ok(wire_id)
    }

    pub fn record_incoming(
        &mut self,
        origin_wire_id: WireProposalId,
        start: &GameProposal,
    ) -> Result<LocalProposalId, Error> {
        self.ensure_capacity()?;
        if origin_wire_id.0 != self.next_incoming_wire_id {
            return Err(Error::StrErr(format!(
                "received proposal wire id {} but strict next id is {}",
                origin_wire_id.0, self.next_incoming_wire_id
            )));
        }
        self.next_incoming_wire_id = self
            .next_incoming_wire_id
            .checked_add(2)
            .ok_or_else(|| Error::StrErr("incoming proposal wire id overflow".into()))?;
        let local_id = self.allocate_local_id()?;
        self.pending.push(ProposedGame {
            local_id,
            lifecycle: ProposalLifecycle::PeerPending(origin_wire_id),
            game_type: start.game_type.clone(),
            timeout: start.timeout.clone(),
            parameters: start.parameters.clone(),
            sender_is_player_a: start.sender_is_player_a,
        });
        Ok(local_id)
    }

    pub fn find_local(&self, local_id: LocalProposalId) -> Option<&ProposedGame> {
        self.pending
            .iter()
            .find(|proposal| proposal.local_id == local_id)
    }

    pub fn local_for_wire(&self, wire_id: WireProposalId) -> Option<LocalProposalId> {
        self.pending
            .iter()
            .find(|proposal| proposal.lifecycle.wire_id() == Some(wire_id))
            .map(|proposal| proposal.local_id)
    }

    pub fn remove_local(&mut self, local_id: LocalProposalId) -> Result<ProposedGame, Error> {
        let index = self
            .pending
            .iter()
            .position(|proposal| proposal.local_id == local_id)
            .ok_or_else(|| Error::StrErr(format!("no proposal with id {local_id}")))?;
        Ok(self.pending.remove(index))
    }

    pub fn remove_wire(&mut self, wire_id: WireProposalId) -> Result<ProposedGame, Error> {
        let local_id = self
            .local_for_wire(wire_id)
            .ok_or_else(|| Error::StrErr(format!("no proposal with wire id {wire_id}")))?;
        self.remove_local(local_id)
    }

    pub fn cancel_all(&mut self) -> Vec<LocalProposalId> {
        let ids = self
            .pending
            .iter()
            .map(|proposal| proposal.local_id)
            .collect();
        self.pending.clear();
        ids
    }

    pub fn has_outgoing(&self) -> bool {
        self.pending
            .iter()
            .any(|proposal| proposal.lifecycle.originated_locally())
    }

    pub fn incoming_ids(&self) -> Vec<LocalProposalId> {
        self.pending
            .iter()
            .filter(|proposal| !proposal.lifecycle.originated_locally())
            .map(|proposal| proposal.local_id)
            .collect()
    }

    pub fn is_pending(&self, local_id: LocalProposalId) -> bool {
        self.find_local(local_id).is_some()
    }

    #[cfg(test)]
    pub fn next_wire_ids(&self) -> (WireProposalId, WireProposalId) {
        (
            WireProposalId(self.next_outgoing_wire_id),
            WireProposalId(self.next_incoming_wire_id),
        )
    }

    #[cfg(test)]
    pub fn pending(&self) -> &[ProposedGame] {
        &self.pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::types::{GameType, Hash, Timeout};
    use crate::session_phases::proposal::ProposalParameters;

    fn proposal() -> GameProposal {
        GameProposal {
            sender_is_player_a: true,
            game_type: GameType::from_hash(Hash::default()),
            timeout: Timeout::new(10),
            parameters: ProposalParameters::Null,
        }
    }

    #[test]
    fn pre_wire_cancel_consumes_only_local_id() {
        let mut ledger = ProposalLedger::new(false);
        let first = ledger.create_outgoing(&proposal()).unwrap();
        assert_eq!(
            ledger.find_local(first).unwrap().lifecycle,
            ProposalLifecycle::LocalDraft
        );
        ledger.remove_local(first).unwrap();
        let second = ledger.create_outgoing(&proposal()).unwrap();
        let wire = ledger.emit_outgoing(second).unwrap();

        assert_eq!(first, LocalProposalId(0));
        assert_eq!(second, LocalProposalId(1));
        assert_eq!(wire, WireProposalId(1));
        assert_eq!(
            ledger.find_local(second).unwrap().lifecycle,
            ProposalLifecycle::LocalEmitted(wire)
        );
        assert_eq!(ledger.next_wire_ids().0, WireProposalId(3));
    }

    #[test]
    fn emitted_wire_ids_keep_strict_parity_and_are_never_reused() {
        let mut ledger = ProposalLedger::new(true);
        let first = ledger.create_outgoing(&proposal()).unwrap();
        assert_eq!(ledger.emit_outgoing(first).unwrap(), WireProposalId(0));
        ledger.remove_local(first).unwrap();
        let second = ledger.create_outgoing(&proposal()).unwrap();
        assert_eq!(ledger.emit_outgoing(second).unwrap(), WireProposalId(2));
    }

    #[test]
    fn incoming_wire_ids_get_fresh_endpoint_local_ids() {
        let mut ledger = ProposalLedger::new(true);
        let outgoing = ledger.create_outgoing(&proposal()).unwrap();
        let incoming = ledger
            .record_incoming(WireProposalId(1), &proposal())
            .unwrap();

        assert_eq!(outgoing, LocalProposalId(0));
        assert_eq!(incoming, LocalProposalId(1));
        assert_eq!(
            ledger.find_local(incoming).unwrap().lifecycle,
            ProposalLifecycle::PeerPending(WireProposalId(1))
        );
        assert_eq!(
            ledger.local_for_wire(WireProposalId(1)),
            Some(LocalProposalId(1))
        );
    }

    #[test]
    fn incoming_wire_sequence_rejects_gaps_reuse_and_wrong_parity() {
        let mut gap = ProposalLedger::new(true);
        assert!(gap.record_incoming(WireProposalId(3), &proposal()).is_err());

        let mut reuse = ProposalLedger::new(true);
        reuse
            .record_incoming(WireProposalId(1), &proposal())
            .unwrap();
        assert!(reuse
            .record_incoming(WireProposalId(1), &proposal())
            .is_err());

        let mut wrong_parity = ProposalLedger::new(true);
        assert!(wrong_parity
            .record_incoming(WireProposalId(0), &proposal())
            .is_err());
    }

    #[test]
    fn proposal_lifecycle_round_trips_without_illegal_combinations() {
        let mut ledger = ProposalLedger::new(false);
        let draft = ledger.create_outgoing(&proposal()).unwrap();
        let emitted = ledger.create_outgoing(&proposal()).unwrap();
        ledger.emit_outgoing(emitted).unwrap();
        ledger
            .record_incoming(WireProposalId(0), &proposal())
            .unwrap();

        let encoded = bencodex::to_vec(&ledger).expect("serialize proposal ledger");
        let restored: ProposalLedger =
            bencodex::from_slice(&encoded).expect("deserialize proposal ledger");
        let lifecycles: Vec<ProposalLifecycle> = restored
            .pending()
            .iter()
            .map(|proposal| proposal.lifecycle)
            .collect();

        assert_eq!(restored.find_local(draft).unwrap().local_id, draft);
        assert_eq!(
            lifecycles,
            vec![
                ProposalLifecycle::LocalDraft,
                ProposalLifecycle::LocalEmitted(WireProposalId(1)),
                ProposalLifecycle::PeerPending(WireProposalId(0)),
            ]
        );
    }
}
