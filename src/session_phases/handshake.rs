use std::collections::BTreeMap;

use crate::channel_state::types::StateUpdateSignatures;
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinCondition, CoinID, CoinString, Error, Hash, PublicKey,
    PuzzleHash, SpendBundle,
};
use serde::{Deserialize, Serialize};

const PEER_PROTOCOL_CAPABILITY: &str = "p";
const PEER_PROTOCOL_VERSION: u32 = 1;
pub(crate) const MAX_PEER_MESSAGE_SIZE: usize = 10 * 1024 * 1024;
pub(crate) const MAX_QUEUED_PEER_MESSAGES: usize = 1024;
pub(crate) const MAX_QUEUED_PEER_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakePayloadB {
    #[serde(rename = "v")]
    pub capabilities: BTreeMap<String, u32>,
    #[serde(rename = "ck")]
    pub channel_public_key: PublicKey,
    #[serde(rename = "uk")]
    pub unroll_public_key: PublicKey,
    #[serde(rename = "rh")]
    pub reward_puzzle_hash: PuzzleHash,
    #[serde(rename = "rk")]
    pub referee_pubkey: PublicKey,
    #[serde(rename = "rs")]
    pub reward_payout_signature: Aggsig,
    #[serde(rename = "cp")]
    pub channel_key_pop: Aggsig,
    #[serde(rename = "up")]
    pub unroll_key_pop: Aggsig,
    #[serde(rename = "mc")]
    pub my_contribution: Amount,
    #[serde(rename = "tc")]
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
    #[serde(rename = "lc")]
    pub launcher_coin: CoinString,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakePayloadD {
    #[serde(rename = "s")]
    pub signatures: StateUpdateSignatures,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakePayloadE {
    #[serde(rename = "b")]
    pub bundle: SpendBundle,
    #[serde(rename = "s")]
    pub signatures: StateUpdateSignatures,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakePayloadF {
    /// Receiver wallet acceptance only. It must not repeat spends from E.
    #[serde(rename = "b")]
    pub bundle: SpendBundle,
}

/// Assemble the funding transaction from the initiator's E bundle and the
/// receiver's F acceptance. The initiator is authoritative for this combination;
/// F is not a trusted already-combined transaction.
pub fn combine_channel_funding_bundles(
    initiator_bundle: &SpendBundle,
    receiver_acceptance: &SpendBundle,
) -> Result<SpendBundle, Error> {
    if initiator_bundle.spends.is_empty() {
        return Err(Error::StrErr(
            "initiator funding bundle has no spends".to_string(),
        ));
    }
    if receiver_acceptance.spends.is_empty() {
        return Err(Error::StrErr(
            "handshake F acceptance has no spends".to_string(),
        ));
    }
    let mut spends = initiator_bundle.spends.clone();
    spends.extend(receiver_acceptance.spends.iter().cloned());
    Ok(SpendBundle { name: None, spends })
}

/// Require the receiver's acceptance to be atomic with this channel launcher.
pub fn receiver_acceptance_asserts_funding_announcement(
    allocator: &mut AllocEncoder,
    acceptance: &SpendBundle,
    expected_announcement: &Hash,
) -> Result<(), Error> {
    let expected = expected_announcement.bytes().to_vec();
    for spend in &acceptance.spends {
        let puzzle = spend.bundle.puzzle.to_program();
        let solution = spend.bundle.solution.p();
        let Ok(conditions) =
            CoinCondition::from_puzzle_and_solution(allocator, puzzle.as_ref(), solution.as_ref())
        else {
            continue;
        };
        if conditions.iter().any(|condition| {
            matches!(
                condition,
                CoinCondition::AssertCoinAnnouncement(arg) if *arg == expected
            )
        }) {
            return Ok(());
        }
    }
    Err(Error::StrErr(
        "handshake F does not assert the launcher announcement".to_string(),
    ))
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
    use clvm_traits::ToClvm;

    use crate::common::constants::{
        AGG_SIG_ME_ADDITIONAL_DATA, ASSERT_COIN_ANNOUNCEMENT, CREATE_COIN_ANNOUNCEMENT,
    };
    use crate::common::types::{
        AllocEncoder, CoinSpend, Hash, Program, Puzzle, Sha256Input, Sha256tree, Spend,
        ToQuotedProgram,
    };

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

    fn coin_for_puzzle(tag: u8, puzzle: &Puzzle, allocator: &mut AllocEncoder) -> CoinString {
        CoinString::from_parts(
            &CoinID::new(Hash::from_bytes([tag; 32])),
            &puzzle.sha256tree(allocator),
            &Amount::new(1),
        )
    }

    fn spend_for_conditions(
        allocator: &mut AllocEncoder,
        tag: u8,
        conditions: clvmr::NodePtr,
    ) -> CoinSpend {
        let puzzle: Puzzle = conditions
            .to_quoted_program(allocator)
            .expect("quoted conditions")
            .into();
        CoinSpend {
            coin: coin_for_puzzle(tag, &puzzle, allocator),
            bundle: Spend {
                puzzle,
                solution: Program::from_bytes(&[0x80]).into(),
                signature: Aggsig::default(),
            },
        }
    }

    fn announcement_bound_bundles(allocator: &mut AllocEncoder) -> (SpendBundle, SpendBundle) {
        let message = Hash::from_bytes([0xab; 32]);
        let create_conditions = ((CREATE_COIN_ANNOUNCEMENT, (message.clone(), ())), ())
            .to_clvm(allocator)
            .expect("create announcement conditions");
        let initiator_spend = spend_for_conditions(allocator, 1, create_conditions);
        let announcement_id = Sha256Input::Array(vec![
            Sha256Input::Bytes(initiator_spend.coin.to_coin_id().bytes()),
            Sha256Input::Bytes(message.bytes()),
        ])
        .hash();
        let assert_conditions = ((ASSERT_COIN_ANNOUNCEMENT, (announcement_id, ())), ())
            .to_clvm(allocator)
            .expect("assert announcement conditions");
        let receiver_spend = spend_for_conditions(allocator, 2, assert_conditions);
        (
            SpendBundle {
                name: None,
                spends: vec![initiator_spend],
            },
            SpendBundle {
                name: None,
                spends: vec![receiver_spend],
            },
        )
    }

    #[test]
    fn combine_channel_funding_bundles_preserves_e_then_f_and_rejects_empty_halves() {
        let mut allocator = AllocEncoder::new();
        let (initiator, receiver) = announcement_bound_bundles(&mut allocator);
        let combined =
            combine_channel_funding_bundles(&initiator, &receiver).expect("non-empty halves");
        assert_eq!(combined.spends.len(), 2);
        assert_eq!(combined.spends[0].coin, initiator.spends[0].coin);
        assert_eq!(combined.spends[1].coin, receiver.spends[0].coin);

        let empty = SpendBundle {
            name: None,
            spends: vec![],
        };
        assert!(combine_channel_funding_bundles(&empty, &receiver).is_err());
        assert!(combine_channel_funding_bundles(&initiator, &empty).is_err());
    }

    #[test]
    fn combined_consensus_validation_resolves_cross_bundle_announcement() {
        let mut allocator = AllocEncoder::new();
        let (initiator, receiver) = announcement_bound_bundles(&mut allocator);
        let combined =
            combine_channel_funding_bundles(&initiator, &receiver).expect("combine E and F");
        let additional_data = Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA);
        combined
            .validate_consensus(&additional_data, 1)
            .expect("announcement assertion is satisfied by E");
        assert!(receiver.validate_consensus(&additional_data, 1).is_err());
    }

    #[test]
    fn combined_consensus_validation_rejects_duplicate_coin_spends() {
        let mut allocator = AllocEncoder::new();
        let (initiator, _) = announcement_bound_bundles(&mut allocator);
        let duplicated =
            combine_channel_funding_bundles(&initiator, &initiator).expect("combine duplicates");
        let error = duplicated
            .validate_consensus(&Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA), 1)
            .expect_err("same coin spent twice");
        assert!(format!("{error:?}").contains("DoubleSpend"));
    }
}
