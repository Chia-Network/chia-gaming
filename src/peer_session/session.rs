//! One session owns reliable delivery and its optional channel. Channel calls
//! return native output; host callbacks run only after these borrows end.
use serde::{Deserialize, Serialize};
use std::cell::RefCell;

use super::coordination::{
    application_message, HostStatus, ReceiveMode, TerminalCommand, TerminalHandoff,
};
use super::{
    PreparedCommit, ReceiveAction, ReceivePolicy, ReliableState, SessionState, SessionTerms,
    SetupState,
};
use crate::game_session::TerminalHandoffCommand;
use crate::session_phases::effects::GameSessionEvent;
use crate::transaction_manager::ManagerDrain;

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
    Message {
        msgno: u64,
        body: Vec<u8>,
    },
    Acknowledged {
        msgno: u64,
    },
    RejectionAcknowledged,
    #[serde(skip)]
    ChannelResult(ChannelOutput),
    Error {
        reason: String,
    },
    Keepalive,
    Committed,
    Failure {
        reason: String,
    },
}

pub trait PeerHost {
    fn send(&self, frame: SendFrame<'_>) -> Result<bool, String>;
    fn status(&self) -> Result<HostStatus, String>;
    fn notify(&self, event: PeerEvent) -> Result<(), String>;
}

#[derive(Default)]
pub struct ChannelOutput {
    pub drain: ManagerDrain,
    pub command: Option<TerminalHandoffCommand>,
    pub terminal: bool,
    pub on_chain: bool,
    pub action_succeeded: bool,
}

pub trait Channel {
    fn status(&self) -> (bool, bool);
    fn deliver(&mut self, body: &[u8]) -> Result<ChannelOutput, String>;
    fn complete_terminal(&mut self) -> Result<ChannelOutput, String>;
}

pub struct Session<C> {
    state: RefCell<SessionState>,
    pub channel: RefCell<Option<C>>,
}

impl<C> Session<C> {
    pub fn new(state: ReliableState, policy: ReceivePolicy) -> Self {
        Self {
            state: RefCell::new(SessionState::new(state, policy)),
            channel: RefCell::new(None),
        }
    }

    pub fn snapshot<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Snapshot<'a> {
            #[serde(flatten)]
            state: &'a ReliableState,
            terminal_handoff: &'a Option<TerminalHandoff>,
            rejection_complete: bool,
        }
        let session = self.state.borrow();
        Snapshot {
            state: &session.state,
            terminal_handoff: &session.terminal_handoff,
            rejection_complete: session.rejection_complete(),
        }
        .serialize(serializer)
    }

    pub fn restore(
        &self,
        state: ReliableState,
        terminal: Option<TerminalHandoff>,
    ) -> Result<(), String> {
        let mut session = self.state.borrow_mut();
        session.state = state;
        session.restore_terminal(terminal)
    }

    pub fn accepted(&self) -> bool {
        matches!(
            self.state.borrow().setup,
            Some(SetupState::WaitingForWalletAddress { .. } | SetupState::ChannelStarted)
        )
    }

    pub fn retired(&self) -> bool {
        matches!(self.state.borrow().setup, Some(SetupState::Retired))
    }

    pub fn accept_session(&self, terms: SessionTerms, initiator: bool) -> Result<(), String> {
        self.state.borrow_mut().accept(terms, initiator)
    }

    pub fn prepare_channel(&self, terms: SessionTerms, initiator: bool) -> Result<(), String> {
        self.state.borrow_mut().prepare_channel(terms, initiator)
    }

    pub fn channel_terms(&self) -> Result<(SessionTerms, bool), String> {
        match &self.state.borrow().setup {
            Some(SetupState::WaitingForWalletAddress { terms, initiator }) => {
                Ok((terms.clone(), *initiator))
            }
            _ => Err("peer session is not waiting for a wallet address".into()),
        }
    }

    pub fn attach_channel(
        &self,
        channel: C,
        command: Option<TerminalCommand>,
    ) -> Result<(), String> {
        if self.channel.borrow().is_some() {
            return Err("peer session already owns a channel".into());
        }
        self.state.borrow_mut().channel_command(command, true)?;
        *self.channel.borrow_mut() = Some(channel);
        Ok(())
    }

    /// Retire the channel consumer, optionally preserving its reliable rejection
    /// for the application-owned tombstone transport.
    pub fn retire(&self, retain_rejection: bool) -> bool {
        self.channel.borrow_mut().take();
        let mut session = self.state.borrow_mut();
        session.terminal_handoff = None;
        session.reorder_queue.clear();
        session.setup = Some(SetupState::Retired);
        if retain_rejection && session.state.disposition == "outbound-reject" {
            return true;
        }
        session.state.unacked_messages.clear();
        session.clear_runtime();
        session.setup = Some(SetupState::Retired);
        false
    }

    pub fn dirty(&self) -> bool {
        self.state.borrow().dirty()
    }

    pub fn prepare_commit(&self) -> PreparedCommit {
        self.state.borrow().prepare_commit()
    }

    pub fn collect_output(&self, output: &mut ChannelOutput) -> Result<(), String> {
        let mut session = self.state.borrow_mut();
        if output.terminal {
            session.terminal_handoff = None;
            session.state.unacked_messages.clear();
            session.reorder_queue.clear();
            session.discard_outbound();
        }
        if let Some(command) = output.command.take() {
            if session.terminal_handoff.is_none() {
                session.channel_command(
                    Some(TerminalCommand {
                        id: command.id.to_string(),
                        message: command.message,
                    }),
                    false,
                )?;
            }
        }
        let mut projected = std::collections::VecDeque::new();
        for event in output.drain.events.drain(..) {
            if let GameSessionEvent::OutboundMessage(body) = event {
                if !output.terminal && !output.on_chain {
                    let disposition = session.state.disposition.clone();
                    session.allocate(body, disposition)?;
                }
            } else {
                projected.push_back(event);
            }
        }
        output.drain.events = projected;
        Ok(())
    }
}

impl<C: Channel> Session<C> {
    pub fn reject_session(&self, host: &impl PeerHost) -> Result<(), String> {
        self.state.borrow_mut().reject_session()?;
        self.request_commit(host)
    }

    pub fn request_commit(&self, host: &impl PeerHost) -> Result<(), String> {
        if self.state.borrow().dirty() {
            host.notify(PeerEvent::CommitRequested)?;
        }
        Ok(())
    }

    pub fn send_message(&self, body: Vec<u8>, host: &impl PeerHost) -> Result<u64, String> {
        let disposition = self.state.borrow().state.disposition.clone();
        let msgno = self.state.borrow_mut().allocate(body, disposition)?;
        self.request_commit(host)?;
        Ok(msgno)
    }

    pub fn failure(&self, reason: String, host: &impl PeerHost) -> Result<(), String> {
        {
            let mut session = self.state.borrow_mut();
            session.reorder_queue.clear();
            if session.receive_mode == ReceiveMode::Channel {
                session.failed = true;
            }
        }
        host.notify(PeerEvent::Failure { reason })
    }

    pub fn receive(&self, input: PeerInput, host: &impl PeerHost) -> Result<bool, String> {
        match input {
            PeerInput::Data { msgno, body } => self.receive_data(msgno, body, host),
            PeerInput::Ack { msgno } => self.receive_ack(msgno, host),
            PeerInput::Keepalive => {
                host.notify(PeerEvent::Keepalive)?;
                let acks = self.state.borrow().retry_acks();
                for msgno in acks {
                    self.send_ack(msgno, host)?;
                }
                Ok(true)
            }
        }
    }

    fn receive_data(
        &self,
        msgno: u64,
        body: Vec<u8>,
        host: &impl PeerHost,
    ) -> Result<bool, String> {
        match self.receive_data_inner(msgno, body, host) {
            Ok(()) => Ok(true),
            Err(reason) => {
                self.failure(reason, host)?;
                Ok(false)
            }
        }
    }

    fn receive_data_inner(
        &self,
        msgno: u64,
        body: Vec<u8>,
        host: &impl PeerHost,
    ) -> Result<(), String> {
        let candidate = self.state.borrow().delivery_candidate(msgno, body.len())?;
        let ready = candidate != "duplicate" && self.available(host)?;
        let deliverable =
            ready && candidate == "next" && self.state.borrow().deliverable(msgno, &body);
        let terminal =
            ready && candidate == "future" && self.state.borrow().terminal_message(&body);
        let action = self
            .state
            .borrow_mut()
            .receive(msgno, body.clone(), deliverable, terminal)?;
        match action {
            ReceiveAction::Ack => {
                host.send(SendFrame::Ack { msgno })?;
            }
            ReceiveAction::Deliver => self.deliver(msgno, &body, host)?,
            ReceiveAction::Queued => {}
        }
        self.request_commit(host)?;
        if candidate != "duplicate" {
            self.drain_contiguous(host)?;
        }
        Ok(())
    }

    fn status(&self, host: &impl PeerHost) -> Result<HostStatus, String> {
        let status = host.status()?;
        if self.state.borrow().receive_mode != ReceiveMode::Channel {
            return Ok(status);
        }
        let channel = self.channel.borrow();
        let (established, discarding) = channel.as_ref().map_or((false, false), Channel::status);
        Ok(HostStatus {
            available: status.available && channel.is_some(),
            established,
            discarding,
        })
    }

    fn available(&self, host: &impl PeerHost) -> Result<bool, String> {
        let status = self.status(host)?;
        Ok(self.state.borrow().available(&status))
    }

    fn deliver(&self, msgno: u64, body: &[u8], host: &impl PeerHost) -> Result<(), String> {
        let mode = self.state.borrow().receive_mode;
        let kind = application_message(body);
        match mode {
            ReceiveMode::Raw => {
                host.notify(PeerEvent::Message {
                    msgno,
                    body: body.to_vec(),
                })?;
            }
            ReceiveMode::Retiring => {}
            ReceiveMode::Rejection => {
                if msgno == 1 && kind.as_deref() == Some("session_proposal") {
                    self.state.borrow_mut().proposal_received()?;
                    self.request_commit(host)?;
                }
            }
            ReceiveMode::Proposal | ReceiveMode::Channel => {
                let status = self.status(host)?;
                if mode == ReceiveMode::Channel && status.discarding {
                    // The old channel consumer acknowledged but ignored these messages.
                } else if kind.as_deref() == Some("session_reject") {
                    if mode == ReceiveMode::Channel && status.established {
                        self.failure(
                            "session_reject received after channel establishment".into(),
                            host,
                        )?;
                    } else {
                        self.state.borrow_mut().reject_inbound();
                        self.request_commit(host)?;
                    }
                } else if mode == ReceiveMode::Proposal {
                    if msgno != 1 || kind.as_deref() != Some("session_proposal") {
                        return Err("initial reliable message is not a session proposal".into());
                    }
                    self.state.borrow_mut().proposal_received()?;
                    host.notify(PeerEvent::Message {
                        msgno,
                        body: body.to_vec(),
                    })?;
                } else {
                    let mut output = self
                        .channel
                        .borrow_mut()
                        .as_mut()
                        .ok_or("accepted session has no channel")?
                        .deliver(body)?;
                    self.collect_output(&mut output)?;
                    host.notify(PeerEvent::ChannelResult(output))?;
                }
            }
        }
        self.state.borrow_mut().delivered(msgno);
        self.request_commit(host)
    }

    fn drain_contiguous(&self, host: &impl PeerHost) -> Result<(), String> {
        while self.available(host)? {
            let Some(message) = self.state.borrow().next_message() else {
                break;
            };
            if !self.state.borrow().deliverable(message.msgno, &message.msg) {
                break;
            }
            self.state.borrow_mut().reorder_queue.remove(&message.msgno);
            self.deliver(message.msgno, &message.msg, host)?;
        }
        Ok(())
    }

    pub fn consumer_ready(&self, mode: ReceiveMode, host: &impl PeerHost) -> Result<(), String> {
        self.state.borrow_mut().receive_mode = mode;
        let obsolete: Vec<_> = {
            let session = self.state.borrow();
            session
                .reorder_queue
                .keys()
                .copied()
                .filter(|n| *n <= session.state.remote_number)
                .collect()
        };
        for msgno in obsolete {
            self.state.borrow_mut().reorder_queue.remove(&msgno);
            host.send(SendFrame::Ack { msgno })?;
        }
        if self
            .state
            .borrow()
            .terminal_handoff
            .as_ref()
            .is_some_and(|b| b.acknowledged)
        {
            self.complete_terminal(host)?;
        }
        if let Err(reason) = self.drain_contiguous(host) {
            self.failure(reason, host)?;
        }
        Ok(())
    }

    fn receive_ack(&self, msgno: u64, host: &impl PeerHost) -> Result<bool, String> {
        let result = (|| {
            self.state.borrow_mut().acknowledge(msgno)?;
            self.request_commit(host)?;
            let terminal = {
                let mut session = self.state.borrow_mut();
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
                self.complete_terminal(host)?;
            }
            if self.state.borrow().rejection_complete() {
                host.notify(PeerEvent::RejectionAcknowledged)?;
            }
            if self.state.borrow().receive_mode == ReceiveMode::Raw {
                host.notify(PeerEvent::Acknowledged { msgno })?;
            }
            Ok(())
        })();
        if let Err(reason) = result {
            self.failure(reason, host)?;
            return Ok(false);
        }
        Ok(true)
    }

    pub fn channel_command(
        &self,
        command: Option<TerminalCommand>,
        restoring: bool,
        host: &impl PeerHost,
    ) -> Result<(), String> {
        self.state
            .borrow_mut()
            .channel_command(command, restoring)?;
        self.request_commit(host)?;
        let acknowledged = self
            .state
            .borrow()
            .terminal_handoff
            .as_ref()
            .is_some_and(|b| b.acknowledged);
        if acknowledged {
            self.complete_terminal(host)?;
        }
        Ok(())
    }

    fn complete_terminal(&self, host: &impl PeerHost) -> Result<(), String> {
        let completion = (|| {
            let mut output = match self.channel.borrow_mut().as_mut() {
                Some(channel) => channel.complete_terminal()?,
                None => return Ok(()),
            };
            self.collect_output(&mut output)?;
            host.notify(PeerEvent::ChannelResult(output))?;
            self.state.borrow_mut().terminal_handoff = None;
            Ok(())
        })();
        if let Err(reason) = completion {
            host.notify(PeerEvent::Error { reason })?;
        }
        Ok(())
    }

    fn send_data(&self, msgno: u64, body: &[u8], host: &impl PeerHost) -> Result<bool, String> {
        let accepted = host.send(SendFrame::Data { msgno, body })?;
        let terminal_sent = {
            let mut session = self.state.borrow_mut();
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
            host.notify(PeerEvent::CommitRequested)?;
        }
        Ok(accepted)
    }

    fn send_ack(&self, msgno: u64, host: &impl PeerHost) -> Result<(), String> {
        let accepted = host.send(SendFrame::Ack { msgno })?;
        self.state.borrow_mut().ack_sent(msgno, accepted);
        Ok(())
    }

    pub fn connectivity(
        &self,
        event: &str,
        now: f64,
        force: bool,
        host: &impl PeerHost,
    ) -> Result<bool, String> {
        let Some(messages) = self.state.borrow_mut().connectivity(event, now, force)? else {
            return Ok(false);
        };
        for message in messages {
            if !self.send_data(message.msgno, &message.msg, host)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn complete_commit(
        &self,
        commit: PreparedCommit,
        persisted: bool,
        host: &impl PeerHost,
    ) -> Result<(), String> {
        let frames = self.state.borrow_mut().complete_commit(commit, persisted);
        for message in frames.outbound {
            self.send_data(message.msgno, &message.msg, host)?;
        }
        for msgno in frames.acks {
            self.send_ack(msgno, host)?;
        }
        if persisted {
            host.notify(PeerEvent::Committed)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
