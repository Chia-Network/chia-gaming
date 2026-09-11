use std::collections::BTreeMap;

use bencodex::Value;

use crate::channel_state::types::StateUpdateSignatures;
use crate::common::types::{
    Aggsig, Amount, CoinSpend, CoinString, Error, GameID, GameType, Hash, Program, PublicKey,
    Puzzle, PuzzleHash, Spend, SpendBundle, Timeout,
};
use crate::referee::types::GameMoveStateInfo;
use crate::session_phases::handshake::{
    HandshakePayloadB, HandshakePayloadC, HandshakePayloadD, HandshakePayloadE, HandshakePayloadF,
};
use crate::session_phases::proposal::{GameProposal, ProposalParameters};
use crate::session_phases::types::{
    BatchAction, PeerMessage, PeerMove, WireGameSpec, WireProposalGroup,
};

pub fn encode_peer_message(message: &PeerMessage) -> Result<Vec<u8>, Error> {
    bencodex::encode(&peer_message_to_value(message)?).map_err(wire_error)
}

pub fn decode_peer_message(input: &[u8]) -> Result<PeerMessage, Error> {
    peer_message_from_value(bencodex::parse(input).map_err(wire_error)?)
}

fn wire_error(error: impl std::fmt::Display) -> Error {
    Error::StrErr(format!("peer wire error: {error}"))
}

fn text(value: impl Into<String>) -> Value {
    Value::Text(value.into())
}

fn bytes(value: &[u8]) -> Value {
    Value::Bytes(value.to_vec())
}

fn integer(value: u64) -> Value {
    Value::Integer(i128::from(value))
}

fn dict(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Dictionary(
        entries
            .into_iter()
            .map(|(key, value)| (text(key), value))
            .collect(),
    )
}

fn tagged(tag: &'static str, value: Value) -> Value {
    dict([(tag, value)])
}

fn expect_dict(value: Value) -> Result<BTreeMap<String, Value>, Error> {
    let Value::Dictionary(entries) = value else {
        return Err(wire_error("expected dictionary"));
    };
    entries
        .into_iter()
        .map(|(key, value)| match key {
            Value::Text(key) => Ok((key, value)),
            _ => Err(wire_error("expected text dictionary key")),
        })
        .collect()
}

fn expect_exact<const N: usize>(
    value: Value,
    keys: [&str; N],
) -> Result<BTreeMap<String, Value>, Error> {
    let map = expect_dict(value)?;
    if map.len() != N || keys.iter().any(|key| !map.contains_key(*key)) {
        return Err(wire_error(format!(
            "expected fields {keys:?}, got {:?}",
            map.keys().collect::<Vec<_>>()
        )));
    }
    Ok(map)
}

fn take(map: &mut BTreeMap<String, Value>, key: &str) -> Result<Value, Error> {
    map.remove(key)
        .ok_or_else(|| wire_error(format!("missing field {key}")))
}

fn expect_tag(value: Value) -> Result<(String, Value), Error> {
    let mut map = expect_dict(value)?;
    if map.len() != 1 {
        return Err(wire_error("expected one protocol tag"));
    }
    Ok(map.pop_first().expect("length checked"))
}

fn expect_list(value: Value) -> Result<Vec<Value>, Error> {
    match value {
        Value::List(values) => Ok(values),
        _ => Err(wire_error("expected list")),
    }
}

fn expect_bytes(value: Value) -> Result<Vec<u8>, Error> {
    match value {
        Value::Bytes(value) => Ok(value),
        _ => Err(wire_error("expected bytes")),
    }
}

fn expect_text(value: Value) -> Result<String, Error> {
    match value {
        Value::Text(value) => Ok(value),
        _ => Err(wire_error("expected text")),
    }
}

fn expect_bool(value: Value) -> Result<bool, Error> {
    match value {
        Value::Bool(value) => Ok(value),
        _ => Err(wire_error("expected boolean")),
    }
}

fn expect_u64(value: Value) -> Result<u64, Error> {
    match value {
        Value::Integer(value) => {
            u64::try_from(value).map_err(|_| wire_error("integer is outside u64"))
        }
        _ => Err(wire_error("expected integer")),
    }
}

fn expect_u32(value: Value) -> Result<u32, Error> {
    u32::try_from(expect_u64(value)?).map_err(|_| wire_error("integer is outside u32"))
}

fn hash_to_value(value: &Hash) -> Value {
    bytes(value.bytes())
}

fn hash_from_value(value: Value) -> Result<Hash, Error> {
    Hash::from_slice(&expect_bytes(value)?)
}

fn puzzle_hash_to_value(value: &PuzzleHash) -> Value {
    bytes(value.bytes())
}

fn puzzle_hash_from_value(value: Value) -> Result<PuzzleHash, Error> {
    Ok(PuzzleHash::from_hash(hash_from_value(value)?))
}

fn public_key_to_value(value: &PublicKey) -> Value {
    bytes(&value.bytes())
}

fn public_key_from_value(value: Value) -> Result<PublicKey, Error> {
    PublicKey::from_slice(&expect_bytes(value)?)
}

fn signature_to_value(value: &Aggsig) -> Value {
    if value.is_twos_complement_zero() {
        bytes(&[])
    } else {
        bytes(&value.bytes())
    }
}

fn signature_from_value(value: Value) -> Result<Aggsig, Error> {
    let bytes = expect_bytes(value)?;
    if bytes.is_empty() {
        Ok(Aggsig::default())
    } else {
        Aggsig::from_slice(&bytes)
    }
}

fn signatures_to_value(value: &StateUpdateSignatures) -> Value {
    dict([
        ("c", signature_to_value(&value.channel_half_sig)),
        ("u", signature_to_value(&value.unroll_preempt_half_sig)),
    ])
}

fn signatures_from_value(value: Value) -> Result<StateUpdateSignatures, Error> {
    let mut map = expect_exact(value, ["c", "u"])?;
    Ok(StateUpdateSignatures {
        channel_half_sig: signature_from_value(take(&mut map, "c")?)?,
        unroll_preempt_half_sig: signature_from_value(take(&mut map, "u")?)?,
    })
}

fn capabilities_to_value(value: &BTreeMap<String, u32>) -> Value {
    Value::Dictionary(
        value
            .iter()
            .map(|(key, value)| (text(key), integer(u64::from(*value))))
            .collect(),
    )
}

fn capabilities_from_value(value: Value) -> Result<BTreeMap<String, u32>, Error> {
    expect_dict(value)?
        .into_iter()
        .map(|(key, value)| Ok((key, expect_u32(value)?)))
        .collect()
}

fn handshake_b_to_value(value: &HandshakePayloadB) -> Value {
    dict([
        ("v", capabilities_to_value(&value.capabilities)),
        ("ck", public_key_to_value(&value.channel_public_key)),
        ("uk", public_key_to_value(&value.unroll_public_key)),
        ("rh", puzzle_hash_to_value(&value.reward_puzzle_hash)),
        ("rk", public_key_to_value(&value.referee_pubkey)),
        ("rs", signature_to_value(&value.reward_payout_signature)),
        ("cp", signature_to_value(&value.channel_key_pop)),
        ("up", signature_to_value(&value.unroll_key_pop)),
        ("mc", integer(value.my_contribution.to_u64())),
        ("tc", integer(value.their_contribution.to_u64())),
    ])
}

fn handshake_b_from_value(value: Value) -> Result<HandshakePayloadB, Error> {
    let mut map = expect_exact(
        value,
        ["v", "ck", "uk", "rh", "rk", "rs", "cp", "up", "mc", "tc"],
    )?;
    Ok(HandshakePayloadB {
        capabilities: capabilities_from_value(take(&mut map, "v")?)?,
        channel_public_key: public_key_from_value(take(&mut map, "ck")?)?,
        unroll_public_key: public_key_from_value(take(&mut map, "uk")?)?,
        reward_puzzle_hash: puzzle_hash_from_value(take(&mut map, "rh")?)?,
        referee_pubkey: public_key_from_value(take(&mut map, "rk")?)?,
        reward_payout_signature: signature_from_value(take(&mut map, "rs")?)?,
        channel_key_pop: signature_from_value(take(&mut map, "cp")?)?,
        unroll_key_pop: signature_from_value(take(&mut map, "up")?)?,
        my_contribution: Amount::new(expect_u64(take(&mut map, "mc")?)?),
        their_contribution: Amount::new(expect_u64(take(&mut map, "tc")?)?),
    })
}

fn proposal_parameters_to_value(value: &ProposalParameters) -> Result<Value, Error> {
    match value {
        ProposalParameters::Null => Ok(Value::Null),
        ProposalParameters::Bool(value) => Ok(Value::Bool(*value)),
        ProposalParameters::Integer(value) => Ok(Value::Integer(*value)),
        ProposalParameters::Bytes(value) => Ok(Value::Bytes(value.clone())),
        ProposalParameters::Text(value) => Ok(Value::Text(value.clone())),
        ProposalParameters::List(values) => values
            .iter()
            .map(proposal_parameters_to_value)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::List),
        #[cfg(test)]
        ProposalParameters::RawClvmPair(first, rest) => Ok(tagged(
            "x",
            Value::List(vec![
                proposal_parameters_to_value(first)?,
                proposal_parameters_to_value(rest)?,
            ]),
        )),
    }
}

fn proposal_parameters_from_value(value: Value) -> Result<ProposalParameters, Error> {
    match value {
        Value::Null => Ok(ProposalParameters::Null),
        Value::Bool(value) => Ok(ProposalParameters::Bool(value)),
        Value::Integer(value) => Ok(ProposalParameters::Integer(value)),
        Value::Bytes(value) => Ok(ProposalParameters::Bytes(value)),
        Value::Text(value) => Ok(ProposalParameters::Text(value)),
        Value::List(values) => values
            .into_iter()
            .map(proposal_parameters_from_value)
            .collect::<Result<Vec<_>, _>>()
            .map(ProposalParameters::List),
        Value::Dictionary(_) => {
            #[cfg(test)]
            {
                let (tag, value) = expect_tag(value)?;
                if tag != "x" {
                    return Err(wire_error("unknown test proposal parameter tag"));
                }
                let mut values = expect_list(value)?;
                if values.len() != 2 {
                    return Err(wire_error("test CLVM pair requires two values"));
                }
                let rest = proposal_parameters_from_value(values.pop().expect("length checked"))?;
                let first = proposal_parameters_from_value(values.pop().expect("length checked"))?;
                Ok(ProposalParameters::RawClvmPair(
                    Box::new(first),
                    Box::new(rest),
                ))
            }
            #[cfg(not(test))]
            {
                Err(wire_error("dictionary is not a proposal parameter"))
            }
        }
    }
}

fn proposal_to_value(value: &GameProposal) -> Result<Value, Error> {
    Ok(dict([
        ("ac", integer(value.player_a_contribution.to_u64())),
        ("bc", integer(value.player_b_contribution.to_u64())),
        ("pa", Value::Bool(value.sender_is_player_a)),
        ("gt", hash_to_value(value.game_type.hash())),
        ("t", integer(value.timeout.to_u64())),
        ("p", proposal_parameters_to_value(&value.parameters)?),
    ]))
}

fn proposal_from_value(value: Value) -> Result<GameProposal, Error> {
    let mut map = expect_exact(value, ["ac", "bc", "pa", "gt", "t", "p"])?;
    Ok(GameProposal {
        player_a_contribution: Amount::new(expect_u64(take(&mut map, "ac")?)?),
        player_b_contribution: Amount::new(expect_u64(take(&mut map, "bc")?)?),
        sender_is_player_a: expect_bool(take(&mut map, "pa")?)?,
        game_type: GameType::from_hash(hash_from_value(take(&mut map, "gt")?)?),
        timeout: Timeout::new(expect_u64(take(&mut map, "t")?)?),
        parameters: proposal_parameters_from_value(take(&mut map, "p")?)?,
    })
}

fn game_spec_to_value(value: &WireGameSpec) -> Value {
    dict([
        ("i", integer(value.game_id.0)),
        ("ac", integer(value.player_a_contribution.to_u64())),
        ("bc", integer(value.player_b_contribution.to_u64())),
        ("af", Value::Bool(value.player_a_goes_first)),
        ("vp", hash_to_value(&value.initial_validation_program_hash)),
        ("vi", hash_to_value(&value.initial_validation_info_hash)),
        ("m", bytes(&value.initial_move)),
        ("ms", integer(u64::from(value.initial_max_move_size))),
        ("sh", integer(value.initial_mover_share.to_u64())),
    ])
}

fn game_spec_from_value(value: Value) -> Result<WireGameSpec, Error> {
    let mut map = expect_exact(value, ["i", "ac", "bc", "af", "vp", "vi", "m", "ms", "sh"])?;
    Ok(WireGameSpec {
        game_id: GameID(expect_u64(take(&mut map, "i")?)?),
        player_a_contribution: Amount::new(expect_u64(take(&mut map, "ac")?)?),
        player_b_contribution: Amount::new(expect_u64(take(&mut map, "bc")?)?),
        player_a_goes_first: expect_bool(take(&mut map, "af")?)?,
        initial_validation_program_hash: hash_from_value(take(&mut map, "vp")?)?,
        initial_validation_info_hash: hash_from_value(take(&mut map, "vi")?)?,
        initial_move: expect_bytes(take(&mut map, "m")?)?,
        initial_max_move_size: expect_u32(take(&mut map, "ms")?)?,
        initial_mover_share: Amount::new(expect_u64(take(&mut map, "sh")?)?),
    })
}

fn proposal_group_to_value(value: &WireProposalGroup) -> Result<Value, Error> {
    Ok(dict([
        ("s", proposal_to_value(&value.start)?),
        (
            "m",
            Value::List(value.members.iter().map(game_spec_to_value).collect()),
        ),
    ]))
}

fn proposal_group_from_value(value: Value) -> Result<WireProposalGroup, Error> {
    let mut map = expect_exact(value, ["s", "m"])?;
    Ok(WireProposalGroup {
        start: proposal_from_value(take(&mut map, "s")?)?,
        members: expect_list(take(&mut map, "m")?)?
            .into_iter()
            .map(game_spec_from_value)
            .collect::<Result<_, _>>()?,
    })
}

fn move_state_to_value(value: &GameMoveStateInfo) -> Value {
    dict([
        ("m", bytes(&value.move_made)),
        ("s", integer(value.mover_share.to_u64())),
        ("z", integer(u64::from(value.max_move_size))),
        ("r", bytes(&value.max_move_size_raw)),
    ])
}

fn move_state_from_value(value: Value) -> Result<GameMoveStateInfo, Error> {
    let mut map = expect_exact(value, ["m", "s", "z", "r"])?;
    Ok(GameMoveStateInfo {
        move_made: expect_bytes(take(&mut map, "m")?)?,
        mover_share: Amount::new(expect_u64(take(&mut map, "s")?)?),
        max_move_size: expect_u32(take(&mut map, "z")?)?,
        max_move_size_raw: expect_bytes(take(&mut map, "r")?)?,
    })
}

fn peer_move_to_value(value: &PeerMove) -> Value {
    dict([
        ("b", move_state_to_value(&value.basic)),
        ("t", Value::Bool(value.terminal)),
    ])
}

fn peer_move_from_value(value: Value) -> Result<PeerMove, Error> {
    let mut map = expect_exact(value, ["b", "t"])?;
    Ok(PeerMove {
        basic: move_state_from_value(take(&mut map, "b")?)?,
        terminal: expect_bool(take(&mut map, "t")?)?,
    })
}

fn batch_action_to_value(value: &BatchAction) -> Result<Value, Error> {
    Ok(match value {
        BatchAction::ProposeGroup(group) => tagged("P", proposal_group_to_value(group)?),
        BatchAction::AcceptProposalGroup(id) => tagged("AP", integer(id.0)),
        BatchAction::CancelProposalGroup(id) => tagged("CP", integer(id.0)),
        BatchAction::Move(id, peer_move) => tagged(
            "M",
            Value::List(vec![integer(id.0), peer_move_to_value(peer_move)]),
        ),
        BatchAction::AcceptSettlement(id, amount) => tagged(
            "AS",
            Value::List(vec![integer(id.0), integer(amount.to_u64())]),
        ),
    })
}

fn batch_action_from_value(value: Value) -> Result<BatchAction, Error> {
    let (tag, value) = expect_tag(value)?;
    match tag.as_str() {
        "P" => Ok(BatchAction::ProposeGroup(proposal_group_from_value(value)?)),
        "AP" => Ok(BatchAction::AcceptProposalGroup(GameID(expect_u64(value)?))),
        "CP" => Ok(BatchAction::CancelProposalGroup(GameID(expect_u64(value)?))),
        "M" => {
            let mut values = expect_list(value)?;
            if values.len() != 2 {
                return Err(wire_error("move action requires two values"));
            }
            let peer_move = peer_move_from_value(values.pop().expect("length checked"))?;
            let id = GameID(expect_u64(values.pop().expect("length checked"))?);
            Ok(BatchAction::Move(id, peer_move))
        }
        "AS" => {
            let mut values = expect_list(value)?;
            if values.len() != 2 {
                return Err(wire_error("settlement action requires two values"));
            }
            let amount = Amount::new(expect_u64(values.pop().expect("length checked"))?);
            let id = GameID(expect_u64(values.pop().expect("length checked"))?);
            Ok(BatchAction::AcceptSettlement(id, amount))
        }
        _ => Err(wire_error(format!("unknown batch action tag {tag}"))),
    }
}

fn funding_bundle_to_value(value: &SpendBundle) -> Result<Value, Error> {
    let mut aggregate = Aggsig::default();
    let mut nonzero = 0;
    for spend in &value.spends {
        if !spend.bundle.signature.is_twos_complement_zero() {
            nonzero += 1;
        }
        aggregate += spend.bundle.signature.clone();
    }
    if nonzero > 1 {
        return Err(wire_error(format!(
            "funding bundle has {nonzero} nonzero internal signature fields"
        )));
    }
    Ok(dict([
        ("n", value.name.as_ref().map_or(Value::Null, text)),
        (
            "s",
            Value::List(value.spends.iter().map(coin_spend_to_value).collect()),
        ),
        ("g", signature_to_value(&aggregate)),
    ]))
}

fn funding_bundle_from_value(value: Value) -> Result<SpendBundle, Error> {
    let mut map = expect_exact(value, ["n", "s", "g"])?;
    let name = match take(&mut map, "n")? {
        Value::Null => None,
        value => Some(expect_text(value)?),
    };
    let aggregate = signature_from_value(take(&mut map, "g")?)?;
    let mut spends = expect_list(take(&mut map, "s")?)?
        .into_iter()
        .map(coin_spend_from_value)
        .collect::<Result<Vec<_>, _>>()?;
    if !aggregate.is_twos_complement_zero() {
        let first = spends
            .first_mut()
            .ok_or_else(|| wire_error("nonzero funding signature requires a spend"))?;
        first.bundle.signature = aggregate;
    }
    Ok(SpendBundle { name, spends })
}

fn coin_spend_to_value(value: &CoinSpend) -> Value {
    dict([
        ("c", bytes(value.coin.to_bytes())),
        (
            "b",
            dict([
                ("p", bytes(value.bundle.puzzle.to_program().bytes())),
                ("s", bytes(value.bundle.solution.pref().bytes())),
            ]),
        ),
    ])
}

fn coin_spend_from_value(value: Value) -> Result<CoinSpend, Error> {
    let mut map = expect_exact(value, ["c", "b"])?;
    let coin = CoinString::from_bytes(&expect_bytes(take(&mut map, "c")?)?);
    let mut bundle = expect_exact(take(&mut map, "b")?, ["p", "s"])?;
    Ok(CoinSpend {
        coin,
        bundle: Spend {
            puzzle: Puzzle::from_bytes(&expect_bytes(take(&mut bundle, "p")?)?),
            solution: Program::from_bytes(&expect_bytes(take(&mut bundle, "s")?)?).into(),
            signature: Aggsig::default(),
        },
    })
}

fn peer_message_to_value(message: &PeerMessage) -> Result<Value, Error> {
    Ok(match message {
        PeerMessage::HandshakeA(value) => tagged("HA", handshake_b_to_value(value)),
        PeerMessage::HandshakeB(value) => tagged("HB", handshake_b_to_value(value)),
        PeerMessage::HandshakeC(value) => {
            tagged("HC", dict([("lc", bytes(value.launcher_coin.to_bytes()))]))
        }
        PeerMessage::HandshakeD(value) => {
            tagged("HD", dict([("s", signatures_to_value(&value.signatures))]))
        }
        PeerMessage::HandshakeE(value) => tagged(
            "HE",
            dict([
                ("b", funding_bundle_to_value(&value.bundle)?),
                ("s", signatures_to_value(&value.signatures)),
            ]),
        ),
        PeerMessage::HandshakeF(value) => {
            tagged("HF", dict([("b", funding_bundle_to_value(&value.bundle)?)]))
        }
        PeerMessage::Batch {
            actions,
            signatures,
        } => tagged(
            "B",
            dict([
                (
                    "a",
                    Value::List(
                        actions
                            .iter()
                            .map(batch_action_to_value)
                            .collect::<Result<Vec<_>, _>>()?,
                    ),
                ),
                ("s", signatures_to_value(signatures)),
            ]),
        ),
        PeerMessage::CleanShutdown { channel_half_sig } => {
            tagged("S", dict([("c", signature_to_value(channel_half_sig))]))
        }
        PeerMessage::CleanShutdownComplete { channel_half_sig } => {
            tagged("SF", dict([("c", signature_to_value(channel_half_sig))]))
        }
        PeerMessage::RequestPotato(()) => tagged("R", Value::Null),
        PeerMessage::Message(id, message) => {
            tagged("M", Value::List(vec![integer(id.0), bytes(message)]))
        }
    })
}

fn peer_message_from_value(value: Value) -> Result<PeerMessage, Error> {
    let (tag, value) = expect_tag(value)?;
    match tag.as_str() {
        "HA" => Ok(PeerMessage::HandshakeA(handshake_b_from_value(value)?)),
        "HB" => Ok(PeerMessage::HandshakeB(handshake_b_from_value(value)?)),
        "HC" => {
            let mut map = expect_exact(value, ["lc"])?;
            Ok(PeerMessage::HandshakeC(HandshakePayloadC {
                launcher_coin: CoinString::from_bytes(&expect_bytes(take(&mut map, "lc")?)?),
            }))
        }
        "HD" => {
            let mut map = expect_exact(value, ["s"])?;
            Ok(PeerMessage::HandshakeD(HandshakePayloadD {
                signatures: signatures_from_value(take(&mut map, "s")?)?,
            }))
        }
        "HE" => {
            let mut map = expect_exact(value, ["b", "s"])?;
            Ok(PeerMessage::HandshakeE(HandshakePayloadE {
                bundle: funding_bundle_from_value(take(&mut map, "b")?)?,
                signatures: signatures_from_value(take(&mut map, "s")?)?,
            }))
        }
        "HF" => {
            let mut map = expect_exact(value, ["b"])?;
            Ok(PeerMessage::HandshakeF(HandshakePayloadF {
                bundle: funding_bundle_from_value(take(&mut map, "b")?)?,
            }))
        }
        "B" => {
            let mut map = expect_exact(value, ["a", "s"])?;
            Ok(PeerMessage::Batch {
                actions: expect_list(take(&mut map, "a")?)?
                    .into_iter()
                    .map(batch_action_from_value)
                    .collect::<Result<_, _>>()?,
                signatures: signatures_from_value(take(&mut map, "s")?)?,
            })
        }
        "S" | "SF" => {
            let mut map = expect_exact(value, ["c"])?;
            let channel_half_sig = signature_from_value(take(&mut map, "c")?)?;
            if tag == "S" {
                Ok(PeerMessage::CleanShutdown { channel_half_sig })
            } else {
                Ok(PeerMessage::CleanShutdownComplete { channel_half_sig })
            }
        }
        "R" => match value {
            Value::Null => Ok(PeerMessage::RequestPotato(())),
            _ => Err(wire_error("request-potato payload must be null")),
        },
        "M" => {
            let mut values = expect_list(value)?;
            if values.len() != 2 {
                return Err(wire_error("message payload requires two values"));
            }
            let message = expect_bytes(values.pop().expect("length checked"))?;
            let id = GameID(expect_u64(values.pop().expect("length checked"))?);
            Ok(PeerMessage::Message(id, message))
        }
        _ => Err(wire_error(format!("unknown peer message tag {tag}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::types::PrivateKey;
    use crate::session_phases::handshake::local_capabilities;

    fn signatures() -> StateUpdateSignatures {
        StateUpdateSignatures::default()
    }

    fn empty_bundle() -> SpendBundle {
        SpendBundle {
            name: None,
            spends: vec![],
        }
    }

    fn assert_short_keys(value: &Value) {
        match value {
            Value::Dictionary(entries) => {
                for (key, value) in entries {
                    let Value::Text(key) = key else {
                        panic!("protocol dictionary key must be text");
                    };
                    assert!(key.len() <= 2, "protocol key is too long: {key}");
                    assert_short_keys(value);
                }
            }
            Value::List(values) => values.iter().for_each(assert_short_keys),
            _ => {}
        }
    }

    #[test]
    fn compact_peer_message_golden_vectors() {
        assert_eq!(
            encode_peer_message(&PeerMessage::RequestPotato(())).unwrap(),
            b"du1:Rne"
        );
        assert_eq!(
            encode_peer_message(&PeerMessage::Message(GameID(7), vec![])).unwrap(),
            b"du1:Mli7e0:ee"
        );
        assert_eq!(
            encode_peer_message(&PeerMessage::Batch {
                actions: vec![],
                signatures: signatures(),
            })
            .unwrap(),
            b"du1:Bdu1:aleu1:sdu1:c0:u1:u0:eee"
        );
        assert_eq!(
            encode_peer_message(&PeerMessage::CleanShutdown {
                channel_half_sig: Aggsig::default(),
            })
            .unwrap(),
            b"du1:Sdu1:c0:ee"
        );
        assert_eq!(
            encode_peer_message(&PeerMessage::HandshakeF(HandshakePayloadF {
                bundle: empty_bundle(),
            }))
            .unwrap(),
            b"du2:HFdu1:bdu1:g0:u1:nnu1:sleeee"
        );
    }

    #[test]
    fn every_peer_message_and_batch_action_round_trips() {
        let identity = HandshakePayloadB {
            capabilities: local_capabilities(),
            channel_public_key: Default::default(),
            unroll_public_key: Default::default(),
            reward_puzzle_hash: Default::default(),
            referee_pubkey: Default::default(),
            reward_payout_signature: Default::default(),
            channel_key_pop: Default::default(),
            unroll_key_pop: Default::default(),
            my_contribution: Amount::new(1),
            their_contribution: Amount::new(2),
        };
        let group = WireProposalGroup {
            start: GameProposal {
                player_a_contribution: Amount::new(1),
                player_b_contribution: Amount::new(2),
                sender_is_player_a: true,
                game_type: GameType::from_hash(Hash::default()),
                timeout: Timeout::new(3),
                parameters: ProposalParameters::List(vec![ProposalParameters::Integer(4)]),
            },
            members: vec![WireGameSpec {
                game_id: GameID(5),
                player_a_contribution: Amount::new(1),
                player_b_contribution: Amount::new(2),
                player_a_goes_first: false,
                initial_validation_program_hash: Hash::default(),
                initial_validation_info_hash: Hash::default(),
                initial_move: vec![6],
                initial_max_move_size: 7,
                initial_mover_share: Amount::new(8),
            }],
        };
        let actions = vec![
            BatchAction::ProposeGroup(group),
            BatchAction::AcceptProposalGroup(GameID(1)),
            BatchAction::CancelProposalGroup(GameID(2)),
            BatchAction::Move(
                GameID(3),
                PeerMove {
                    basic: GameMoveStateInfo {
                        move_made: vec![1],
                        mover_share: Amount::new(2),
                        max_move_size: 3,
                        max_move_size_raw: vec![3],
                    },
                    terminal: true,
                },
            ),
            BatchAction::AcceptSettlement(GameID(4), Amount::new(5)),
        ];
        let messages = vec![
            PeerMessage::HandshakeA(identity.clone()),
            PeerMessage::HandshakeB(identity),
            PeerMessage::HandshakeC(HandshakePayloadC {
                launcher_coin: CoinString::from_bytes(&[1]),
            }),
            PeerMessage::HandshakeD(HandshakePayloadD {
                signatures: signatures(),
            }),
            PeerMessage::HandshakeE(HandshakePayloadE {
                bundle: empty_bundle(),
                signatures: signatures(),
            }),
            PeerMessage::HandshakeF(HandshakePayloadF {
                bundle: empty_bundle(),
            }),
            PeerMessage::Batch {
                actions,
                signatures: signatures(),
            },
            PeerMessage::CleanShutdown {
                channel_half_sig: Aggsig::default(),
            },
            PeerMessage::CleanShutdownComplete {
                channel_half_sig: Aggsig::default(),
            },
            PeerMessage::RequestPotato(()),
            PeerMessage::Message(GameID(9), vec![1, 2]),
        ];
        for message in messages {
            let encoded = encode_peer_message(&message).unwrap();
            assert_short_keys(&bencodex::parse(&encoded).unwrap());
            let decoded = decode_peer_message(&encoded).unwrap();
            assert_eq!(decoded, message);
            assert_eq!(encode_peer_message(&decoded).unwrap(), encoded);
        }
    }

    #[test]
    fn malformed_trailing_and_noncanonical_messages_are_rejected() {
        for input in [
            b"du1:RneX".as_slice(),
            b"du1:R".as_slice(),
            b"du1:Ri01ee".as_slice(),
            b"du1:Si1ee".as_slice(),
            b"du1:Ru1:xe".as_slice(),
        ] {
            assert!(decode_peer_message(input).is_err(), "{input:?}");
        }
    }

    #[test]
    fn funding_signatures_are_concentrated_at_wire_boundary() {
        let signature = PrivateKey::default().sign(b"funding");
        let spend = |signature| CoinSpend {
            coin: CoinString::from_bytes(&[1]),
            bundle: Spend {
                puzzle: Puzzle::from_bytes(&[0x80]),
                solution: Program::from_bytes(&[0x80]).into(),
                signature,
            },
        };
        let message = PeerMessage::HandshakeF(HandshakePayloadF {
            bundle: SpendBundle {
                name: None,
                spends: vec![spend(signature.clone()), spend(Aggsig::default())],
            },
        });
        let encoded = encode_peer_message(&message).unwrap();
        let PeerMessage::HandshakeF(decoded) = decode_peer_message(&encoded).unwrap() else {
            panic!("wrong message");
        };
        assert_eq!(decoded.bundle.spends[0].bundle.signature, signature);
        assert!(decoded.bundle.spends[1]
            .bundle
            .signature
            .is_twos_complement_zero());

        let noncanonical = PeerMessage::HandshakeF(HandshakePayloadF {
            bundle: SpendBundle {
                name: None,
                spends: vec![
                    spend(PrivateKey::default().sign(b"a")),
                    spend(PrivateKey::default().sign(b"b")),
                ],
            },
        });
        assert!(encode_peer_message(&noncanonical).is_err());
    }
}
