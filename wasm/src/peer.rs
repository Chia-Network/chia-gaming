use chia_gaming::peer_session::{
    PeerSession, PreparedCommit, ReceiveAction, ReceivePolicy, ReliableState, SessionTerms,
    SetupState,
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

#[wasm_bindgen]
pub struct PeerProtocol {
    inner: PeerSession,
}

#[wasm_bindgen]
pub fn create_peer_protocol(state: JsValue, policy: JsValue) -> Result<PeerProtocol, JsValue> {
    let state: ReliableState = serde_wasm_bindgen::from_value(state).map_err(error)?;
    let policy: ReceivePolicy = serde_wasm_bindgen::from_value(policy).map_err(error)?;
    Ok(PeerProtocol {
        inner: PeerSession::new(state, policy),
    })
}

#[wasm_bindgen]
impl PeerProtocol {
    pub fn session_id(&self) -> String {
        self.inner.state.session_id.clone()
    }
    pub fn message_number(&self) -> u64 {
        self.inner.state.message_number
    }
    pub fn remote_number(&self) -> u64 {
        self.inner.state.remote_number
    }
    pub fn disposition(&self) -> String {
        self.inner.state.disposition.clone()
    }
    pub fn unacked(&self) -> Result<JsValue, JsValue> {
        js(&self.inner.state.unacked_messages)
    }
    pub fn snapshot(&self) -> Result<JsValue, JsValue> {
        js(&self.inner.state)
    }
    pub fn restore_state(&mut self, state: JsValue) -> Result<(), JsValue> {
        self.inner.state = serde_wasm_bindgen::from_value(state).map_err(error)?;
        Ok(())
    }
    pub fn queued(&self) -> Result<JsValue, JsValue> {
        js(&self
            .inner
            .reorder_queue
            .iter()
            .map(|(msgno, msg)| chia_gaming::peer_session::Message {
                msgno: *msgno,
                msg: msg.clone(),
            })
            .collect::<Vec<_>>())
    }
    pub fn clear_receive_queue(&mut self) {
        self.inner.reorder_queue.clear();
    }
    pub fn remove_queued(&mut self, msgno: u64) {
        self.inner.reorder_queue.remove(&msgno);
    }
    pub fn allocate(&mut self, body: &[u8], disposition: String) -> Result<u64, JsValue> {
        self.inner
            .allocate(body.to_vec(), disposition)
            .map_err(error)
    }
    pub fn receive(
        &mut self,
        msgno: u64,
        body: &[u8],
        deliverable: bool,
        terminal: bool,
    ) -> Result<String, JsValue> {
        self.inner
            .receive(msgno, body.to_vec(), deliverable, terminal)
            .map(|action| {
                match action {
                    ReceiveAction::Queued => "queued",
                    ReceiveAction::Deliver => "deliver",
                    ReceiveAction::Ack => "ack",
                }
                .into()
            })
            .map_err(error)
    }
    pub fn delivery_candidate(&self, msgno: u64, body_size: usize) -> Result<String, JsValue> {
        self.inner
            .delivery_candidate(msgno, body_size)
            .map(str::to_owned)
            .map_err(error)
    }
    pub fn next_message(&self) -> Result<JsValue, JsValue> {
        js(&self.inner.next_message())
    }
    pub fn delivered(&mut self, msgno: u64) {
        self.inner.delivered(msgno);
    }
    pub fn acknowledge(&mut self, ack: u64) -> Result<(), JsValue> {
        self.inner.acknowledge(ack).map_err(error)
    }
    pub fn connectivity(&mut self, event: &str, now: f64, force: bool) -> Result<JsValue, JsValue> {
        js(&self.inner.connectivity(event, now, force).map_err(error)?)
    }
    pub fn sent(&mut self, msgno: u64, accepted: bool) {
        self.inner.sent(msgno, accepted);
    }
    pub fn ack_sent(&mut self, msgno: u64, accepted: bool) {
        self.inner.ack_sent(msgno, accepted);
    }
    pub fn retry_acks(&self) -> Result<JsValue, JsValue> {
        js(&self.inner.retry_acks())
    }
    pub fn dirty(&self) -> bool {
        self.inner.dirty()
    }
    pub fn prepare_commit(&self) -> Result<JsValue, JsValue> {
        js(&self.inner.prepare_commit())
    }
    pub fn complete_commit(
        &mut self,
        commit: JsValue,
        persisted: bool,
    ) -> Result<JsValue, JsValue> {
        let commit: PreparedCommit = serde_wasm_bindgen::from_value(commit).map_err(error)?;
        js(&self.inner.complete_commit(commit, persisted))
    }
    pub fn clear_runtime(&mut self) {
        self.inner.clear_runtime();
    }
    pub fn discard_outbound(&mut self) {
        self.inner.discard_outbound();
    }

    pub fn accept_session(&mut self, terms: JsValue, initiator: bool) -> Result<(), JsValue> {
        self.inner
            .accept(
                serde_wasm_bindgen::from_value(terms).map_err(error)?,
                initiator,
            )
            .map_err(error)
    }

    /// The durable pre-handshake pairing already records local acceptance.
    /// Restoring it must not allocate another proposal or reset its stream.
    pub fn restore_setup(&mut self, terms: JsValue, initiator: bool) -> Result<(), JsValue> {
        if self.inner.setup.is_some() {
            return Err(error("session setup already exists"));
        }
        let terms: SessionTerms = serde_wasm_bindgen::from_value(terms).map_err(error)?;
        self.inner.setup = Some(SetupState::WaitingForWalletAddress { terms, initiator });
        Ok(())
    }

    pub fn wallet_address_requested(&self) -> bool {
        matches!(
            self.inner.setup,
            Some(SetupState::WaitingForWalletAddress { .. })
        )
    }
    pub fn restore_channel(&mut self) {
        self.inner.setup = Some(SetupState::ChannelStarted);
    }

    /// Complete Rust's host request and create the channel within this existing
    /// accepted peer session. The host never supplies a placeholder address.
    pub fn provide_wallet_address(
        &mut self,
        rng_id: i32,
        address: &str,
        genesis_challenge: &str,
    ) -> Result<JsValue, JsValue> {
        let Some(SetupState::WaitingForWalletAddress { terms, initiator }) = &self.inner.setup
        else {
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
        self.inner.setup = Some(SetupState::ChannelStarted);
        Ok(result)
    }
}
