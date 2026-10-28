//! Transport rules are tested at their Rust boundary. The host is an internal
//! channel/carrier fixture, not a TypeScript message-forwarding implementation.
use std::cell::Cell;

use super::*;
use crate::peer_session::coordination::TerminalHandoff;
use crate::peer_session::{Message, ReceivePolicy, ReliableState};

struct Harness {
    peer: RefCell<PeerSession>,
    available: Cell<bool>,
    established: Cell<bool>,
    discarding: Cell<bool>,
    send_ok: Cell<bool>,
    channel_loaded: Cell<bool>,
    completion_ok: Cell<bool>,
    completion_attempts: Cell<usize>,
    reply: Cell<bool>,
    fail_delivery: Cell<bool>,
    sent: RefCell<Vec<(u64, Vec<u8>)>>,
    acks: RefCell<Vec<u64>>,
    delivered: RefCell<Vec<(u64, Vec<u8>)>>,
    failures: RefCell<Vec<String>>,
}

impl Harness {
    fn new() -> Self {
        Self::restore(
            ReliableState {
                session_id: "00".repeat(16),
                message_number: 1,
                remote_number: 0,
                unacked_messages: vec![],
                disposition: "active".into(),
            },
            None,
        )
    }
    fn restore(state: ReliableState, binding: Option<TerminalHandoff>) -> Self {
        let mut peer = PeerSession::new(
            state,
            ReceivePolicy {
                max_future_reliable_msgno_gap: 100,
                max_queued_messages: 10,
                max_queued_bytes: 1024,
                max_peer_body_bytes: 1024,
            },
        );
        peer.restore_terminal(binding).unwrap();
        Self {
            peer: RefCell::new(peer),
            available: Cell::new(true),
            established: Cell::new(false),
            discarding: Cell::new(false),
            send_ok: Cell::new(true),
            channel_loaded: Cell::new(true),
            completion_ok: Cell::new(true),
            completion_attempts: Cell::new(0),
            reply: Cell::new(false),
            fail_delivery: Cell::new(false),
            sent: RefCell::new(vec![]),
            acks: RefCell::new(vec![]),
            delivered: RefCell::new(vec![]),
            failures: RefCell::new(vec![]),
        }
    }
    fn driver(&self) -> PeerDriver<'_, &Self> {
        PeerDriver {
            session: &self.peer,
            host: self,
        }
    }
    fn data(&self, number: u64, body: &[u8]) -> bool {
        self.driver()
            .receive(PeerInput::Data {
                msgno: number,
                body: body.to_vec(),
            })
            .unwrap()
    }
    fn ack(&self, number: u64) {
        assert!(self
            .driver()
            .receive(PeerInput::Ack { msgno: number })
            .unwrap());
    }
    fn commit(&self, persisted: bool) {
        let commit = self.peer.borrow().prepare_commit();
        self.driver().complete_commit(commit, persisted).unwrap();
    }
    fn terminal(&self, restoring: bool) -> Result<(), String> {
        self.driver().channel_command(
            Some(TerminalCommand {
                id: "close".into(),
                message: b"close".to_vec(),
            }),
            restoring,
        )
    }
    fn restored(&self) -> Self {
        let peer = self.peer.borrow();
        Self::restore(peer.state.clone(), peer.terminal_handoff.clone())
    }
}

impl PeerHost for &Harness {
    fn send(&self, frame: SendFrame<'_>) -> Result<bool, String> {
        match frame {
            SendFrame::Data { msgno, body } => self.sent.borrow_mut().push((msgno, body.to_vec())),
            SendFrame::Ack { msgno } => self.acks.borrow_mut().push(msgno),
        }
        Ok(self.send_ok.get())
    }
    fn status(&self) -> Result<HostStatus, String> {
        Ok(HostStatus {
            available: self.available.get(),
            established: self.established.get(),
            discarding: self.discarding.get(),
        })
    }
    fn notify(&self, event: PeerEvent) -> Result<bool, String> {
        match event {
            PeerEvent::Message { msgno, body } => {
                if self.fail_delivery.get() {
                    return Err("invalid channel message".into());
                }
                self.delivered.borrow_mut().push((msgno, body));
                if self.reply.get() {
                    self.driver().send_message(b"reply".to_vec())?;
                }
            }
            PeerEvent::TerminalAcknowledged => {
                if !self.channel_loaded.get() {
                    return Ok(false);
                }
                self.completion_attempts
                    .set(self.completion_attempts.get() + 1);
                return Ok(self.completion_ok.get());
            }
            PeerEvent::Failure { reason } => self.failures.borrow_mut().push(reason),
            _ => {}
        }
        Ok(false)
    }
}

#[test]
fn ordered_delivery_deduplicates_and_checkpoints_reentrant_replies_and_acks() {
    let h = Harness::new();
    h.reply.set(true);
    for (n, body) in [(3, b"c"), (3, b"c"), (1, b"a"), (2, b"b"), (2, b"b")] {
        assert!(h.data(n, body));
    }
    assert_eq!(
        *h.delivered.borrow(),
        vec![(1, b"a".to_vec()), (2, b"b".to_vec()), (3, b"c".to_vec())]
    );
    assert!(h.sent.borrow().is_empty());
    assert!(h.acks.borrow().is_empty());
    h.commit(true);
    assert_eq!(
        *h.sent.borrow(),
        vec![
            (1, b"reply".to_vec()),
            (2, b"reply".to_vec()),
            (3, b"reply".to_vec())
        ]
    );
    assert_eq!(*h.acks.borrow(), vec![1, 2, 3]);
    h.data(2, b"b");
    assert_eq!(
        h.sent.borrow().len(),
        3,
        "duplicate input must not retransmit outbound traffic"
    );
    assert_eq!(*h.acks.borrow(), vec![1, 2, 3, 2]);
    h.ack(3);
    assert!(h.peer.borrow().state.unacked_messages.is_empty());
}

#[test]
fn readiness_releases_buffered_input_in_order() {
    let h = Harness::new();
    h.available.set(false);
    h.data(3, b"c");
    h.data(1, b"a");
    h.data(2, b"b");
    assert!(h.delivered.borrow().is_empty());
    h.available.set(true);
    h.driver().consumer_ready(ReceiveMode::Raw).unwrap();
    assert_eq!(
        h.delivered
            .borrow()
            .iter()
            .map(|(n, _)| *n)
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert!(h.acks.borrow().is_empty());
    h.commit(true);
    assert_eq!(*h.acks.borrow(), vec![1, 2, 3]);
}

#[test]
fn reload_reconstructs_receive_gap_from_the_original_sender_journal() {
    let sender = Harness::new();
    for body in [b"a", b"b", b"c"] {
        sender.driver().send_message(body.to_vec()).unwrap();
    }
    sender.commit(true);
    let receiver = Harness::new();
    receiver.data(1, b"a");
    receiver.data(3, b"c");
    receiver.commit(true);
    sender.ack(1);
    let sender = sender.restored();
    let receiver = receiver.restored();
    assert!(receiver.peer.borrow().reorder_queue.is_empty());
    sender
        .driver()
        .connectivity("registered", 10000.0, false)
        .unwrap();
    assert_eq!(
        *sender.sent.borrow(),
        vec![(2, b"b".to_vec()), (3, b"c".to_vec())]
    );
    for (n, body) in sender.sent.borrow().iter() {
        receiver.data(*n, body);
    }
    assert_eq!(
        *receiver.delivered.borrow(),
        vec![(2, b"b".to_vec()), (3, b"c".to_vec())]
    );
    assert_eq!(receiver.peer.borrow().state.remote_number, 3);
}

#[test]
fn failed_checkpoint_releases_only_its_capture_once_then_remains_dirty() {
    let h = Harness::new();
    h.reply.set(true);
    h.data(1, b"first");
    let captured = h.peer.borrow().prepare_commit();
    h.data(2, b"second");
    h.driver().complete_commit(captured.clone(), false).unwrap();
    assert!(h.peer.borrow().dirty());
    assert_eq!(*h.sent.borrow(), vec![(1, b"reply".to_vec())]);
    assert_eq!(*h.acks.borrow(), vec![1]);
    h.driver().complete_commit(captured, true).unwrap();
    assert_eq!(h.sent.borrow().len(), 1);
    assert_eq!(h.acks.borrow().len(), 1);
    assert!(h.peer.borrow().dirty());
    h.commit(true);
    assert_eq!(*h.acks.borrow(), vec![1, 2]);
    assert_eq!(h.sent.borrow().len(), 2);
    assert!(!h.peer.borrow().dirty());
}

#[test]
fn carrier_refusal_stops_replay_until_the_next_registration() {
    let h = Harness::new();
    h.driver().send_message(b"first".to_vec()).unwrap();
    h.driver().send_message(b"second".to_vec()).unwrap();
    h.commit(true);
    h.sent.borrow_mut().clear();
    h.send_ok.set(false);
    assert!(!h
        .driver()
        .connectivity("registered", 10000.0, false)
        .unwrap());
    assert_eq!(h.sent.borrow().len(), 1);
    h.send_ok.set(true);
    assert!(h
        .driver()
        .connectivity("registered", 11000.0, false)
        .unwrap());
    assert_eq!(
        h.sent.borrow().iter().map(|(n, _)| *n).collect::<Vec<_>>(),
        vec![1, 1, 2]
    );
}

#[test]
fn failed_channel_delivery_discards_the_receive_gap_without_acknowledging_it() {
    let h = Harness::new();
    h.data(2, b"future");
    h.fail_delivery.set(true);
    assert!(!h.data(1, b"bad"));
    assert_eq!(*h.failures.borrow(), vec!["invalid channel message"]);
    assert_eq!(h.peer.borrow().state.remote_number, 0);
    assert!(h.peer.borrow().reorder_queue.is_empty());
    h.commit(true);
    assert!(h.acks.borrow().is_empty());
}

#[test]
fn rejection_cancels_setup_but_fails_an_established_channel_and_is_ignored_on_chain() {
    let rejection = b"du4:typeu14:session_rejecte";
    let setup = Harness::new();
    setup.driver().consumer_ready(ReceiveMode::Channel).unwrap();
    assert!(setup.data(1, rejection));
    assert_eq!(setup.peer.borrow().state.disposition, "inbound-reject");
    assert!(setup.failures.borrow().is_empty());
    let active = Harness::new();
    active.established.set(true);
    active
        .driver()
        .consumer_ready(ReceiveMode::Channel)
        .unwrap();
    assert!(active.data(1, rejection));
    assert_eq!(
        *active.failures.borrow(),
        vec!["session_reject received after channel establishment"]
    );
    assert_eq!(active.peer.borrow().state.disposition, "active");
    let on_chain = Harness::new();
    on_chain.established.set(true);
    on_chain.discarding.set(true);
    on_chain
        .driver()
        .consumer_ready(ReceiveMode::Channel)
        .unwrap();
    assert!(on_chain.data(1, rejection));
    on_chain.commit(true);
    assert_eq!(*on_chain.acks.borrow(), vec![1]);
    assert!(on_chain.failures.borrow().is_empty());
    assert_eq!(on_chain.peer.borrow().state.disposition, "active");
}

#[test]
fn terminal_handoff_waits_for_checkpoint_successful_send_and_ack() {
    let h = Harness::new();
    h.terminal(false).unwrap();
    h.ack(1);
    assert_eq!(h.completion_attempts.get(), 0);
    assert!(!h.peer.borrow().terminal_handoff.as_ref().unwrap().sent);
    h.send_ok.set(false);
    h.commit(true);
    h.ack(1);
    assert_eq!(h.completion_attempts.get(), 0);
    assert!(
        !h.peer
            .borrow()
            .terminal_handoff
            .as_ref()
            .unwrap()
            .acknowledged
    );
    h.send_ok.set(true);
    h.driver()
        .connectivity("registered", 10000.0, false)
        .unwrap();
    assert_eq!(h.completion_attempts.get(), 0);
    h.ack(1);
    assert_eq!(h.completion_attempts.get(), 1);
    assert!(h.peer.borrow().terminal_handoff.is_none());
}

#[test]
fn terminal_restore_reuses_exact_frame_and_rejects_mismatched_commands() {
    let original = Harness::new();
    original.terminal(false).unwrap();
    original.commit(true);
    let h = original.restored();
    h.terminal(true).unwrap();
    assert_eq!(h.peer.borrow().state.message_number, 2);
    assert!(h.sent.borrow().is_empty());
    assert!(h
        .driver()
        .channel_command(
            Some(TerminalCommand {
                id: "wrong".into(),
                message: b"close".to_vec()
            }),
            true
        )
        .unwrap_err()
        .contains("does not match"));
    h.driver()
        .connectivity("registered", 10000.0, false)
        .unwrap();
    assert_eq!(*h.sent.borrow(), vec![(1, b"close".to_vec())]);
    h.ack(1);
    assert_eq!(h.completion_attempts.get(), 1);
    assert_eq!(h.peer.borrow().state.message_number, 2);
}

#[test]
fn ack_before_channel_restore_completes_after_attach_without_allocating_or_resending() {
    let original = Harness::new();
    original.terminal(false).unwrap();
    original.commit(true);
    let h = original.restored();
    h.channel_loaded.set(false);
    h.ack(1);
    assert_eq!(h.completion_attempts.get(), 0);
    assert!(
        h.peer
            .borrow()
            .terminal_handoff
            .as_ref()
            .unwrap()
            .acknowledged
    );
    h.channel_loaded.set(true);
    h.terminal(true).unwrap();
    assert_eq!(h.completion_attempts.get(), 1);
    assert!(h.sent.borrow().is_empty());
    assert_eq!(h.peer.borrow().state.message_number, 2);
    assert!(h.peer.borrow().terminal_handoff.is_none());
}

#[test]
fn failed_terminal_completion_survives_reload_and_retries_on_readiness() {
    let original = Harness::new();
    original.terminal(false).unwrap();
    original.commit(true);
    original.completion_ok.set(false);
    original.ack(1);
    assert_eq!(original.completion_attempts.get(), 1);
    let h = original.restored();
    assert!(
        h.peer
            .borrow()
            .terminal_handoff
            .as_ref()
            .unwrap()
            .acknowledged
    );
    h.peer
        .borrow_mut()
        .channel_command(
            Some(TerminalCommand {
                id: "close".into(),
                message: b"close".to_vec(),
            }),
            true,
        )
        .unwrap();
    h.driver().consumer_ready(ReceiveMode::Channel).unwrap();
    assert_eq!(h.completion_attempts.get(), 1);
    assert!(h.peer.borrow().terminal_handoff.is_none());
    assert_eq!(h.peer.borrow().state.message_number, 2);
    assert!(h.sent.borrow().is_empty());
}

#[test]
fn repeated_ack_retries_failed_completion_without_resending_close() {
    let h = Harness::new();
    h.terminal(false).unwrap();
    h.commit(true);
    h.completion_ok.set(false);
    h.ack(1);
    assert!(
        h.peer
            .borrow()
            .terminal_handoff
            .as_ref()
            .unwrap()
            .acknowledged
    );
    h.completion_ok.set(true);
    h.ack(1);
    assert_eq!(h.completion_attempts.get(), 2);
    assert_eq!(*h.sent.borrow(), vec![(1, b"close".to_vec())]);
    assert!(h.peer.borrow().terminal_handoff.is_none());
}

#[test]
fn acknowledged_restore_requires_a_sent_frame_absent_from_the_replay_journal() {
    let h = Harness::restore(
        ReliableState {
            session_id: "00".repeat(16),
            message_number: 2,
            remote_number: 0,
            unacked_messages: vec![Message {
                msgno: 1,
                msg: b"close".to_vec(),
            }],
            disposition: "active".into(),
        },
        Some(TerminalHandoff {
            id: "close".into(),
            message: b"close".to_vec(),
            msgno: 1,
            sent: true,
            acknowledged: true,
        }),
    );
    assert!(h
        .terminal(true)
        .unwrap_err()
        .contains("inconsistent transport state"));
}
