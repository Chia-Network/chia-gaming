//! One session owns reliable delivery and its optional channel. Channel calls
//! return native output; host callbacks run only after these borrows end.
use std::cell::RefCell;

use super::coordination::{HostStatus, TerminalCommand};
use super::PeerSession;
use crate::game_session::TerminalHandoffCommand;
use crate::session_phases::effects::GameSessionEvent;
use crate::transaction_manager::ManagerDrain;

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
    pub state: RefCell<PeerSession>,
    pub channel: RefCell<Option<C>>,
}

impl<C> Session<C> {
    pub fn new(state: PeerSession) -> Self {
        Self {
            state: RefCell::new(state),
            channel: RefCell::new(None),
        }
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
    pub fn status(&self, available: bool) -> HostStatus {
        let channel = self.channel.borrow();
        let (established, discarding) = channel.as_ref().map_or((false, false), Channel::status);
        HostStatus {
            available: available && channel.is_some(),
            established,
            discarding,
        }
    }

    pub fn deliver(&self, body: &[u8]) -> Result<ChannelOutput, String> {
        let mut output = self
            .channel
            .borrow_mut()
            .as_mut()
            .ok_or("accepted session has no channel")?
            .deliver(body)?;
        self.collect_output(&mut output)?;
        Ok(output)
    }

    pub fn complete_terminal(&self) -> Result<Option<ChannelOutput>, String> {
        let mut output = match self.channel.borrow_mut().as_mut() {
            Some(channel) => channel.complete_terminal()?,
            None => return Ok(None),
        };
        self.collect_output(&mut output)?;
        Ok(Some(output))
    }
}

#[cfg(test)]
mod tests {
    use super::super::{PeerSession, ReceivePolicy};
    use super::*;
    use crate::game_session::TerminalHandoffCommand;
    use crate::peer_session::ReliableState;
    use crate::session_phases::effects::GameSessionEvent;
    use crate::transaction_manager::ManagerDrain;

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
}
