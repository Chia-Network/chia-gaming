use std::cell::RefCell;

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
        serde_wasm_bindgen::from_value(self.status_js().map_err(host_error)?)
            .map_err(|e| e.to_string())
    }
    fn notify(&self, event: PeerEvent) -> Result<bool, String> {
        self.notify_js(js(&event).map_err(host_error)?)
            .map(|value| value.as_bool().unwrap_or(false))
            .map_err(host_error)
    }
}

#[wasm_bindgen]
pub struct PeerProtocol {
    inner: RefCell<PeerSession>,
}

#[wasm_bindgen]
pub fn create_peer_protocol(state: JsValue, policy: JsValue) -> Result<PeerProtocol, JsValue> {
    Ok(PeerProtocol {
        inner: RefCell::new(PeerSession::new(
            serde_wasm_bindgen::from_value(state).map_err(error)?,
            serde_wasm_bindgen::from_value::<ReceivePolicy>(policy).map_err(error)?,
        )),
    })
}

impl PeerProtocol {
    fn driver(&self, host: JsPeerHost) -> PeerDriver<'_, JsPeerHost> {
        PeerDriver {
            session: &self.inner,
            host,
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
        let session = self.inner.borrow();
        js(&Snapshot {
            state: &session.state,
            terminal_handoff: &session.terminal_handoff,
            rejection_complete: session.rejection_complete(),
        })
    }
    pub fn restore(&self, state: JsValue, terminal: JsValue) -> Result<(), JsValue> {
        let mut session = self.inner.borrow_mut();
        session.state = serde_wasm_bindgen::from_value(state).map_err(error)?;
        session
            .restore_terminal(serde_wasm_bindgen::from_value(terminal).map_err(error)?)
            .map_err(error)
    }
    pub fn send_message(&self, body: &[u8], host: JsPeerHost) -> Result<u64, JsValue> {
        self.driver(host).send_message(body.to_vec()).map_err(error)
    }
    pub fn receive(&self, input: JsValue, host: JsPeerHost) -> Result<bool, JsValue> {
        self.driver(host)
            .receive(serde_wasm_bindgen::from_value::<PeerInput>(input).map_err(error)?)
            .map_err(error)
    }
    pub fn consumer_ready(&self, mode: JsValue, host: JsPeerHost) -> Result<(), JsValue> {
        self.driver(host)
            .consumer_ready(serde_wasm_bindgen::from_value::<ReceiveMode>(mode).map_err(error)?)
            .map_err(error)
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
        self.inner.borrow().dirty()
    }
    pub fn prepare_commit(&self) -> Result<JsValue, JsValue> {
        js(&self.inner.borrow().prepare_commit())
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
        let mut session = self.inner.borrow_mut();
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
    pub fn stop_protocol(&self) {
        let mut session = self.inner.borrow_mut();
        session.terminal_handoff = None;
        session.state.unacked_messages.clear();
        session.reorder_queue.clear();
    }
    pub fn reject_session(&self, host: JsPeerHost) -> Result<(), JsValue> {
        self.inner.borrow_mut().reject_session().map_err(error)?;
        self.driver(host).request_commit().map_err(error)
    }
    pub fn failure(&self, reason: String, host: JsPeerHost) -> Result<(), JsValue> {
        self.driver(host).failure(reason).map_err(error)
    }
    pub fn channel_command(
        &self,
        command: JsValue,
        restoring: bool,
        host: JsPeerHost,
    ) -> Result<(), JsValue> {
        self.driver(host)
            .channel_command(
                serde_wasm_bindgen::from_value::<Option<TerminalCommand>>(command)
                    .map_err(error)?,
                restoring,
            )
            .map_err(error)
    }

    pub fn accept_session(&self, terms: JsValue, initiator: bool) -> Result<(), JsValue> {
        self.inner
            .borrow_mut()
            .accept(
                serde_wasm_bindgen::from_value(terms).map_err(error)?,
                initiator,
            )
            .map_err(error)
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
        if matches!(self.inner.borrow().setup, Some(SetupState::Retired)) {
            return Ok(JsValue::UNDEFINED);
        }
        self.inner
            .borrow_mut()
            .prepare_channel(
                serde_wasm_bindgen::from_value(terms).map_err(error)?,
                initiator,
            )
            .map_err(error)?;
        let response = address_provider.call0(&JsValue::UNDEFINED)?;
        let address = JsFuture::from(js_sys::Promise::resolve(&response)).await?;
        if matches!(self.inner.borrow().setup, Some(SetupState::Retired)) {
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
        let setup = self.inner.borrow().setup.clone();
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
        self.inner.borrow_mut().setup = Some(SetupState::ChannelStarted);
        js_sys::Reflect::set(&result, &"rewardPuzzleHash".into(), &address.into())?;
        Ok(result)
    }
}
