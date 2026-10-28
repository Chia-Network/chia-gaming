//! Execute complete peer-session turns. No session borrow spans a host call:
//! an application notification may synchronously generate an outbound message.

use std::cell::RefCell;

use serde::{Deserialize, Serialize};

use super::coordination::{application_message, HostStatus, ReceiveMode, TerminalCommand};
use super::{PeerSession, PreparedCommit, ReceiveAction};

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PeerInput {
    Data {
        msgno: u64,
        #[serde(deserialize_with = "receive_bytes")]
        body: Vec<u8>,
    },
    Ack {
        msgno: u64,
    },
    Keepalive,
}

// Internally tagged enum decoding buffers a JS Uint8Array as Serde bytes.
// Vec's sequence-only visitor does not accept that buffered representation.
fn receive_bytes<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
    struct Bytes;
    impl<'de> serde::de::Visitor<'de> for Bytes {
        type Value = Vec<u8>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("peer message bytes")
        }
        fn visit_bytes<E: serde::de::Error>(self, bytes: &[u8]) -> Result<Vec<u8>, E> {
            Ok(bytes.to_vec())
        }
        fn visit_byte_buf<E: serde::de::Error>(self, bytes: Vec<u8>) -> Result<Vec<u8>, E> {
            Ok(bytes)
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<u8>, A::Error> {
            let mut bytes = Vec::new();
            while let Some(byte) = seq.next_element()? {
                bytes.push(byte);
            }
            Ok(bytes)
        }
    }
    d.deserialize_bytes(Bytes)
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SendFrame<'a> {
    Data { msgno: u64, body: &'a [u8] },
    Ack { msgno: u64 },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PeerEvent {
    CommitRequested,
    Message { msgno: u64, body: Vec<u8> },
    Acknowledged { msgno: u64 },
    RejectionAcknowledged,
    TerminalAcknowledged,
    Keepalive,
    Committed,
    Failure { reason: String },
}

pub trait PeerHost {
    fn send(&self, frame: SendFrame<'_>) -> Result<bool, String>;
    fn status(&self) -> Result<HostStatus, String>;
    fn notify(&self, event: PeerEvent) -> Result<bool, String>;
}

pub struct PeerDriver<'a, H> {
    pub session: &'a RefCell<PeerSession>,
    pub host: H,
}

impl<H: PeerHost> PeerDriver<'_, H> {
    pub fn request_commit(&self) -> Result<(), String> {
        if self.session.borrow().dirty() {
            self.host.notify(PeerEvent::CommitRequested)?;
        }
        Ok(())
    }

    pub fn send_message(&self, body: Vec<u8>) -> Result<u64, String> {
        let disposition = self.session.borrow().state.disposition.clone();
        let msgno = self.session.borrow_mut().allocate(body, disposition)?;
        self.request_commit()?;
        Ok(msgno)
    }

    pub fn failure(&self, reason: String) -> Result<(), String> {
        {
            let mut session = self.session.borrow_mut();
            session.reorder_queue.clear();
            if session.receive_mode == ReceiveMode::Channel {
                session.failed = true;
            }
        }
        self.host.notify(PeerEvent::Failure { reason }).map(|_| ())
    }

    pub fn receive(&self, input: PeerInput) -> Result<bool, String> {
        match input {
            PeerInput::Data { msgno, body } => self.receive_data(msgno, body),
            PeerInput::Ack { msgno } => self.receive_ack(msgno),
            PeerInput::Keepalive => {
                self.host.notify(PeerEvent::Keepalive)?;
                let acks = self.session.borrow().retry_acks();
                for msgno in acks {
                    self.send_ack(msgno)?;
                }
                Ok(true)
            }
        }
    }

    fn receive_data(&self, msgno: u64, body: Vec<u8>) -> Result<bool, String> {
        match self.receive_data_inner(msgno, body) {
            Ok(()) => Ok(true),
            Err(reason) => {
                self.failure(reason)?;
                Ok(false)
            }
        }
    }

    fn receive_data_inner(&self, msgno: u64, body: Vec<u8>) -> Result<(), String> {
        let candidate = self
            .session
            .borrow()
            .delivery_candidate(msgno, body.len())?;
        let ready = candidate != "duplicate" && self.available()?;
        let deliverable =
            ready && candidate == "next" && self.session.borrow().deliverable(msgno, &body);
        let terminal =
            ready && candidate == "future" && self.session.borrow().terminal_message(&body);
        let action =
            self.session
                .borrow_mut()
                .receive(msgno, body.clone(), deliverable, terminal)?;
        match action {
            ReceiveAction::Ack => {
                self.host.send(SendFrame::Ack { msgno })?;
            }
            ReceiveAction::Deliver => self.deliver(msgno, &body)?,
            ReceiveAction::Queued => {}
        }
        self.request_commit()?;
        if candidate != "duplicate" {
            self.drain_contiguous()?;
        }
        Ok(())
    }

    fn available(&self) -> Result<bool, String> {
        let status = self.host.status()?;
        Ok(self.session.borrow().available(&status))
    }

    fn deliver(&self, msgno: u64, body: &[u8]) -> Result<(), String> {
        let mode = self.session.borrow().receive_mode;
        let kind = application_message(body);
        match mode {
            ReceiveMode::Raw => {
                self.host.notify(PeerEvent::Message {
                    msgno,
                    body: body.to_vec(),
                })?;
            }
            ReceiveMode::Retiring => {}
            ReceiveMode::Rejection => {
                if msgno == 1 && kind.as_deref() == Some("session_proposal") {
                    self.session.borrow_mut().proposal_received()?;
                    self.request_commit()?;
                }
            }
            ReceiveMode::Proposal | ReceiveMode::Channel => {
                let status = self.host.status()?;
                if mode == ReceiveMode::Channel && status.discarding {
                    // The old channel consumer acknowledged but ignored these messages.
                } else if kind.as_deref() == Some("session_reject") {
                    if mode == ReceiveMode::Channel && status.established {
                        self.failure("session_reject received after channel establishment".into())?;
                    } else {
                        self.session.borrow_mut().reject_inbound();
                        self.request_commit()?;
                    }
                } else if mode == ReceiveMode::Proposal {
                    if msgno != 1 || kind.as_deref() != Some("session_proposal") {
                        return Err("initial reliable message is not a session proposal".into());
                    }
                    self.session.borrow_mut().proposal_received()?;
                    self.host.notify(PeerEvent::Message {
                        msgno,
                        body: body.to_vec(),
                    })?;
                } else {
                    self.host.notify(PeerEvent::Message {
                        msgno,
                        body: body.to_vec(),
                    })?;
                }
            }
        }
        self.session.borrow_mut().delivered(msgno);
        self.request_commit()
    }

    fn drain_contiguous(&self) -> Result<(), String> {
        while self.available()? {
            let Some(message) = self.session.borrow().next_message() else {
                break;
            };
            if !self
                .session
                .borrow()
                .deliverable(message.msgno, &message.msg)
            {
                break;
            }
            self.session
                .borrow_mut()
                .reorder_queue
                .remove(&message.msgno);
            self.deliver(message.msgno, &message.msg)?;
        }
        Ok(())
    }

    pub fn consumer_ready(&self, mode: ReceiveMode) -> Result<(), String> {
        self.session.borrow_mut().receive_mode = mode;
        let obsolete: Vec<_> = {
            let session = self.session.borrow();
            session
                .reorder_queue
                .keys()
                .copied()
                .filter(|n| *n <= session.state.remote_number)
                .collect()
        };
        for msgno in obsolete {
            self.session.borrow_mut().reorder_queue.remove(&msgno);
            self.host.send(SendFrame::Ack { msgno })?;
        }
        if let Err(reason) = self.drain_contiguous() {
            self.failure(reason)?;
        }
        Ok(())
    }

    fn receive_ack(&self, msgno: u64) -> Result<bool, String> {
        let result = (|| {
            self.session.borrow_mut().acknowledge(msgno)?;
            self.request_commit()?;
            let terminal = {
                let mut session = self.session.borrow_mut();
                if let Some(binding) = &mut session.terminal_handoff {
                    if binding.sent && msgno >= binding.msgno {
                        binding.acknowledged = true;
                        true
                    } else {
                        false
                    }
                } else {
                    false
                }
            };
            if terminal {
                self.complete_terminal()?;
            }
            if self.session.borrow().rejection_complete() {
                self.host.notify(PeerEvent::RejectionAcknowledged)?;
            }
            if self.session.borrow().receive_mode == ReceiveMode::Raw {
                self.host.notify(PeerEvent::Acknowledged { msgno })?;
            }
            Ok(())
        })();
        if let Err(reason) = result {
            self.failure(reason)?;
            return Ok(false);
        }
        Ok(true)
    }

    pub fn channel_command(
        &self,
        command: Option<TerminalCommand>,
        restoring: bool,
    ) -> Result<(), String> {
        self.session
            .borrow_mut()
            .channel_command(command, restoring)?;
        self.request_commit()?;
        let acknowledged = self
            .session
            .borrow()
            .terminal_handoff
            .as_ref()
            .is_some_and(|b| b.acknowledged);
        if acknowledged {
            self.complete_terminal()?;
        }
        Ok(())
    }

    fn complete_terminal(&self) -> Result<(), String> {
        if self.host.notify(PeerEvent::TerminalAcknowledged)? {
            self.session.borrow_mut().terminal_handoff = None;
        }
        Ok(())
    }

    fn send_data(&self, msgno: u64, body: &[u8]) -> Result<bool, String> {
        let accepted = self.host.send(SendFrame::Data { msgno, body })?;
        let terminal_sent = {
            let mut session = self.session.borrow_mut();
            session.sent(msgno, accepted);
            if let Some(binding) = &mut session.terminal_handoff {
                if accepted && binding.msgno == msgno {
                    binding.sent = true;
                    true
                } else {
                    false
                }
            } else {
                false
            }
        };
        // The aggregate checkpoint records terminal send observations too.
        if terminal_sent {
            self.host.notify(PeerEvent::CommitRequested)?;
        }
        Ok(accepted)
    }

    fn send_ack(&self, msgno: u64) -> Result<(), String> {
        let accepted = self.host.send(SendFrame::Ack { msgno })?;
        self.session.borrow_mut().ack_sent(msgno, accepted);
        Ok(())
    }

    pub fn connectivity(&self, event: &str, now: f64, force: bool) -> Result<bool, String> {
        let Some(messages) = self.session.borrow_mut().connectivity(event, now, force)? else {
            return Ok(false);
        };
        for message in messages {
            if !self.send_data(message.msgno, &message.msg)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn complete_commit(&self, commit: PreparedCommit, persisted: bool) -> Result<(), String> {
        let frames = self.session.borrow_mut().complete_commit(commit, persisted);
        for message in frames.outbound {
            self.send_data(message.msgno, &message.msg)?;
        }
        for msgno in frames.acks {
            self.send_ack(msgno)?;
        }
        if persisted {
            self.host.notify(PeerEvent::Committed)?;
        }
        Ok(())
    }
}
