use super::gaming_wasm::Channel;
use chia_gaming::common::types::Sha256Input;
use chia_gaming::peer_session::coordination::{HostStatus, ReceiveMode};
use chia_gaming::peer_session::session::{PeerEvent, PeerHost, PeerInput, SendFrame, Session};
use chia_gaming::peer_session::{PreparedCommit, ReceivePolicy};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

fn error(value: impl ToString) -> JsValue {
    js_sys::Error::new(&value.to_string()).into()
}
fn js(value: &impl Serialize) -> Result<JsValue, JsValue> {
    value.serialize(&serializer()).map_err(error)
}
fn serializer() -> serde_wasm_bindgen::Serializer {
    serde_wasm_bindgen::Serializer::new()
        .serialize_maps_as_objects(true)
        .serialize_large_number_types_as_bigints(true)
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
    fn notify(&self, event: PeerEvent) -> Result<(), String> {
        let event = if let PeerEvent::ChannelResult(output) = event {
            let result =
                super::gaming_wasm::channel_output_to_js(&output).map_err(|e| e.to_string())?;
            let event = js_sys::Object::new();
            js_sys::Reflect::set(&event, &"type".into(), &"channel-result".into())
                .map_err(host_error)?;
            js_sys::Reflect::set(&event, &"result".into(), &result).map_err(host_error)?;
            event.into()
        } else {
            js(&event).map_err(host_error)?
        };
        self.notify_js(event).map(|_| ()).map_err(host_error)
    }
}

#[wasm_bindgen]
pub struct PeerProtocol {
    pub(super) inner: Session<Channel>,
    seed: [u8; 32],
}

#[wasm_bindgen]
pub fn create_peer_protocol(
    state: JsValue,
    policy: JsValue,
    seed: &str,
) -> Result<PeerProtocol, JsValue> {
    let inner = Session::new(
        serde_wasm_bindgen::from_value(state).map_err(error)?,
        serde_wasm_bindgen::from_value::<ReceivePolicy>(policy).map_err(error)?,
    );
    Ok(PeerProtocol {
        inner,
        seed: *Sha256Input::Bytes(seed.as_bytes()).hash().bytes(),
    })
}

impl PeerProtocol {
    fn attach_channel(&self, channel: Channel) -> Result<(), JsValue> {
        let command = channel.pending_terminal();
        self.inner.attach_channel(channel, command).map_err(error)
    }
}

#[wasm_bindgen]
impl PeerProtocol {
    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        self.inner.snapshot(&serializer()).map_err(error)
    }
    pub fn restore(&self, state: JsValue, terminal: JsValue) -> Result<(), JsValue> {
        self.inner
            .restore(
                serde_wasm_bindgen::from_value(state).map_err(error)?,
                serde_wasm_bindgen::from_value(terminal).map_err(error)?,
            )
            .map_err(error)
    }
    pub fn receive(&self, input: JsValue, host: JsPeerHost) -> Result<bool, JsValue> {
        self.inner
            .receive(
                serde_wasm_bindgen::from_value::<PeerInput>(input).map_err(error)?,
                &host,
            )
            .map_err(error)
    }
    pub fn consumer_ready(&self, mode: JsValue, host: JsPeerHost) -> Result<(), JsValue> {
        let mode = if self.inner.accepted() {
            ReceiveMode::Channel
        } else {
            serde_wasm_bindgen::from_value::<ReceiveMode>(mode).map_err(error)?
        };
        self.inner.consumer_ready(mode, &host).map_err(error)
    }
    pub fn connectivity(
        &self,
        event: &str,
        now: f64,
        force: bool,
        host: JsPeerHost,
    ) -> Result<bool, JsValue> {
        self.inner
            .connectivity(event, now, force, &host)
            .map_err(error)
    }
    pub fn dirty(&self) -> bool {
        self.inner.dirty()
    }
    pub fn prepare_commit(&self) -> Result<JsValue, JsValue> {
        js(&self.inner.prepare_commit())
    }
    pub fn complete_commit(
        &self,
        commit: JsValue,
        persisted: bool,
        host: JsPeerHost,
    ) -> Result<(), JsValue> {
        let commit: PreparedCommit = serde_wasm_bindgen::from_value(commit).map_err(error)?;
        self.inner
            .complete_commit(commit, persisted, &host)
            .map_err(error)
    }
    pub fn retire(&self, retain_rejection: bool) -> bool {
        self.inner.retire(retain_rejection)
    }
    pub fn reject_session(&self, host: JsPeerHost) -> Result<(), JsValue> {
        self.inner.reject_session(&host).map_err(error)
    }
    pub fn failure(&self, reason: String, host: JsPeerHost) -> Result<(), JsValue> {
        self.inner.failure(reason, &host).map_err(error)
    }
    pub fn accept_session(&self, terms: JsValue, initiator: bool) -> Result<(), JsValue> {
        self.inner
            .accept_session(
                serde_wasm_bindgen::from_value(terms).map_err(error)?,
                initiator,
            )
            .map_err(error)
    }

    pub fn restore_channel(&self, data: &[u8]) -> Result<(), JsValue> {
        let channel = super::gaming_wasm::restore_channel(data, self.seed).map_err(error)?;
        self.attach_channel(channel)
    }

    /// The host implements only the address RPC. Rust owns setup resumption,
    /// the wait, cancellation on retirement, and construction of the channel.
    pub async fn open_channel(
        &self,
        terms: JsValue,
        initiator: bool,
        genesis_challenge: String,
        address_provider: js_sys::Function,
    ) -> Result<JsValue, JsValue> {
        if self.inner.retired() {
            return Ok(JsValue::UNDEFINED);
        }
        self.inner
            .prepare_channel(
                serde_wasm_bindgen::from_value(terms).map_err(error)?,
                initiator,
            )
            .map_err(error)?;
        let response = address_provider.call0(&JsValue::UNDEFINED)?;
        let address = JsFuture::from(js_sys::Promise::resolve(&response)).await?;
        if self.inner.retired() {
            return Ok(JsValue::UNDEFINED);
        }
        let address = address
            .as_string()
            .ok_or_else(|| error("wallet address must be a string"))?;
        self.provide_wallet_address(&address, &genesis_challenge)
    }
}

impl PeerProtocol {
    /// Complete Rust's host request and create the channel within this existing
    /// accepted peer session. The host never supplies a placeholder address.
    fn provide_wallet_address(
        &self,
        address: &str,
        genesis_challenge: &str,
    ) -> Result<JsValue, JsValue> {
        let (terms, initiator) = self.inner.channel_terms().map_err(error)?;
        let amount = |value: &str| value.parse::<u64>().map_err(error);
        let timeout = |value: &Option<String>| {
            value
                .as_ref()
                .map(|v| v.parse::<i32>().map_err(error))
                .unwrap_or(Ok(15))
        };
        let (mine, theirs) = if initiator {
            (&terms.proposer_amount, &terms.responder_amount)
        } else {
            (&terms.responder_amount, &terms.proposer_amount)
        };
        let config = super::gaming_wasm::ChannelConfig {
            is_initiator: initiator,
            my_contribution: chia_gaming::common::types::Amount::new(amount(mine)?),
            their_contribution: chia_gaming::common::types::Amount::new(amount(theirs)?),
            channel_timeout: timeout(&terms.channel_timeout)?,
            unroll_timeout: timeout(&terms.unroll_timeout)?,
            reward_puzzle_hash: address.into(),
            genesis_challenge: genesis_challenge.into(),
        };
        let (channel, puzzle_hash) =
            super::gaming_wasm::create_channel(config, self.seed).map_err(error)?;
        self.attach_channel(channel)?;
        js(&super::gaming_wasm::ChannelCreated {
            puzzle_hash,
            reward_puzzle_hash: Some(address.into()),
        })
    }
}
