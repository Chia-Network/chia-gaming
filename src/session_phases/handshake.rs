use std::collections::BTreeMap;

use crate::channel_state::types::StateUpdateSignatures;
use crate::common::types::{
    Aggsig, Amount, CoinID, CoinString, PublicKey, PuzzleHash, SpendBundle,
};
use serde::{Deserialize, Serialize};

const PEER_PROTOCOL_CAPABILITY: &str = "peer_protocol";
const PEER_PROTOCOL_VERSION: u32 = 1;
pub(crate) const MAX_PEER_MESSAGE_SIZE: usize = 10 * 1024 * 1024;
pub(crate) const MAX_QUEUED_PEER_MESSAGES: usize = 1024;
pub(crate) const MAX_QUEUED_PEER_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakePayloadB {
    pub capabilities: BTreeMap<String, u32>,
    pub channel_public_key: PublicKey,
    pub unroll_public_key: PublicKey,
    pub reward_puzzle_hash: PuzzleHash,
    pub referee_pubkey: PublicKey,
    pub reward_payout_signature: Aggsig,
    pub channel_key_pop: Aggsig,
    pub unroll_key_pop: Aggsig,
    pub my_contribution: Amount,
    pub their_contribution: Amount,
}

pub fn local_capabilities() -> BTreeMap<String, u32> {
    BTreeMap::from([(PEER_PROTOCOL_CAPABILITY.to_string(), PEER_PROTOCOL_VERSION)])
}

pub fn validate_peer_capabilities(capabilities: &BTreeMap<String, u32>) -> Result<(), String> {
    match capabilities.get(PEER_PROTOCOL_CAPABILITY) {
        Some(&PEER_PROTOCOL_VERSION) => Ok(()),
        Some(version) => Err(format!(
            "unsupported peer protocol version {version}, expected {PEER_PROTOCOL_VERSION}"
        )),
        None => Err(format!(
            "missing required {PEER_PROTOCOL_CAPABILITY} capability"
        )),
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakePayloadC {
    pub launcher_coin: CoinString,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakePayloadD {
    pub signatures: StateUpdateSignatures,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakePayloadE {
    pub bundle: SpendBundle,
    pub signatures: StateUpdateSignatures,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakePayloadF {
    pub bundle: SpendBundle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeStepInfo {
    pub first_player_hs_info: HandshakePayloadB,
    pub second_player_hs_info: HandshakePayloadB,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoinSpendRequest {
    pub amount: Amount,
    pub conditions: Vec<RawCoinCondition>,
    pub coin_id: Option<CoinID>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_height: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawCoinCondition {
    pub opcode: u32,
    pub args: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeStepWithSpend {
    pub info: HandshakeStepInfo,
    pub spend: SpendBundle,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_capabilities_advertise_peer_protocol_one() {
        assert_eq!(
            local_capabilities().get(PEER_PROTOCOL_CAPABILITY),
            Some(&PEER_PROTOCOL_VERSION)
        );
    }

    #[test]
    fn peer_capabilities_require_peer_protocol_one_and_ignore_unknown_keys() {
        let mut capabilities = local_capabilities();
        capabilities.insert("future_feature".to_string(), 99);
        validate_peer_capabilities(&capabilities).expect("unknown capabilities are ignored");

        capabilities.remove(PEER_PROTOCOL_CAPABILITY);
        assert!(validate_peer_capabilities(&capabilities).is_err());

        capabilities.insert(PEER_PROTOCOL_CAPABILITY.to_string(), 2);
        assert!(validate_peer_capabilities(&capabilities).is_err());
    }

    #[test]
    fn hostile_peer_receive_defaults_are_generous_local_policy() {
        assert_eq!(MAX_PEER_MESSAGE_SIZE, 10 * 1024 * 1024);
        assert_eq!(MAX_QUEUED_PEER_MESSAGES, 1024);
        assert_eq!(MAX_QUEUED_PEER_BYTES, 64 * 1024 * 1024);
    }
}
