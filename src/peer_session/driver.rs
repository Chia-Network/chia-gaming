//! Own the entire reliable-delivery turn, including attempts to use the carrier.
//! Host callbacks never run with a session borrow held: delivering a channel
//! message can synchronously produce another outbound message on this session.

use std::cell::RefCell;

use serde::Serialize;

use super::{PeerSession, PreparedCommit, ReceiveAction};

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PeerEvent {
    CommitRequested,
    Sent { msgno: u64 },
    Acknowledged { msgno: u64 },
    Keepalive,
    Committed,
    Failure { reason: String },
}

/// Carrier operations and the existing application-message consumer. Queue
/// selection, ordering, ACKs, replay and send-result bookkeeping stay in Rust.
pub trait PeerHost {
    fn send_data(&self, msgno: u64, body: &[u8]) -> Result<bool, String>;
    fn send_ack(&self, msgno: u64) -> Result<bool, String>;
    fn ready(&self) -> Result<bool, String>;
    fn can_deliver(&self, msgno: u64, body: &[u8]) -> Result<bool, String>;
    fn can_terminate(&self, msgno: u64, body: &[u8]) -> Result<bool, String>;
    fn deliver(&self, msgno: u64, body: &[u8]) -> Result<(), String>;
    fn notify(&self, event: PeerEvent) -> Result<(), String>;
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

    pub fn send_message(&self, body: Vec<u8>, disposition: String) -> Result<u64, String> {
        let msgno = self.session.borrow_mut().allocate(body, disposition)?;
        self.request_commit()?;
        Ok(msgno)
    }

    pub fn failure(&self, reason: String) -> Result<(), String> {
        self.session.borrow_mut().reorder_queue.clear();
        self.host.notify(PeerEvent::Failure { reason })
    }

    pub fn receive_data(&self, msgno: u64, body: Vec<u8>) -> Result<bool, String> {
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
        let ready = candidate != "duplicate" && self.host.ready()?;
        let deliverable = ready && candidate == "next" && self.host.can_deliver(msgno, &body)?;
        let terminal = ready && candidate == "future" && self.host.can_terminate(msgno, &body)?;
        let action =
            self.session
                .borrow_mut()
                .receive(msgno, body.clone(), deliverable, terminal)?;
        match action {
            ReceiveAction::Ack => {
                self.host.send_ack(msgno)?;
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

    fn deliver(&self, msgno: u64, body: &[u8]) -> Result<(), String> {
        self.host.deliver(msgno, body)?;
        self.session.borrow_mut().delivered(msgno);
        self.request_commit()
    }

    fn drain_contiguous(&self) -> Result<(), String> {
        while self.host.ready()? {
            let Some(message) = self.session.borrow().next_message() else {
                break;
            };
            if !self.host.can_deliver(message.msgno, &message.msg)? {
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

    pub fn consumer_ready(&self) -> Result<(), String> {
        let obsolete: Vec<_> = {
            let session = self.session.borrow();
            session
                .reorder_queue
                .keys()
                .copied()
                .filter(|msgno| *msgno <= session.state.remote_number)
                .collect()
        };
        for msgno in obsolete {
            self.session.borrow_mut().reorder_queue.remove(&msgno);
            self.host.send_ack(msgno)?;
        }
        if let Err(reason) = self.drain_contiguous() {
            self.failure(reason)?;
        }
        Ok(())
    }

    pub fn receive_ack(&self, msgno: u64) -> Result<bool, String> {
        let result = (|| {
            self.session.borrow_mut().acknowledge(msgno)?;
            self.request_commit()?;
            self.host.notify(PeerEvent::Acknowledged { msgno })
        })();
        if let Err(reason) = result {
            self.failure(reason)?;
            return Ok(false);
        }
        Ok(true)
    }

    pub fn keepalive(&self) -> Result<(), String> {
        self.host.notify(PeerEvent::Keepalive)?;
        let acks = self.session.borrow().retry_acks();
        for msgno in acks {
            self.send_ack(msgno)?;
        }
        Ok(())
    }

    fn send_data(&self, msgno: u64, body: &[u8]) -> Result<bool, String> {
        let accepted = self.host.send_data(msgno, body)?;
        self.session.borrow_mut().sent(msgno, accepted);
        if accepted {
            self.host.notify(PeerEvent::Sent { msgno })?;
        }
        Ok(accepted)
    }

    fn send_ack(&self, msgno: u64) -> Result<(), String> {
        let accepted = self.host.send_ack(msgno)?;
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
