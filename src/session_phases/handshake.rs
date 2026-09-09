use std::collections::BTreeMap;

use clvm_traits::{ClvmEncoder, ToClvm};

use crate::channel_state::types::{ChannelPrivateKeys, StateUpdateSignatures};
use crate::channel_state::ChannelState;
use crate::common::constants::{
    ASSERT_BEFORE_HEIGHT_ABSOLUTE, ASSERT_COIN_ANNOUNCEMENT, CREATE_COIN, CREATE_COIN_ANNOUNCEMENT,
};
use crate::common::standard_coin::verify_reward_payout_signature;
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinCondition, CoinID, CoinString, Error, Hash, IntoErr, Node,
    PublicKey, PuzzleHash, SpendBundle,
};
use serde::{Deserialize, Serialize};

const PEER_PROTOCOL_CAPABILITY: &str = "p";
const PEER_PROTOCOL_VERSION: u32 = 1;
pub(crate) const MAX_PEER_MESSAGE_SIZE: usize = 10 * 1024 * 1024;
pub(crate) const MAX_QUEUED_PEER_MESSAGES: usize = 1024;
pub(crate) const MAX_QUEUED_PEER_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize, Debug, Eq, PartialEq)]
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

pub fn validate_ab_payload(
    payload: &HandshakePayloadB,
    private_keys: &ChannelPrivateKeys,
    reward_puzzle_hash: &PuzzleHash,
    my_contribution: &Amount,
    their_contribution: &Amount,
) -> Result<(), Error> {
    validate_peer_capabilities(&payload.capabilities).map_err(Error::Channel)?;

    if payload.my_contribution != *their_contribution {
        return Err(Error::Channel(format!(
            "Handshake contribution mismatch: peer claims my_contribution={:?} but we expect their_contribution={:?}",
            payload.my_contribution, their_contribution
        )));
    }
    if payload.their_contribution != *my_contribution {
        return Err(Error::Channel(format!(
            "Handshake contribution mismatch: peer claims their_contribution={:?} but we expect my_contribution={:?}",
            payload.their_contribution, my_contribution
        )));
    }

    if !verify_reward_payout_signature(
        &payload.referee_pubkey,
        &payload.reward_puzzle_hash,
        &payload.reward_payout_signature,
    ) {
        return Err(Error::Channel(
            "Invalid reward payout signature in handshake".to_string(),
        ));
    }

    if !payload.channel_key_pop.verify(
        &payload.channel_public_key,
        &payload.channel_public_key.bytes(),
    ) {
        return Err(Error::Channel(
            "Invalid proof-of-possession for channel key".to_string(),
        ));
    }
    if !payload.unroll_key_pop.verify(
        &payload.unroll_public_key,
        &payload.unroll_public_key.bytes(),
    ) {
        return Err(Error::Channel(
            "Invalid proof-of-possession for unroll key".to_string(),
        ));
    }

    ChannelState::validate_peer_identity_separation(
        private_keys,
        reward_puzzle_hash,
        &payload.channel_public_key,
        &payload.unroll_public_key,
        &payload.referee_pubkey,
        &payload.reward_puzzle_hash,
    )
}

#[derive(Clone, Serialize, Deserialize, Debug, Eq, PartialEq)]
pub struct HandshakePayloadC {
    pub launcher_coin: CoinString,
}

#[derive(Clone, Serialize, Deserialize, Debug, Eq, PartialEq)]
pub struct HandshakePayloadD {
    pub signatures: StateUpdateSignatures,
}

#[derive(Clone, Serialize, Deserialize, Debug, Eq, PartialEq)]
pub struct HandshakePayloadE {
    pub bundle: SpendBundle,
    pub signatures: StateUpdateSignatures,
}

#[derive(Clone, Serialize, Deserialize, Debug, Eq, PartialEq)]
pub struct HandshakePayloadF {
    /// Receiver wallet acceptance only. It must not repeat spends from E.
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

/// Validate and combine the independently assembled halves of channel funding.
pub fn validate_assembled_channel_funding(
    allocator: &mut AllocEncoder,
    initiator_bundle: &SpendBundle,
    receiver_acceptance: &SpendBundle,
    expected_announcement: &Hash,
    agg_sig_me_additional_data: &Hash,
    height: u64,
) -> Result<SpendBundle, Error> {
    require_concentrated_funding_signature(initiator_bundle, "handshake E")?;
    require_concentrated_funding_signature(receiver_acceptance, "handshake F")?;
    let combined = combine_channel_funding_bundles(initiator_bundle, receiver_acceptance)?;
    combined.validate_consensus(agg_sig_me_additional_data, height)?;
    receiver_acceptance_asserts_funding_announcement(
        allocator,
        receiver_acceptance,
        expected_announcement,
    )?;
    Ok(combined)
}

fn require_concentrated_funding_signature(
    bundle: &SpendBundle,
    bundle_name: &str,
) -> Result<(), Error> {
    if bundle.spends.is_empty() {
        return Err(Error::StrErr(format!(
            "{bundle_name} funding bundle has no spends"
        )));
    }
    let signature_count = bundle
        .spends
        .iter()
        .filter(|spend| !spend.bundle.signature.is_twos_complement_zero())
        .count();
    if signature_count != 1 {
        return Err(Error::StrErr(format!(
            "{bundle_name} must contain exactly one aggregate signature field, found {signature_count}"
        )));
    }
    Ok(())
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

pub fn raw_coin_conditions_to_clvm(
    allocator: &mut AllocEncoder,
    conditions: &[RawCoinCondition],
    max_height: Option<u64>,
) -> Result<Vec<Node>, Error> {
    let mut nodes = Vec::with_capacity(conditions.len() + usize::from(max_height.is_some()));
    for condition in conditions {
        let expected_args = match condition.opcode {
            CREATE_COIN => 2,
            ASSERT_COIN_ANNOUNCEMENT | CREATE_COIN_ANNOUNCEMENT | ASSERT_BEFORE_HEIGHT_ABSOLUTE => {
                1
            }
            opcode => {
                return Err(Error::StrErr(format!(
                    "unsupported wallet condition opcode {opcode}"
                )));
            }
        };
        if condition.args.len() != expected_args {
            return Err(Error::StrErr(format!(
                "wallet condition opcode {} requires {expected_args} args, got {}",
                condition.opcode,
                condition.args.len()
            )));
        }

        let mut parts = Vec::with_capacity(condition.args.len() + 1);
        parts.push(Node(condition.opcode.to_clvm(allocator).into_gen()?));
        for arg in &condition.args {
            parts.push(Node(
                allocator
                    .encode_atom(clvm_traits::Atom::Borrowed(arg))
                    .into_gen()?,
            ));
        }
        nodes.push(Node(parts.to_clvm(allocator).into_gen()?));
    }
    if let Some(max_height) = max_height {
        nodes.push(Node(
            (ASSERT_BEFORE_HEIGHT_ABSOLUTE, (max_height, ()))
                .to_clvm(allocator)
                .into_gen()?,
        ));
    }
    Ok(nodes)
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
    use crate::common::standard_coin::{private_to_public_key, sign_reward_payout};
    use crate::common::types::{
        AllocEncoder, CoinSpend, Hash, PrivateKey, Program, Puzzle, Sha256Input, Sha256tree, Spend,
        ToQuotedProgram,
    };
    use crate::utils::proper_list;

    fn private_key(tag: u8) -> PrivateKey {
        PrivateKey::from_bytes(&[tag; 32]).expect("test private key")
    }

    fn private_keys(tags: [u8; 3]) -> ChannelPrivateKeys {
        ChannelPrivateKeys {
            my_channel_coin_private_key: private_key(tags[0]),
            my_unroll_coin_private_key: private_key(tags[1]),
            my_referee_private_key: private_key(tags[2]),
        }
    }

    fn payload_for(keys: &ChannelPrivateKeys, reward_tag: u8) -> HandshakePayloadB {
        let channel_public_key = private_to_public_key(&keys.my_channel_coin_private_key);
        let unroll_public_key = private_to_public_key(&keys.my_unroll_coin_private_key);
        let referee_pubkey = private_to_public_key(&keys.my_referee_private_key);
        let reward_puzzle_hash = PuzzleHash::from_bytes([reward_tag; 32]);
        HandshakePayloadB {
            capabilities: local_capabilities(),
            channel_key_pop: keys
                .my_channel_coin_private_key
                .sign(channel_public_key.bytes()),
            unroll_key_pop: keys
                .my_unroll_coin_private_key
                .sign(unroll_public_key.bytes()),
            reward_payout_signature: sign_reward_payout(
                &keys.my_referee_private_key,
                &reward_puzzle_hash,
            ),
            channel_public_key,
            unroll_public_key,
            reward_puzzle_hash,
            referee_pubkey,
            my_contribution: Amount::new(200),
            their_contribution: Amount::new(100),
        }
    }

    #[test]
    fn local_capabilities_advertise_peer_protocol_one() {
        assert_eq!(
            local_capabilities().get(PEER_PROTOCOL_CAPABILITY),
            Some(&PEER_PROTOCOL_VERSION)
        );
    }

    #[test]
    fn wallet_adapters_share_raw_conditions_and_append_max_height() {
        fn atoms(allocator: &AllocEncoder, nodes: Vec<Node>) -> Vec<Vec<Vec<u8>>> {
            nodes
                .into_iter()
                .map(|node| {
                    proper_list(allocator.allocator_ref(), node.0, true)
                        .expect("condition list")
                        .into_iter()
                        .map(|part| allocator.allocator_ref().atom(part).to_vec())
                        .collect::<Vec<_>>()
                })
                .collect()
        }

        let request_conditions = vec![
            RawCoinCondition {
                opcode: CREATE_COIN,
                args: vec![vec![7; 32], vec![42]],
            },
            RawCoinCondition {
                opcode: ASSERT_COIN_ANNOUNCEMENT,
                args: vec![vec![8; 32]],
            },
            RawCoinCondition {
                opcode: CREATE_COIN_ANNOUNCEMENT,
                args: vec![b"created".to_vec()],
            },
            RawCoinCondition {
                opcode: ASSERT_BEFORE_HEIGHT_ABSOLUTE,
                args: vec![vec![99]],
            },
        ];
        let mut allocator = AllocEncoder::new();
        let simulator_nodes =
            raw_coin_conditions_to_clvm(&mut allocator, &request_conditions, Some(100))
                .expect("simulator wallet conditions");
        let peer_harness_nodes =
            raw_coin_conditions_to_clvm(&mut allocator, &request_conditions, Some(100))
                .expect("peer harness wallet conditions");

        assert_eq!(
            atoms(&allocator, simulator_nodes),
            atoms(&allocator, peer_harness_nodes)
        );
        let all_nodes = raw_coin_conditions_to_clvm(&mut allocator, &request_conditions, Some(100))
            .expect("wallet conditions");
        assert_eq!(
            atoms(&allocator, all_nodes),
            vec![
                vec![vec![CREATE_COIN as u8], vec![7; 32], vec![42]],
                vec![vec![ASSERT_COIN_ANNOUNCEMENT as u8], vec![8; 32]],
                vec![vec![CREATE_COIN_ANNOUNCEMENT as u8], b"created".to_vec()],
                vec![vec![ASSERT_BEFORE_HEIGHT_ABSOLUTE as u8], vec![99]],
                vec![vec![ASSERT_BEFORE_HEIGHT_ABSOLUTE as u8], vec![100]],
            ]
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
    fn ab_payload_rejects_all_nine_cross_peer_key_collisions() {
        let local = private_keys([1, 2, 3]);
        let local_keys = [
            local.my_channel_coin_private_key.clone(),
            local.my_unroll_coin_private_key.clone(),
            local.my_referee_private_key.clone(),
        ];

        for local_key in &local_keys {
            for peer_role in 0..3 {
                let mut peer_keys = private_keys([4, 5, 6]);
                match peer_role {
                    0 => peer_keys.my_channel_coin_private_key = local_key.clone(),
                    1 => peer_keys.my_unroll_coin_private_key = local_key.clone(),
                    2 => peer_keys.my_referee_private_key = local_key.clone(),
                    _ => unreachable!(),
                }
                let payload = payload_for(&peer_keys, 8);
                let error = validate_ab_payload(
                    &payload,
                    &local,
                    &PuzzleHash::from_bytes([7; 32]),
                    &Amount::new(100),
                    &Amount::new(200),
                )
                .expect_err("cross-peer key collision");
                assert!(
                    format!("{error:?}").contains("public key collision"),
                    "local key against peer role {peer_role}: {error:?}"
                );
            }
        }
    }

    #[test]
    fn ab_payload_validates_all_non_identity_fields_and_reward_hash_separation() {
        let local = private_keys([1, 2, 3]);
        let local_reward = PuzzleHash::from_bytes([7; 32]);
        let valid = payload_for(&private_keys([4, 5, 6]), 8);
        validate_ab_payload(
            &valid,
            &local,
            &local_reward,
            &Amount::new(100),
            &Amount::new(200),
        )
        .expect("valid payload");

        let mut invalid = valid.clone();
        invalid.capabilities.clear();
        assert!(validate_ab_payload(
            &invalid,
            &local,
            &local_reward,
            &Amount::new(100),
            &Amount::new(200)
        )
        .is_err());

        let mut invalid = valid.clone();
        invalid.my_contribution = Amount::new(201);
        assert!(validate_ab_payload(
            &invalid,
            &local,
            &local_reward,
            &Amount::new(100),
            &Amount::new(200)
        )
        .is_err());

        let mut invalid = valid.clone();
        invalid.reward_payout_signature = Aggsig::default();
        assert!(validate_ab_payload(
            &invalid,
            &local,
            &local_reward,
            &Amount::new(100),
            &Amount::new(200)
        )
        .is_err());

        let mut invalid = valid.clone();
        invalid.channel_key_pop = Aggsig::default();
        assert!(validate_ab_payload(
            &invalid,
            &local,
            &local_reward,
            &Amount::new(100),
            &Amount::new(200)
        )
        .is_err());

        let mut invalid = valid.clone();
        invalid.unroll_key_pop = Aggsig::default();
        assert!(validate_ab_payload(
            &invalid,
            &local,
            &local_reward,
            &Amount::new(100),
            &Amount::new(200)
        )
        .is_err());

        let same_reward_peer = payload_for(&private_keys([4, 5, 6]), 7);
        assert!(validate_ab_payload(
            &same_reward_peer,
            &local,
            &local_reward,
            &Amount::new(100),
            &Amount::new(200)
        )
        .is_err());
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

    #[test]
    fn funding_halves_require_one_concentrated_signature_field() {
        let mut allocator = AllocEncoder::new();
        let (mut initiator, _) = announcement_bound_bundles(&mut allocator);
        let error = require_concentrated_funding_signature(&initiator, "handshake E")
            .expect_err("unsigned half");
        assert!(format!("{error:?}").contains("found 0"));

        let key = crate::common::types::PrivateKey::from_bytes(&[7; 32]).expect("test key");
        initiator.spends[0].bundle.signature = key.sign(b"aggregate");
        require_concentrated_funding_signature(&initiator, "handshake E")
            .expect("one aggregate field");

        initiator.spends.push(initiator.spends[0].clone());
        let error = require_concentrated_funding_signature(&initiator, "handshake E")
            .expect_err("per-input signature fields");
        assert!(format!("{error:?}").contains("found 2"));
    }
}
