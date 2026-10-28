use std::cell::{Cell, RefCell};
use std::rc::Rc;

use chia_gaming::peer_session::coordination::{
    HostStatus, ReceiveMode, TerminalCommand, TerminalHandoff,
};
use chia_gaming::peer_session::driver::{PeerDriver, PeerEvent, PeerHost, PeerInput, SendFrame};
use chia_gaming::peer_session::{PeerSession, PreparedCommit, ReceivePolicy, SetupState};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

fn error(value: impl ToString) -> JsValue {
    js_sys::Error::new(&value.to_string()).into()
}
fn js(value: &impl Serialize) -> Result<JsValue, JsValue> {
    value
        .serialize(
            &serde_wasm_bindgen::Serializer::new()
                .serialize_maps_as_objects(true)
                .serialize_large_number_types_as_bigints(true),
        )
        .map_err(error)
}
fn host_error(value: JsValue) -> String {
    value
        .as_string()
        .or_else(|| {
            js_sys::Reflect::get(&value, &"message".into())
                .ok()?
                .as_string()
        })
        .unwrap_or_else(|| format!("{value:?}"))
}

#[wasm_bindgen]
extern "C" {
    pub type JsPeerHost;
    #[wasm_bindgen(method, catch, js_name = send)]
    fn send_js(this: &JsPeerHost, frame: JsValue) -> Result<bool, JsValue>;
    #[wasm_bindgen(method, catch, js_name = status)]
    fn status_js(this: &JsPeerHost) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(method, catch, js_name = notify)]
    fn notify_js(this: &JsPeerHost, event: JsValue) -> Result<JsValue, JsValue>;
}

impl PeerHost for JsPeerHost {
    fn send(&self, frame: SendFrame<'_>) -> Result<bool, String> {
        self.send_js(js(&frame).map_err(host_error)?)
            .map_err(host_error)
    }
    fn status(&self) -> Result<HostStatus, String> {
        #[derive(serde::Deserialize)]
        struct Availability {
            available: bool,
        }
        let status: Availability =
            serde_wasm_bindgen::from_value(self.status_js().map_err(host_error)?)
                .map_err(|e| e.to_string())?;
        Ok(HostStatus {
            available: status.available,
            established: false,
            discarding: false,
        })
    }
    fn notify(&self, event: PeerEvent) -> Result<bool, String> {
        self.notify_js(js(&event).map_err(host_error)?)
            .map(|_| false)
            .map_err(host_error)
    }
}

#[wasm_bindgen]
pub struct PeerProtocol {
    inner: Rc<PeerRuntime>,
}

/// One accepted session owns both reliability and the channel's registry handle.
/// The channel points back weakly; retiring or dropping this owner releases it.
pub(super) struct PeerRuntime {
    pub state: RefCell<PeerSession>,
    channel: Cell<Option<i32>>,
}

impl Drop for PeerRuntime {
    fn drop(&mut self) {
        self.drop_channel();
    }
}

impl PeerRuntime {
    fn drop_channel(&self) {
        if let Some(id) = self.channel.take() {
            super::gaming_wasm::drop_game_session(id);
        }
    }

    fn attach_channel(self: &Rc<Self>, id: i32) -> Result<(), JsValue> {
        if self.channel.get().is_some() {
            return Err(error("peer session already owns a channel"));
        }
        if let Err(err) = super::gaming_wasm::attach_peer(id, Rc::downgrade(self)) {
            super::gaming_wasm::drop_game_session(id);
            return Err(err);
        }
        self.channel.set(Some(id));
        Ok(())
    }

    pub fn collect_channel_output(
        &self,
        drain: &mut chia_gaming::transaction_manager::ManagerDrain,
        command: Option<chia_gaming::game_session::TerminalHandoffCommand>,
        terminal: bool,
        on_chain: bool,
    ) -> Result<(), String> {
        let mut session = self.state.borrow_mut();
        if terminal {
            session.terminal_handoff = None;
            session.state.unacked_messages.clear();
            session.reorder_queue.clear();
            session.discard_outbound();
        }
        if let Some(command) = command {
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
        let mut projected = Vec::new();
        for event in drain.events.drain(..) {
            if let chia_gaming::session_phases::effects::GameSessionEvent::OutboundMessage(body) =
                event
            {
                if !terminal && !on_chain {
                    let disposition = session.state.disposition.clone();
                    session.allocate(body, disposition)?;
                }
            } else {
                projected.push(event);
            }
        }
        drain.events = projected.into();
        Ok(())
    }
}

struct SessionHost<'a> {
    runtime: &'a PeerRuntime,
    host: JsPeerHost,
}

impl SessionHost<'_> {
    fn channel_result(&self, result: JsValue) -> Result<(), String> {
        let event = js_sys::Object::new();
        js_sys::Reflect::set(&event, &"type".into(), &"channel-result".into())
            .map_err(host_error)?;
        js_sys::Reflect::set(&event, &"result".into(), &result).map_err(host_error)?;
        self.host.notify_js(event.into()).map_err(host_error)?;
        Ok(())
    }
}

impl PeerHost for SessionHost<'_> {
    fn send(&self, frame: SendFrame<'_>) -> Result<bool, String> {
        self.host.send(frame)
    }
    fn status(&self) -> Result<HostStatus, String> {
        let mut status = self.host.status()?;
        if self.runtime.state.borrow().receive_mode == ReceiveMode::Channel {
            if let Some(id) = self.runtime.channel.get() {
                let (established, discarding) =
                    super::gaming_wasm::peer_channel_status(id).map_err(host_error)?;
                status.established = established;
                status.discarding = discarding;
            } else {
                status.available = false;
            }
        }
        Ok(status)
    }
    fn notify(&self, event: PeerEvent) -> Result<bool, String> {
        match event {
            PeerEvent::Message { body, .. }
                if self.runtime.state.borrow().receive_mode == ReceiveMode::Channel =>
            {
                let id = self
                    .runtime
                    .channel
                    .get()
                    .ok_or("accepted session has no channel")?;
                self.channel_result(
                    super::gaming_wasm::deliver_message(id, &body).map_err(host_error)?,
                )?;
                Ok(true)
            }
            PeerEvent::TerminalAcknowledged => {
                let Some(id) = self.runtime.channel.get() else {
                    return Ok(false);
                };
                let completion = super::gaming_wasm::complete_peer_terminal_handoff(id)
                    .map_err(host_error)
                    .and_then(|result| self.channel_result(result));
                if let Err(reason) = completion {
                    let event = js_sys::Object::new();
                    js_sys::Reflect::set(&event, &"type".into(), &"error".into())
                        .map_err(host_error)?;
                    js_sys::Reflect::set(&event, &"reason".into(), &reason.into())
                        .map_err(host_error)?;
                    self.host.notify_js(event.into()).map_err(host_error)?;
                    return Ok(false);
                }
                Ok(true)
            }
            event => self.host.notify(event),
        }
    }
}

#[wasm_bindgen]
pub fn create_peer_protocol(state: JsValue, policy: JsValue) -> Result<PeerProtocol, JsValue> {
    Ok(PeerProtocol {
        inner: Rc::new(PeerRuntime {
            state: RefCell::new(PeerSession::new(
                serde_wasm_bindgen::from_value(state).map_err(error)?,
                serde_wasm_bindgen::from_value::<ReceivePolicy>(policy).map_err(error)?,
            )),
            channel: Cell::new(None),
        }),
    })
}

impl PeerProtocol {
    fn driver(&self, host: JsPeerHost) -> PeerDriver<'_, SessionHost<'_>> {
        PeerDriver {
            session: &self.inner.state,
            host: SessionHost {
                runtime: &self.inner,
                host,
            },
        }
    }
}

#[wasm_bindgen]
impl PeerProtocol {
    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Snapshot<'a> {
            #[serde(flatten)]
            state: &'a chia_gaming::peer_session::ReliableState,
            terminal_handoff: &'a Option<TerminalHandoff>,
            rejection_complete: bool,
        }
        let session = self.inner.state.borrow();
        js(&Snapshot {
            state: &session.state,
            terminal_handoff: &session.terminal_handoff,
            rejection_complete: session.rejection_complete(),
        })
    }
    pub fn restore(&self, state: JsValue, terminal: JsValue) -> Result<(), JsValue> {
        let mut session = self.inner.state.borrow_mut();
        session.state = serde_wasm_bindgen::from_value(state).map_err(error)?;
        session
            .restore_terminal(serde_wasm_bindgen::from_value(terminal).map_err(error)?)
            .map_err(error)
    }
    pub fn receive(&self, input: JsValue, host: JsPeerHost) -> Result<bool, JsValue> {
        self.driver(host)
            .receive(serde_wasm_bindgen::from_value::<PeerInput>(input).map_err(error)?)
            .map_err(error)
    }
    pub fn consumer_ready(&self, mode: JsValue, host: JsPeerHost) -> Result<(), JsValue> {
        let mode = if matches!(
            self.inner.state.borrow().setup,
            Some(SetupState::WaitingForWalletAddress { .. } | SetupState::ChannelStarted)
        ) {
            ReceiveMode::Channel
        } else {
            serde_wasm_bindgen::from_value::<ReceiveMode>(mode).map_err(error)?
        };
        self.driver(host).consumer_ready(mode).map_err(error)
    }
    pub fn connectivity(
        &self,
        event: &str,
        now: f64,
        force: bool,
        host: JsPeerHost,
    ) -> Result<bool, JsValue> {
        self.driver(host)
            .connectivity(event, now, force)
            .map_err(error)
    }
    pub fn dirty(&self) -> bool {
        self.inner.state.borrow().dirty()
    }
    pub fn prepare_commit(&self) -> Result<JsValue, JsValue> {
        js(&self.inner.state.borrow().prepare_commit())
    }
    pub fn complete_commit(
        &self,
        commit: JsValue,
        persisted: bool,
        host: JsPeerHost,
    ) -> Result<(), JsValue> {
        let commit: PreparedCommit = serde_wasm_bindgen::from_value(commit).map_err(error)?;
        self.driver(host)
            .complete_commit(commit, persisted)
            .map_err(error)
    }
    /// Retire the channel consumer, optionally preserving its reliable rejection
    /// for the application-owned tombstone transport.
    pub fn retire(&self, retain_rejection: bool) -> bool {
        self.inner.drop_channel();
        let mut session = self.inner.state.borrow_mut();
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
    pub fn reject_session(&self, host: JsPeerHost) -> Result<(), JsValue> {
        self.inner
            .state
            .borrow_mut()
            .reject_session()
            .map_err(error)?;
        self.driver(host).request_commit().map_err(error)
    }
    pub fn failure(&self, reason: String, host: JsPeerHost) -> Result<(), JsValue> {
        self.driver(host).failure(reason).map_err(error)
    }
    pub fn accept_session(&self, terms: JsValue, initiator: bool) -> Result<(), JsValue> {
        self.inner
            .state
            .borrow_mut()
            .accept(
                serde_wasm_bindgen::from_value(terms).map_err(error)?,
                initiator,
            )
            .map_err(error)
    }

    pub fn restore_channel(&self, data: &[u8], seed: &str) -> Result<i32, JsValue> {
        let id = super::gaming_wasm::restore_session(data, seed)?;
        self.inner.attach_channel(id)?;
        Ok(id)
    }

    /// The host implements only the address RPC. Rust owns setup resumption,
    /// the wait, cancellation on retirement, and construction of the channel.
    pub async fn open_channel(
        &self,
        terms: JsValue,
        initiator: bool,
        rng_id: i32,
        genesis_challenge: String,
        address_provider: js_sys::Function,
    ) -> Result<JsValue, JsValue> {
        if matches!(self.inner.state.borrow().setup, Some(SetupState::Retired)) {
            return Ok(JsValue::UNDEFINED);
        }
        self.inner
            .state
            .borrow_mut()
            .prepare_channel(
                serde_wasm_bindgen::from_value(terms).map_err(error)?,
                initiator,
            )
            .map_err(error)?;
        let response = address_provider.call0(&JsValue::UNDEFINED)?;
        let address = JsFuture::from(js_sys::Promise::resolve(&response)).await?;
        if matches!(self.inner.state.borrow().setup, Some(SetupState::Retired)) {
            return Ok(JsValue::UNDEFINED);
        }
        let address = address
            .as_string()
            .ok_or_else(|| error("wallet address must be a string"))?;
        self.provide_wallet_address(rng_id, &address, &genesis_challenge)
    }
}

impl PeerProtocol {
    /// Complete Rust's host request and create the channel within this existing
    /// accepted peer session. The host never supplies a placeholder address.
    fn provide_wallet_address(
        &self,
        rng_id: i32,
        address: &str,
        genesis_challenge: &str,
    ) -> Result<JsValue, JsValue> {
        let setup = self.inner.state.borrow().setup.clone();
        let Some(SetupState::WaitingForWalletAddress { terms, initiator }) = &setup else {
            return Err(error("peer session is not waiting for a wallet address"));
        };
        let amount = |value: &str| value.parse::<u64>().map_err(error);
        let timeout = |value: &Option<String>| {
            value
                .as_ref()
                .map(|v| v.parse::<i32>().map_err(error))
                .unwrap_or(Ok(15))
        };
        let (mine, theirs) = if *initiator {
            (&terms.proposer_amount, &terms.responder_amount)
        } else {
            (&terms.responder_amount, &terms.proposer_amount)
        };
        let config = super::gaming_wasm::JsGameSessionConfig {
            rng_id,
            is_initiator: *initiator,
            my_contribution: super::gaming_wasm::JsAmount {
                amt: chia_gaming::common::types::Amount::new(amount(mine)?),
            },
            their_contribution: super::gaming_wasm::JsAmount {
                amt: chia_gaming::common::types::Amount::new(amount(theirs)?),
            },
            channel_timeout: timeout(&terms.channel_timeout)?,
            unroll_timeout: timeout(&terms.unroll_timeout)?,
            reward_puzzle_hash: address.into(),
            genesis_challenge: genesis_challenge.into(),
        };
        let result = super::gaming_wasm::create_game_session(js(&config)?)?;
        let id = js_sys::Reflect::get(&result, &"id".into())?
            .as_f64()
            .ok_or_else(|| error("created channel has no id"))? as i32;
        self.inner.attach_channel(id)?;
        self.inner.state.borrow_mut().setup = Some(SetupState::ChannelStarted);
        js_sys::Reflect::set(&result, &"rewardPuzzleHash".into(), &address.into())?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chia_gaming::game_session::TerminalHandoffCommand;
    use chia_gaming::peer_session::ReliableState;
    use chia_gaming::session_phases::effects::GameSessionEvent;
    use chia_gaming::transaction_manager::ManagerDrain;

    fn runtime() -> PeerRuntime {
        PeerRuntime {
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
            channel: Cell::new(None),
        }
    }

    #[test]
    fn channel_output_stays_in_rust_and_close_precedes_ordinary_output() {
        let runtime = runtime();
        let mut drain = ManagerDrain {
            events: vec![
                GameSessionEvent::Log("before".into()),
                GameSessionEvent::OutboundMessage(b"ordinary".to_vec()),
                GameSessionEvent::Log("after".into()),
            ]
            .into(),
            ..Default::default()
        };
        runtime
            .collect_channel_output(
                &mut drain,
                Some(TerminalHandoffCommand {
                    id: 1,
                    message: b"close".to_vec(),
                }),
                false,
                false,
            )
            .unwrap();
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
        let logs: Vec<_> = drain
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
        let mut drain = ManagerDrain {
            events: vec![
                GameSessionEvent::OutboundMessage(b"obsolete".to_vec()),
                GameSessionEvent::Log("terminal".into()),
            ]
            .into(),
            ..Default::default()
        };
        runtime
            .collect_channel_output(&mut drain, None, true, false)
            .unwrap();
        let mut session = runtime.state.borrow_mut();
        assert!(session.terminal_handoff.is_none());
        assert!(session.state.unacked_messages.is_empty());
        let commit = session.prepare_commit();
        assert!(session.complete_commit(commit, true).outbound.is_empty());
        assert!(
            matches!(drain.events.front(), Some(GameSessionEvent::Log(message)) if message == "terminal")
        );
        assert_eq!(drain.events.len(), 1);
    }

    #[test]
    fn on_chain_channel_does_not_allocate_peer_output() {
        let runtime = runtime();
        let mut drain = ManagerDrain {
            events: vec![GameSessionEvent::OutboundMessage(b"obsolete".to_vec())].into(),
            ..Default::default()
        };
        runtime
            .collect_channel_output(&mut drain, None, false, true)
            .unwrap();
        assert!(runtime.state.borrow().state.unacked_messages.is_empty());
        assert!(drain.events.is_empty());
    }
}
