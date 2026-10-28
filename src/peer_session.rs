//! Reliable peer delivery and locally accepted session setup. The host supplies
//! connectivity observations, executes sends, and owns the checkpoint boundary.
//! Neither a wallet connection nor a hub socket belongs to this module.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

pub mod coordination;
pub mod session;

use coordination::{ReceiveMode, TerminalHandoff};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub msgno: u64,
    pub msg: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReliableState {
    pub session_id: String,
    pub message_number: u64,
    pub remote_number: u64,
    pub unacked_messages: Vec<Message>,
    pub disposition: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivePolicy {
    pub max_future_reliable_msgno_gap: u64,
    pub max_queued_messages: usize,
    pub max_queued_bytes: usize,
    pub max_peer_body_bytes: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedCommit {
    pub generation: u32,
    pub outbound_count: usize,
    pub ack_count: usize,
    pub remote_number: u64,
}

#[derive(Default, Serialize)]
pub struct ReleasedFrames {
    pub outbound: Vec<Message>,
    pub acks: Vec<u64>,
}

/// The proposal wire format is unchanged. Optional fields remain omitted.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionTerms {
    pub proposer_amount: String,
    pub responder_amount: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_timeout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unroll_timeout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum SetupState {
    WaitingForWalletAddress {
        terms: SessionTerms,
        initiator: bool,
    },
    ChannelStarted,
    Retired,
}

/// Receive classification. Delivery is confirmed only after the body consumer
/// succeeds, preserving rollback on an invalid protocol message.
pub enum ReceiveAction {
    Queued,
    Deliver,
    Ack,
}

pub struct PeerSession {
    pub state: ReliableState,
    pub setup: Option<SetupState>,
    pub receive_mode: ReceiveMode,
    pub terminal_handoff: Option<TerminalHandoff>,
    pub failed: bool,
    policy: ReceivePolicy,
    pub reorder_queue: BTreeMap<u64, Vec<u8>>,
    pending_outbound: Vec<Message>,
    pending_acks: Vec<u64>,
    unsent_outbound: BTreeSet<u64>,
    retry_acks: BTreeSet<u64>,
    generation: u32,
    released_generation: u32,
    persisted_generation: u32,
    released_remote_number: u64,
    last_replay_at: f64,
}

impl PeerSession {
    pub fn new(state: ReliableState, policy: ReceivePolicy) -> Self {
        Self {
            released_remote_number: state.remote_number,
            state,
            setup: None,
            receive_mode: ReceiveMode::Raw,
            terminal_handoff: None,
            failed: false,
            policy,
            reorder_queue: BTreeMap::new(),
            pending_outbound: Vec::new(),
            pending_acks: Vec::new(),
            unsent_outbound: BTreeSet::new(),
            retry_acks: BTreeSet::new(),
            generation: 0,
            released_generation: 0,
            persisted_generation: 0,
            last_replay_at: 0.0,
        }
    }

    /// Local acceptance starts the session. The address is requested later by
    /// the host drain; obtaining it is not a prerequisite for proposal delivery.
    pub fn accept(&mut self, terms: SessionTerms, initiator: bool) -> Result<(), String> {
        if self.setup.is_some() {
            return Err("peer session has already been accepted".into());
        }
        if initiator {
            if self.state.message_number != 1 {
                return Err("session proposal must be the first reliable message".into());
            }
            let mut fields = vec![
                ("type", "session_proposal".to_string()),
                ("proposer_amount", terms.proposer_amount.clone()),
                ("responder_amount", terms.responder_amount.clone()),
            ];
            for (name, value) in [
                ("channel_timeout", &terms.channel_timeout),
                ("unroll_timeout", &terms.unroll_timeout),
                ("network", &terms.network),
            ] {
                if let Some(value) = value {
                    fields.push((name, value.clone()));
                }
            }
            let body = bencodex::encode(&bencodex::Value::Dictionary(
                fields
                    .into_iter()
                    .map(|(key, value)| {
                        (
                            bencodex::Value::Text(key.into()),
                            bencodex::Value::Text(value),
                        )
                    })
                    .collect(),
            ))
            .map_err(|e| e.to_string())?;
            self.allocate(body, "active".into())?;
        }
        self.state.disposition = "active".into();
        self.setup = Some(SetupState::WaitingForWalletAddress { terms, initiator });
        Ok(())
    }

    pub fn allocate(&mut self, msg: Vec<u8>, disposition: String) -> Result<u64, String> {
        let msgno = self.state.message_number;
        if !(1..=u32::MAX as u64).contains(&msgno) {
            return Err("Reliable message number exhausted for this session".into());
        }
        self.state.message_number += 1;
        self.state.disposition = disposition;
        let message = Message { msgno, msg };
        self.state.unacked_messages.push(message.clone());
        self.pending_outbound.push(message);
        self.generation += 1;
        Ok(msgno)
    }

    pub fn reject_session(&mut self) -> Result<(), String> {
        let body = bencodex::encode(&bencodex::Value::Dictionary(
            [(
                bencodex::Value::Text("type".into()),
                bencodex::Value::Text("session_reject".into()),
            )]
            .into_iter()
            .collect(),
        ))
        .map_err(|e| e.to_string())?;
        self.allocate(body, "outbound-reject".into())?;
        Ok(())
    }

    pub fn rejection_complete(&self) -> bool {
        self.state.disposition == "outbound-reject" && self.state.unacked_messages.is_empty()
    }

    pub fn proposal_received(&mut self) -> Result<(), String> {
        if self.state.disposition == "outbound-reject" {
            if self.rejection_complete() {
                self.reject_session()?;
            }
        } else {
            self.state.disposition = "proposal-received".into();
        }
        Ok(())
    }

    pub fn delivery_candidate(&self, msgno: u64, body_size: usize) -> Result<&'static str, String> {
        if body_size > self.policy.max_peer_body_bytes {
            return Err(format!(
                "peer message body {} exceeds maximum {}",
                body_size, self.policy.max_peer_body_bytes
            ));
        }
        if msgno <= self.state.remote_number {
            return Ok("duplicate");
        }
        let gap = msgno - (self.state.remote_number + 1);
        if gap > self.policy.max_future_reliable_msgno_gap {
            return Err(format!(
                "peer message {msgno} is {gap} ahead of next expected {}; maximum gap is {}",
                self.state.remote_number + 1,
                self.policy.max_future_reliable_msgno_gap
            ));
        }
        Ok(if gap == 0 { "next" } else { "future" })
    }

    pub fn receive(
        &mut self,
        msgno: u64,
        body: Vec<u8>,
        deliverable: bool,
        terminal: bool,
    ) -> Result<ReceiveAction, String> {
        self.delivery_candidate(msgno, body.len())?;
        if msgno <= self.state.remote_number {
            if msgno <= self.released_remote_number {
                return Ok(ReceiveAction::Ack);
            }
            if !self.pending_acks.contains(&msgno) {
                self.pending_acks.push(msgno);
            }
            return Ok(ReceiveAction::Queued);
        }
        let gap = msgno - (self.state.remote_number + 1);
        if gap > 0 && terminal {
            self.reorder_queue.retain(|queued, _| *queued > msgno);
            return Ok(ReceiveAction::Deliver);
        }
        if gap == 0 && deliverable {
            return Ok(ReceiveAction::Deliver);
        }
        if self.reorder_queue.contains_key(&msgno) {
            return Ok(ReceiveAction::Queued);
        }
        if self.reorder_queue.len() + 1 > self.policy.max_queued_messages {
            return Err(format!(
                "peer receive queue count {} exceeds maximum {}",
                self.reorder_queue.len() + 1,
                self.policy.max_queued_messages
            ));
        }
        let bytes = self.reorder_queue.values().map(Vec::len).sum::<usize>() + body.len();
        if bytes > self.policy.max_queued_bytes {
            return Err(format!(
                "peer receive queue bytes {bytes} exceeds maximum {}",
                self.policy.max_queued_bytes
            ));
        }
        self.reorder_queue.insert(msgno, body);
        Ok(ReceiveAction::Queued)
    }

    pub fn delivered(&mut self, msgno: u64) {
        self.reorder_queue.remove(&msgno);
        self.state.remote_number = msgno;
        self.pending_acks.push(msgno);
        self.generation += 1;
    }

    pub fn next_message(&self) -> Option<Message> {
        let msgno = self.state.remote_number + 1;
        self.reorder_queue.get(&msgno).map(|msg| Message {
            msgno,
            msg: msg.clone(),
        })
    }

    pub fn acknowledge(&mut self, ack: u64) -> Result<(), String> {
        let highest = self.state.message_number - 1;
        if ack < 1 || ack > highest {
            return Err(format!(
                "peer acknowledgement {ack} exceeds highest allocated message {highest}"
            ));
        }
        let before = self.state.unacked_messages.len();
        self.state.unacked_messages.retain(|message| {
            message.msgno > ack
                || self.unsent_outbound.contains(&message.msgno)
                || self
                    .pending_outbound
                    .iter()
                    .any(|pending| pending.msgno == message.msgno)
        });
        if self.state.unacked_messages.len() != before {
            self.generation += 1;
        }
        Ok(())
    }

    /// Hub registration and peer-available are the only replay boundaries.
    /// Socket loss is an observation, never a terminal protocol transition.
    pub fn connectivity(
        &mut self,
        event: &str,
        now: f64,
        force: bool,
    ) -> Result<Option<Vec<Message>>, String> {
        match event {
            "disconnected" | "reconnected" | "peer-unavailable" => return Ok(Some(Vec::new())),
            "registered" | "peer-available" => {}
            _ => return Err(format!("unknown peer connectivity event: {event}")),
        }
        if self.state.unacked_messages.is_empty() {
            return Ok(Some(Vec::new()));
        }
        if !force && now - self.last_replay_at < 1000.0 {
            return Ok(None);
        }
        self.last_replay_at = now;
        Ok(Some(
            self.state
                .unacked_messages
                .iter()
                .filter(|message| {
                    !self
                        .pending_outbound
                        .iter()
                        .any(|pending| pending.msgno == message.msgno)
                })
                .cloned()
                .collect(),
        ))
    }

    pub fn sent(&mut self, msgno: u64, accepted: bool) {
        if accepted {
            self.unsent_outbound.remove(&msgno);
        }
    }

    pub fn ack_sent(&mut self, msgno: u64, accepted: bool) {
        if accepted {
            self.retry_acks.remove(&msgno);
        } else {
            self.retry_acks.insert(msgno);
        }
    }

    pub fn retry_acks(&self) -> Vec<u64> {
        self.retry_acks.iter().copied().collect()
    }
    pub fn dirty(&self) -> bool {
        self.generation > self.persisted_generation
    }

    pub fn prepare_commit(&self) -> PreparedCommit {
        PreparedCommit {
            generation: self.generation,
            outbound_count: self.pending_outbound.len(),
            ack_count: self.pending_acks.len(),
            remote_number: self.state.remote_number,
        }
    }

    pub fn complete_commit(&mut self, commit: PreparedCommit, persisted: bool) -> ReleasedFrames {
        if persisted {
            self.persisted_generation = self.persisted_generation.max(commit.generation);
        }
        if commit.generation <= self.released_generation {
            return ReleasedFrames::default();
        }
        // Cancellation can discard work during a pre-runtime write. Match the
        // host's former splice semantics rather than indexing discarded work.
        let outbound_count = commit.outbound_count.min(self.pending_outbound.len());
        let ack_count = commit.ack_count.min(self.pending_acks.len());
        let outbound: Vec<_> = self.pending_outbound.drain(..outbound_count).collect();
        let acks = self.pending_acks.drain(..ack_count).collect();
        self.released_generation = commit.generation;
        self.released_remote_number = commit.remote_number;
        self.unsent_outbound
            .extend(outbound.iter().map(|message| message.msgno));
        ReleasedFrames { outbound, acks }
    }

    pub fn discard_outbound(&mut self) {
        if self.state.unacked_messages.is_empty() && self.pending_outbound.is_empty() {
            return;
        }
        self.state.unacked_messages.clear();
        self.pending_outbound.clear();
        self.unsent_outbound.clear();
        self.generation += 1;
    }

    pub fn clear_runtime(&mut self) {
        self.setup = None;
        self.reorder_queue.clear();
        self.pending_outbound.clear();
        self.pending_acks.clear();
        self.unsent_outbound.clear();
        self.retry_acks.clear();
        self.released_generation = self.generation;
        self.persisted_generation = self.generation;
    }

    pub fn validate_terminal_handoff(
        &self,
        msgno: u64,
        body: &[u8],
        sent: bool,
        acknowledged: bool,
    ) -> Result<(), String> {
        if acknowledged {
            if !sent
                || self
                    .state
                    .unacked_messages
                    .iter()
                    .any(|message| message.msgno <= msgno)
            {
                return Err(
                    "persisted acknowledged terminal handoff has inconsistent transport state"
                        .into(),
                );
            }
        } else if !self
            .state
            .unacked_messages
            .iter()
            .any(|message| message.msgno == msgno && message.msg == body)
        {
            return Err(
                "persisted terminal handoff does not match its unacked reliable frame".into(),
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer() -> PeerSession {
        PeerSession::new(
            ReliableState {
                session_id: "000102030405060708090a0b0c0d0e0f".into(),
                message_number: 1,
                remote_number: 0,
                unacked_messages: vec![],
                disposition: "active".into(),
            },
            ReceivePolicy {
                max_future_reliable_msgno_gap: 4,
                max_queued_messages: 2,
                max_queued_bytes: 8,
                max_peer_body_bytes: 4,
            },
        )
    }

    fn terms() -> SessionTerms {
        SessionTerms {
            proposer_amount: "100".into(),
            responder_amount: "200".into(),
            channel_timeout: Some("15".into()),
            unroll_timeout: None,
            network: Some("testnet11".into()),
        }
    }

    #[test]
    fn acceptance_starts_setup_and_proposal_waits_for_checkpoint() {
        let mut peer = peer();
        peer.accept(terms(), true).unwrap();
        assert!(matches!(
            peer.setup,
            Some(SetupState::WaitingForWalletAddress {
                initiator: true,
                ..
            })
        ));
        let proposal = &peer.state.unacked_messages[0];
        assert_eq!(proposal.msgno, 1);
        let decoded: BTreeMap<String, String> = bencodex::from_slice(&proposal.msg).unwrap();
        assert_eq!(decoded["type"], "session_proposal");
        assert_eq!(decoded["proposer_amount"], "100");
        assert!(!decoded.contains_key("unroll_timeout"));
        assert!(peer
            .connectivity("registered", 10000.0, false)
            .unwrap()
            .unwrap()
            .is_empty());
        let frames = peer.complete_commit(peer.prepare_commit(), true);
        assert_eq!(frames.outbound.len(), 1);
        assert!(peer.accept(terms(), true).is_err());
    }

    #[test]
    fn accepting_incoming_proposal_preserves_stream_and_buffer() {
        let mut peer = peer();
        peer.state.remote_number = 1;
        peer.receive(2, vec![7], false, false).unwrap();
        peer.accept(terms(), false).unwrap();
        assert_eq!(peer.state.remote_number, 1);
        assert_eq!(peer.state.message_number, 1);
        assert!(peer.state.unacked_messages.is_empty());
        assert_eq!(peer.next_message().unwrap().msg, vec![7]);
        assert!(matches!(
            peer.setup,
            Some(SetupState::WaitingForWalletAddress {
                initiator: false,
                ..
            })
        ));
    }

    #[test]
    fn retiring_setup_cancels_its_pending_wallet_request() {
        let mut peer = peer();
        peer.accept(terms(), true).unwrap();
        peer.clear_runtime();
        assert!(peer.setup.is_none());
    }

    #[test]
    fn reconnect_replays_after_registration_and_respects_throttle() {
        let mut peer = peer();
        peer.allocate(vec![1], "active".into()).unwrap();
        peer.complete_commit(peer.prepare_commit(), true);
        peer.sent(1, true);
        assert!(peer
            .connectivity("disconnected", 10000.0, false)
            .unwrap()
            .unwrap()
            .is_empty());
        assert!(peer
            .connectivity("reconnected", 10000.0, false)
            .unwrap()
            .unwrap()
            .is_empty());
        assert_eq!(
            peer.connectivity("registered", 10000.0, false)
                .unwrap()
                .unwrap()
                .len(),
            1
        );
        assert!(peer
            .connectivity("peer-available", 10001.0, false)
            .unwrap()
            .is_none());
        assert_eq!(
            peer.connectivity("peer-available", 11000.0, false)
                .unwrap()
                .unwrap()
                .len(),
            1
        );
        peer.acknowledge(1).unwrap();
        assert!(peer
            .connectivity("registered", 12000.0, false)
            .unwrap()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn failed_carrier_send_cannot_be_acknowledged_until_sent() {
        let mut peer = peer();
        peer.allocate(vec![1], "active".into()).unwrap();
        peer.acknowledge(1).unwrap();
        assert_eq!(peer.state.unacked_messages.len(), 1);
        peer.complete_commit(peer.prepare_commit(), true);
        peer.sent(1, false);
        peer.acknowledge(1).unwrap();
        assert_eq!(peer.state.unacked_messages.len(), 1);
        peer.sent(1, true);
        peer.acknowledge(1).unwrap();
        assert!(peer.state.unacked_messages.is_empty());
    }

    #[test]
    fn failed_write_releases_boundary_once_and_leaves_it_dirty() {
        let mut peer = peer();
        peer.allocate(vec![1], "active".into()).unwrap();
        peer.delivered(1);
        let commit = peer.prepare_commit();
        let frames = peer.complete_commit(commit.clone(), false);
        assert_eq!(frames.outbound.len(), 1);
        assert_eq!(frames.acks, vec![1]);
        assert!(peer.dirty());
        let frames = peer.complete_commit(commit, true);
        assert!(frames.outbound.is_empty());
        assert!(frames.acks.is_empty());
        assert!(!peer.dirty());
    }

    #[test]
    fn failed_replay_does_not_invalidate_an_earlier_successful_send() {
        let mut peer = peer();
        peer.allocate(vec![1], "active".into()).unwrap();
        peer.complete_commit(peer.prepare_commit(), true);
        peer.sent(1, true);
        peer.connectivity("registered", 10000.0, false).unwrap();
        peer.sent(1, false);
        // The peer can acknowledge the earlier delivery while the replay
        // carrier is unavailable. Only never-sent frames resist ACK pruning.
        peer.acknowledge(1).unwrap();
        assert!(peer.state.unacked_messages.is_empty());
    }

    #[test]
    fn a_checkpoint_can_complete_after_its_outbound_work_was_cancelled() {
        let mut peer = peer();
        peer.allocate(vec![1], "active".into()).unwrap();
        let commit = peer.prepare_commit();
        peer.discard_outbound();
        let frames = peer.complete_commit(commit, true);
        assert!(frames.outbound.is_empty());
        assert!(peer.dirty());
    }

    #[test]
    fn checkpoint_only_releases_captured_messages_and_acknowledgements() {
        let mut peer = peer();
        peer.allocate(vec![1], "active".into()).unwrap();
        peer.delivered(1);
        let commit = peer.prepare_commit();
        peer.allocate(vec![2], "active".into()).unwrap();
        peer.delivered(2);
        let first = peer.complete_commit(commit, true);
        assert_eq!(first.outbound.len(), 1);
        assert_eq!(first.acks, vec![1]);
        assert!(peer.dirty());
        let second = peer.complete_commit(peer.prepare_commit(), true);
        assert_eq!(second.outbound[0].msgno, 2);
        assert_eq!(second.acks, vec![2]);
    }

    #[test]
    fn receiving_orders_deduplicates_and_enforces_limits() {
        let mut peer = peer();
        assert!(matches!(
            peer.receive(2, vec![2], true, false).unwrap(),
            ReceiveAction::Queued
        ));
        assert!(peer.next_message().is_none());
        assert!(matches!(
            peer.receive(1, vec![1], true, false).unwrap(),
            ReceiveAction::Deliver
        ));
        peer.delivered(1);
        assert_eq!(peer.next_message().unwrap().msgno, 2);
        peer.delivered(2);
        assert!(matches!(
            peer.receive(1, vec![1], true, false).unwrap(),
            ReceiveAction::Queued
        ));
        peer.complete_commit(peer.prepare_commit(), true);
        assert!(matches!(
            peer.receive(1, vec![1], true, false).unwrap(),
            ReceiveAction::Ack
        ));
        assert!(peer.receive(8, vec![1], true, false).is_err());
        assert!(peer.receive(3, vec![1; 5], true, false).is_err());
        assert!(peer.acknowledge(1).is_err());
    }
}
