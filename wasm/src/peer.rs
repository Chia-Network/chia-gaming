use std::cell::RefCell;

use chia_gaming::peer_session::driver::{PeerDriver, PeerEvent, PeerHost};
use chia_gaming::peer_session::{
    PeerSession, PreparedCommit, ReceivePolicy, SessionTerms, SetupState,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

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
    #[wasm_bindgen(method, catch, js_name = sendData)]
    fn send_data_js(this: &JsPeerHost, msgno: u64, body: &[u8]) -> Result<bool, JsValue>;
    #[wasm_bindgen(method, catch, js_name = sendAck)]
    fn send_ack_js(this: &JsPeerHost, msgno: u64) -> Result<bool, JsValue>;
    #[wasm_bindgen(method, catch, js_name = ready)]
    fn ready_js(this: &JsPeerHost) -> Result<bool, JsValue>;
    #[wasm_bindgen(method, catch, js_name = canDeliver)]
    fn can_deliver_js(this: &JsPeerHost, msgno: u64, body: &[u8]) -> Result<bool, JsValue>;
    #[wasm_bindgen(method, catch, js_name = canTerminate)]
    fn can_terminate_js(this: &JsPeerHost, msgno: u64, body: &[u8]) -> Result<bool, JsValue>;
    #[wasm_bindgen(method, catch, js_name = deliver)]
    fn deliver_js(this: &JsPeerHost, msgno: u64, body: &[u8]) -> Result<(), JsValue>;
    #[wasm_bindgen(method, catch, js_name = notify)]
    fn notify_js(this: &JsPeerHost, event: JsValue) -> Result<(), JsValue>;
}

impl PeerHost for JsPeerHost {
    fn send_data(&self, msgno: u64, body: &[u8]) -> Result<bool, String> {
        self.send_data_js(msgno, body).map_err(host_error)
    }
    fn send_ack(&self, msgno: u64) -> Result<bool, String> {
        self.send_ack_js(msgno).map_err(host_error)
    }
    fn ready(&self) -> Result<bool, String> {
        self.ready_js().map_err(host_error)
    }
    fn can_deliver(&self, msgno: u64, body: &[u8]) -> Result<bool, String> {
        self.can_deliver_js(msgno, body).map_err(host_error)
    }
    fn can_terminate(&self, msgno: u64, body: &[u8]) -> Result<bool, String> {
        self.can_terminate_js(msgno, body).map_err(host_error)
    }
    fn deliver(&self, msgno: u64, body: &[u8]) -> Result<(), String> {
        self.deliver_js(msgno, body).map_err(host_error)
    }
    fn notify(&self, event: PeerEvent) -> Result<(), String> {
        self.notify_js(js(&event).map_err(host_error)?)
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
        js(&self.inner.borrow().state)
    }
    pub fn restore(&self, state: JsValue) -> Result<(), JsValue> {
        self.inner.borrow_mut().state = serde_wasm_bindgen::from_value(state).map_err(error)?;
        Ok(())
    }
    pub fn send_message(
        &self,
        body: &[u8],
        disposition: Option<String>,
        host: JsPeerHost,
    ) -> Result<u64, JsValue> {
        let disposition =
            disposition.unwrap_or_else(|| self.inner.borrow().state.disposition.clone());
        self.driver(host)
            .send_message(body.to_vec(), disposition)
            .map_err(error)
    }
    pub fn receive_data(&self, msgno: u64, body: &[u8], host: JsPeerHost) -> Result<bool, JsValue> {
        self.driver(host)
            .receive_data(msgno, body.to_vec())
            .map_err(error)
    }
    pub fn receive_ack(&self, msgno: u64, host: JsPeerHost) -> Result<bool, JsValue> {
        self.driver(host).receive_ack(msgno).map_err(error)
    }
    pub fn consumer_ready(&self, host: JsPeerHost) -> Result<(), JsValue> {
        self.driver(host).consumer_ready().map_err(error)
    }
    pub fn keepalive(&self, host: JsPeerHost) -> Result<(), JsValue> {
        self.driver(host).keepalive().map_err(error)
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
    pub fn retire(&self) {
        let mut session = self.inner.borrow_mut();
        session.state.unacked_messages.clear();
        session.clear_runtime();
    }
    pub fn stop_receiving(&self) {
        self.inner.borrow_mut().reorder_queue.clear();
    }
    pub fn stop_protocol(&self) {
        let mut session = self.inner.borrow_mut();
        session.state.unacked_messages.clear();
        session.reorder_queue.clear();
    }
    pub fn proposal_received(&self, host: JsPeerHost) -> Result<(), JsValue> {
        self.inner.borrow_mut().proposal_received().map_err(error)?;
        self.driver(host).request_commit().map_err(error)
    }
    pub fn reject_session(&self, host: JsPeerHost) -> Result<(), JsValue> {
        self.inner.borrow_mut().reject_session().map_err(error)?;
        self.driver(host).request_commit().map_err(error)
    }
    pub fn rejection_complete(&self) -> bool {
        self.inner.borrow().rejection_complete()
    }
    pub fn reject_inbound(&self, host: JsPeerHost) -> Result<(), JsValue> {
        {
            let mut session = self.inner.borrow_mut();
            session.state.disposition = "inbound-reject".into();
            session.discard_outbound();
        }
        self.driver(host).request_commit().map_err(error)
    }
    pub fn failure(&self, reason: String, host: JsPeerHost) -> Result<(), JsValue> {
        self.driver(host).failure(reason).map_err(error)
    }
    pub fn validate_terminal_handoff(
        &self,
        msgno: u64,
        body: &[u8],
        sent: bool,
        acknowledged: bool,
    ) -> Result<(), JsValue> {
        self.inner
            .borrow()
            .validate_terminal_handoff(msgno, body, sent, acknowledged)
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

    /// The durable pre-handshake pairing already records local acceptance.
    /// Restoring it must not allocate another proposal or reset its stream.
    pub fn restore_setup(&self, terms: JsValue, initiator: bool) -> Result<(), JsValue> {
        if self.inner.borrow().setup.is_some() {
            return Err(error("session setup already exists"));
        }
        let terms: SessionTerms = serde_wasm_bindgen::from_value(terms).map_err(error)?;
        self.inner.borrow_mut().setup =
            Some(SetupState::WaitingForWalletAddress { terms, initiator });
        Ok(())
    }

    pub fn wallet_address_requested(&self) -> bool {
        matches!(
            self.inner.borrow().setup,
            Some(SetupState::WaitingForWalletAddress { .. })
        )
    }
    pub fn restore_channel(&self) {
        self.inner.borrow_mut().setup = Some(SetupState::ChannelStarted);
    }

    /// Complete Rust's host request and create the channel within this existing
    /// accepted peer session. The host never supplies a placeholder address.
    pub fn provide_wallet_address(
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
        Ok(result)
    }
}
