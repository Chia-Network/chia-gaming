//! Transport rules run against an owned channel and an external host fixture.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use super::*;
use crate::peer_session::coordination::TerminalHandoff;
use crate::peer_session::{Message, PeerSession, ReceivePolicy, ReliableState};

struct TestChannel {
    established: Rc<Cell<bool>>,
    discarding: Rc<Cell<bool>>,
    completion_ok: Rc<Cell<bool>>,
    completion_attempts: Rc<Cell<usize>>,
}

impl Channel for TestChannel {
    fn status(&self) -> (bool, bool) {
        (self.established.get(), self.discarding.get())
    }
    fn deliver(&mut self, _body: &[u8]) -> Result<ChannelOutput, String> {
        Ok(ChannelOutput::default())
    }
    fn complete_terminal(&mut self) -> Result<ChannelOutput, String> {
        self.completion_attempts
            .set(self.completion_attempts.get() + 1);
        if !self.completion_ok.get() {
            return Err("completion failed".into());
        }
        Ok(ChannelOutput {
            terminal: true,
            ..Default::default()
        })
    }
}

struct Harness {
    peer: Session<TestChannel>,
    available: Cell<bool>,
    established: Rc<Cell<bool>>,
    discarding: Rc<Cell<bool>>,
    send_ok: Cell<bool>,
    completion_ok: Rc<Cell<bool>>,
    completion_attempts: Rc<Cell<usize>>,
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
        let established = Rc::new(Cell::new(false));
        let discarding = Rc::new(Cell::new(false));
        let completion_ok = Rc::new(Cell::new(true));
        let completion_attempts = Rc::new(Cell::new(0));
        let peer = Session::new(peer);
        *peer.channel.borrow_mut() = Some(TestChannel {
            established: established.clone(),
            discarding: discarding.clone(),
            completion_ok: completion_ok.clone(),
            completion_attempts: completion_attempts.clone(),
        });
        Self {
            peer,
            available: Cell::new(true),
            established,
            discarding,
            send_ok: Cell::new(true),
            completion_ok,
            completion_attempts,
            reply: Cell::new(false),
            fail_delivery: Cell::new(false),
            sent: RefCell::new(vec![]),
            acks: RefCell::new(vec![]),
            delivered: RefCell::new(vec![]),
            failures: RefCell::new(vec![]),
        }
    }
    fn data(&self, number: u64, body: &[u8]) -> bool {
        self.peer
            .receive(
                PeerInput::Data {
                    msgno: number,
                    body: body.to_vec(),
                },
                self,
            )
            .unwrap()
    }
    fn ack(&self, number: u64) {
        assert!(self
            .peer
            .receive(PeerInput::Ack { msgno: number }, self)
            .unwrap());
    }
    fn commit(&self, persisted: bool) {
        let commit = self.peer.state.borrow().prepare_commit();
        self.peer.complete_commit(commit, persisted, self).unwrap();
    }
    fn terminal(&self, restoring: bool) -> Result<(), String> {
        self.peer.channel_command(
            Some(TerminalCommand {
                id: "close".into(),
                message: b"close".to_vec(),
            }),
            restoring,
            self,
        )
    }
    fn assert_session_unborrowed(&self) {
        assert!(self.peer.state.try_borrow_mut().is_ok());
        assert!(self.peer.channel.try_borrow_mut().is_ok());
    }
    fn restored(&self) -> Self {
        let peer = self.peer.state.borrow();
        Self::restore(peer.state.clone(), peer.terminal_handoff.clone())
    }
}

impl PeerHost for Harness {
    fn send(&self, frame: SendFrame<'_>) -> Result<bool, String> {
        self.assert_session_unborrowed();
        match frame {
            SendFrame::Data { msgno, body } => self.sent.borrow_mut().push((msgno, body.to_vec())),
            SendFrame::Ack { msgno } => self.acks.borrow_mut().push(msgno),
        }
        Ok(self.send_ok.get())
    }
    fn status(&self) -> Result<HostStatus, String> {
        self.assert_session_unborrowed();
        Ok(HostStatus {
            available: self.available.get(),
            established: self.established.get(),
            discarding: self.discarding.get(),
        })
    }
    fn notify(&self, event: PeerEvent) -> Result<(), String> {
        self.assert_session_unborrowed();
        match event {
            PeerEvent::Message { msgno, body } => {
                if self.fail_delivery.get() {
                    return Err("invalid channel message".into());
                }
                self.delivered.borrow_mut().push((msgno, body));
                if self.reply.get() {
                    self.peer.send_message(b"reply".to_vec(), self)?;
                }
            }
            PeerEvent::Failure { reason } => self.failures.borrow_mut().push(reason),
            _ => {}
        }
        Ok(())
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
    assert!(h.peer.state.borrow().state.unacked_messages.is_empty());
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
    h.peer.consumer_ready(ReceiveMode::Raw, &h).unwrap();
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
        sender.peer.send_message(body.to_vec(), &sender).unwrap();
    }
    sender.commit(true);
    let receiver = Harness::new();
    receiver.data(1, b"a");
    receiver.data(3, b"c");
    receiver.commit(true);
    sender.ack(1);
    let sender = sender.restored();
    let receiver = receiver.restored();
    assert!(receiver.peer.state.borrow().reorder_queue.is_empty());
    sender
        .peer
        .connectivity("registered", 10000.0, false, &sender)
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
    assert_eq!(receiver.peer.state.borrow().state.remote_number, 3);
}

#[test]
fn failed_checkpoint_releases_only_its_capture_once_then_remains_dirty() {
    let h = Harness::new();
    h.reply.set(true);
    h.data(1, b"first");
    let captured = h.peer.state.borrow().prepare_commit();
    h.data(2, b"second");
    h.peer.complete_commit(captured.clone(), false, &h).unwrap();
    assert!(h.peer.state.borrow().dirty());
    assert_eq!(*h.sent.borrow(), vec![(1, b"reply".to_vec())]);
    assert_eq!(*h.acks.borrow(), vec![1]);
    h.peer.complete_commit(captured, true, &h).unwrap();
    assert_eq!(h.sent.borrow().len(), 1);
    assert_eq!(h.acks.borrow().len(), 1);
    assert!(h.peer.state.borrow().dirty());
    h.commit(true);
    assert_eq!(*h.acks.borrow(), vec![1, 2]);
    assert_eq!(h.sent.borrow().len(), 2);
    assert!(!h.peer.state.borrow().dirty());
}

#[test]
fn carrier_refusal_stops_replay_until_the_next_registration() {
    let h = Harness::new();
    h.peer.send_message(b"first".to_vec(), &h).unwrap();
    h.peer.send_message(b"second".to_vec(), &h).unwrap();
    h.commit(true);
    h.sent.borrow_mut().clear();
    h.send_ok.set(false);
    assert!(!h
        .peer
        .connectivity("registered", 10000.0, false, &h)
        .unwrap());
    assert_eq!(h.sent.borrow().len(), 1);
    h.send_ok.set(true);
    assert!(h
        .peer
        .connectivity("registered", 11000.0, false, &h)
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
    assert_eq!(h.peer.state.borrow().state.remote_number, 0);
    assert!(h.peer.state.borrow().reorder_queue.is_empty());
    h.commit(true);
    assert!(h.acks.borrow().is_empty());
}

#[test]
fn rejection_cancels_setup_but_fails_an_established_channel_and_is_ignored_on_chain() {
    let rejection = b"du4:typeu14:session_rejecte";
    let setup = Harness::new();
    setup
        .peer
        .consumer_ready(ReceiveMode::Channel, &setup)
        .unwrap();
    assert!(setup.data(1, rejection));
    assert_eq!(
        setup.peer.state.borrow().state.disposition,
        "inbound-reject"
    );
    assert!(setup.failures.borrow().is_empty());
    let active = Harness::new();
    active.established.set(true);
    active
        .peer
        .consumer_ready(ReceiveMode::Channel, &active)
        .unwrap();
    assert!(active.data(1, rejection));
    assert_eq!(
        *active.failures.borrow(),
        vec!["session_reject received after channel establishment"]
    );
    assert_eq!(active.peer.state.borrow().state.disposition, "active");
    let on_chain = Harness::new();
    on_chain.established.set(true);
    on_chain.discarding.set(true);
    on_chain
        .peer
        .consumer_ready(ReceiveMode::Channel, &on_chain)
        .unwrap();
    assert!(on_chain.data(1, rejection));
    on_chain.commit(true);
    assert_eq!(*on_chain.acks.borrow(), vec![1]);
    assert!(on_chain.failures.borrow().is_empty());
    assert_eq!(on_chain.peer.state.borrow().state.disposition, "active");
}

#[test]
fn terminal_handoff_waits_for_checkpoint_successful_send_and_ack() {
    let h = Harness::new();
    h.terminal(false).unwrap();
    h.ack(1);
    assert_eq!(h.completion_attempts.get(), 0);
    assert!(
        !h.peer
            .state
            .borrow()
            .terminal_handoff
            .as_ref()
            .unwrap()
            .sent
    );
    h.send_ok.set(false);
    h.commit(true);
    h.ack(1);
    assert_eq!(h.completion_attempts.get(), 0);
    assert!(
        !h.peer
            .state
            .borrow()
            .terminal_handoff
            .as_ref()
            .unwrap()
            .acknowledged
    );
    h.send_ok.set(true);
    h.peer
        .connectivity("registered", 10000.0, false, &h)
        .unwrap();
    assert_eq!(h.completion_attempts.get(), 0);
    h.ack(1);
    assert_eq!(h.completion_attempts.get(), 1);
    assert!(h.peer.state.borrow().terminal_handoff.is_none());
}

#[test]
fn terminal_restore_reuses_exact_frame_and_rejects_mismatched_commands() {
    let original = Harness::new();
    original.terminal(false).unwrap();
    original.commit(true);
    let h = original.restored();
    h.terminal(true).unwrap();
    assert_eq!(h.peer.state.borrow().state.message_number, 2);
    assert!(h.sent.borrow().is_empty());
    assert!(h
        .peer
        .channel_command(
            Some(TerminalCommand {
                id: "wrong".into(),
                message: b"close".to_vec()
            }),
            true,
            &h
        )
        .unwrap_err()
        .contains("does not match"));
    h.peer
        .connectivity("registered", 10000.0, false, &h)
        .unwrap();
    assert_eq!(*h.sent.borrow(), vec![(1, b"close".to_vec())]);
    h.ack(1);
    assert_eq!(h.completion_attempts.get(), 1);
    assert_eq!(h.peer.state.borrow().state.message_number, 2);
}

#[test]
fn ack_before_channel_restore_completes_after_attach_without_allocating_or_resending() {
    let original = Harness::new();
    original.terminal(false).unwrap();
    original.commit(true);
    let h = original.restored();
    let channel = h.peer.channel.borrow_mut().take();
    h.ack(1);
    assert_eq!(h.completion_attempts.get(), 0);
    assert!(
        h.peer
            .state
            .borrow()
            .terminal_handoff
            .as_ref()
            .unwrap()
            .acknowledged
    );
    *h.peer.channel.borrow_mut() = channel;
    h.terminal(true).unwrap();
    assert_eq!(h.completion_attempts.get(), 1);
    assert!(h.sent.borrow().is_empty());
    assert_eq!(h.peer.state.borrow().state.message_number, 2);
    assert!(h.peer.state.borrow().terminal_handoff.is_none());
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
            .state
            .borrow()
            .terminal_handoff
            .as_ref()
            .unwrap()
            .acknowledged
    );
    h.peer
        .state
        .borrow_mut()
        .channel_command(
            Some(TerminalCommand {
                id: "close".into(),
                message: b"close".to_vec(),
            }),
            true,
        )
        .unwrap();
    h.peer.consumer_ready(ReceiveMode::Channel, &h).unwrap();
    assert_eq!(h.completion_attempts.get(), 1);
    assert!(h.peer.state.borrow().terminal_handoff.is_none());
    assert_eq!(h.peer.state.borrow().state.message_number, 2);
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
            .state
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
    assert!(h.peer.state.borrow().terminal_handoff.is_none());
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

fn runtime() -> Session<()> {
    Session {
        state: RefCell::new(PeerSession::new(
            ReliableState {
                session_id: "00".repeat(16),
                message_number: 1,
                remote_number: 0,
                unacked_messages: vec![],
                disposition: "active".into(),
            },
            ReceivePolicy {
                max_future_reliable_msgno_gap: 100,
                max_queued_messages: 10,
                max_queued_bytes: 1024,
                max_peer_body_bytes: 1024,
            },
        )),
        channel: RefCell::new(None),
    }
}

#[test]
fn channel_output_stays_in_rust_and_close_precedes_ordinary_output() {
    let runtime = runtime();
    let drain = ManagerDrain {
        events: vec![
            GameSessionEvent::Log("before".into()),
            GameSessionEvent::OutboundMessage(b"ordinary".to_vec()),
            GameSessionEvent::Log("after".into()),
        ]
        .into(),
        ..Default::default()
    };
    let mut output = ChannelOutput {
        drain,
        command: Some(TerminalHandoffCommand {
            id: 1,
            message: b"close".to_vec(),
        }),
        ..Default::default()
    };
    runtime.collect_output(&mut output).unwrap();
    let session = runtime.state.borrow();
    assert_eq!(
        session
            .state
            .unacked_messages
            .iter()
            .map(|m| (m.msgno, m.msg.as_slice()))
            .collect::<Vec<_>>(),
        vec![(1, b"close".as_slice()), (2, b"ordinary".as_slice())]
    );
    assert_eq!(session.terminal_handoff.as_ref().unwrap().msgno, 1);
    assert!(session.dirty());
    let logs: Vec<_> = output
        .drain
        .events
        .iter()
        .map(|event| match event {
            GameSessionEvent::Log(message) => message.as_str(),
            _ => panic!("peer output leaked into the host projection"),
        })
        .collect();
    assert_eq!(logs, vec!["before", "after"]);
}

#[test]
fn terminal_channel_discards_pending_peer_work_and_preserves_host_output() {
    let runtime = runtime();
    runtime
        .state
        .borrow_mut()
        .channel_command(
            Some(TerminalCommand {
                id: "1".into(),
                message: b"close".to_vec(),
            }),
            false,
        )
        .unwrap();
    let drain = ManagerDrain {
        events: vec![
            GameSessionEvent::OutboundMessage(b"obsolete".to_vec()),
            GameSessionEvent::Log("terminal".into()),
        ]
        .into(),
        ..Default::default()
    };
    let mut output = ChannelOutput {
        drain,
        terminal: true,
        ..Default::default()
    };
    runtime.collect_output(&mut output).unwrap();
    let mut session = runtime.state.borrow_mut();
    assert!(session.terminal_handoff.is_none());
    assert!(session.state.unacked_messages.is_empty());
    let commit = session.prepare_commit();
    assert!(session.complete_commit(commit, true).outbound.is_empty());
    assert!(
        matches!(output.drain.events.front(), Some(GameSessionEvent::Log(message)) if message == "terminal")
    );
    assert_eq!(output.drain.events.len(), 1);
}

#[test]
fn on_chain_channel_does_not_allocate_peer_output() {
    let runtime = runtime();
    let drain = ManagerDrain {
        events: vec![GameSessionEvent::OutboundMessage(b"obsolete".to_vec())].into(),
        ..Default::default()
    };
    let mut output = ChannelOutput {
        drain,
        on_chain: true,
        ..Default::default()
    };
    runtime.collect_output(&mut output).unwrap();
    assert!(runtime.state.borrow().state.unacked_messages.is_empty());
    assert!(output.drain.events.is_empty());
}
