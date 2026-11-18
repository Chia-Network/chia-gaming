//! Peer application policy. The host reports availability; Rust decides which
//! messages can cross consent, rejection and terminal-handoff boundaries.

use serde::{Deserialize, Serialize};

use super::{SessionState, SessionTerms, SetupState};

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReceiveMode {
    Raw,
    Proposal,
    Channel,
    Rejection,
    Retiring,
}

#[derive(Deserialize)]
pub struct HostStatus {
    pub available: bool,
    pub established: bool,
    pub discarding: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct TerminalHandoff {
    pub id: String,
    pub message: Vec<u8>,
    pub msgno: u64,
    pub sent: bool,
    pub acknowledged: bool,
}

#[derive(Deserialize)]
pub struct TerminalCommand {
    pub id: String,
    pub message: Vec<u8>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ApplicationMessage {
    Proposal,
    Rejection { handshake_failed: bool },
}

pub fn application_message(body: &[u8]) -> Option<ApplicationMessage> {
    let bencodex::Value::Dictionary(fields) = bencodex::parse(body).ok()? else {
        return None;
    };
    let field = |name: &str| {
        fields
            .iter()
            .find(|(key, _)| key == &bencodex::Value::Text(name.into()))
            .map(|(_, value)| value)
    };
    let bencodex::Value::Text(kind) = field("type")? else {
        return None;
    };
    match kind.as_str() {
        "session_proposal" => {
            for key in ["proposer_amount", "responder_amount"] {
                if !matches!(field(key), Some(bencodex::Value::Text(_))) {
                    return None;
                }
            }
            Some(ApplicationMessage::Proposal)
        }
        "session_reject" => Some(ApplicationMessage::Rejection {
            handshake_failed: matches!(field("phase"), Some(bencodex::Value::Text(phase)) if phase == "handshake"),
        }),
        _ => None,
    }
}

impl SessionState {
    pub fn available(&self, status: &HostStatus) -> bool {
        status.available
            && !(matches!(
                self.receive_mode,
                ReceiveMode::Proposal | ReceiveMode::Channel
            ) && (self.failed || self.state.disposition == "inbound-reject"))
    }

    pub fn deliverable(&self, msgno: u64, body: &[u8]) -> bool {
        self.receive_mode != ReceiveMode::Proposal
            || msgno == 1
            || matches!(
                application_message(body),
                Some(ApplicationMessage::Rejection { .. })
            )
    }

    pub fn terminal_message(&self, body: &[u8]) -> bool {
        self.receive_mode == ReceiveMode::Proposal
            && matches!(
                application_message(body),
                Some(ApplicationMessage::Rejection { .. })
            )
    }

    pub fn reject_inbound(&mut self) {
        self.state.disposition = "inbound-reject".into();
        self.discard_outbound();
    }

    pub fn restore_terminal(&mut self, binding: Option<TerminalHandoff>) -> Result<(), String> {
        if let Some(current) = &self.terminal_handoff {
            if binding.as_ref() != Some(current) {
                return Err("terminal handoff was already restored with different state".into());
            }
        }
        self.terminal_handoff = binding;
        Ok(())
    }

    pub fn channel_command(
        &mut self,
        command: Option<TerminalCommand>,
        restoring: bool,
    ) -> Result<(), String> {
        if restoring {
            self.setup = Some(SetupState::ChannelStarted);
        }
        let Some(command) = command else {
            if restoring && self.terminal_handoff.is_some() {
                return Err("persisted terminal handoff has no matching Rust command".into());
            }
            return Ok(());
        };
        if let Some(binding) = &self.terminal_handoff {
            if !restoring {
                return Err("cannot replace a pending terminal handoff command".into());
            }
            if binding.id != command.id || binding.message != command.message {
                return Err(
                    "persisted terminal handoff does not match Rust pending command".into(),
                );
            }
            return self.validate_terminal_handoff(
                binding.msgno,
                &binding.message,
                binding.sent,
                binding.acknowledged,
            );
        }
        let msgno = self.allocate(command.message.clone(), self.state.disposition.clone())?;
        self.terminal_handoff = Some(TerminalHandoff {
            id: command.id,
            message: command.message,
            msgno,
            sent: false,
            acknowledged: false,
        });
        Ok(())
    }

    pub fn prepare_channel(&mut self, terms: SessionTerms, initiator: bool) -> Result<(), String> {
        match self.setup {
            None => self.setup = Some(SetupState::WaitingForWalletAddress { terms, initiator }),
            Some(SetupState::WaitingForWalletAddress { .. }) => {}
            Some(SetupState::ChannelStarted) => {
                return Err("peer session channel already started".into())
            }
            Some(SetupState::Retired) => return Err("peer session setup is retired".into()),
        }
        Ok(())
    }
}
