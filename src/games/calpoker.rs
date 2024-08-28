use std::cmp::Ordering;

use clvmr::NodePtr;
use std::cmp::Ordering;

use clvm_tools_rs::classic::clvm::sexp::proper_list;
#[cfg(test)]
use clvm_tools_rs::classic::clvm_tools::binutils::assemble;
use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;

use num_bigint::{BigInt, ToBigInt};
use num_traits::ToPrimitive;

use serde::{Serialize, Deserialize};

use crate::common::types::{AllocEncoder, Amount, atom_from_clvm, divmod, Error, Sha256Input, usize_from_atom, i64_from_atom};

#[derive(Ord, Eq, PartialEq, Debug, Serialize, Deserialize)]
pub enum RawCalpokerHandValue {
    SimpleList(Vec<usize>),
    PrefixList(Vec<usize>, Vec<usize>),
}

impl Default for RawCalpokerHandValue {
    fn default() -> Self {
        RawCalpokerHandValue::SimpleList(vec![])
    }
}

impl RawCalpokerHandValue {
    fn first_list(&self) -> &[usize] {
        match self {
            RawCalpokerHandValue::SimpleList(x) => x,
            RawCalpokerHandValue::PrefixList(x, _) => x,
        }
    }
}

impl PartialOrd for RawCalpokerHandValue {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.first_list().cmp(other.first_list()))
    }
}

/// A decoded version of the calpoker result.
#[derive(Eq, PartialEq, Debug, Serialize, Deserialize, Default)]
pub struct CalpokerResult {
    pub raw_alice_selects: usize,
    pub raw_bob_picks: usize,
    pub raw_alice_picks: usize,
    pub bob_hand_value: RawCalpokerHandValue,
    pub alice_hand_value: RawCalpokerHandValue,
    pub win_direction: i64,
    pub game_amount: u64,
    pub your_share: u64,
}

fn mergein(outer: &[usize], inner: &[usize], offset: usize) -> Vec<usize> {
    if inner.is_empty() {
        outer.to_vec()
    } else {
        let first = inner[0] + offset;
        let mut res = Vec::new();
        if outer.is_empty() {
            res.push(first);
            res.append(&mut mergein(&[], &inner[1..], offset));
        } else if outer[0] <= first {
            res.push(outer[0]);
            res.append(&mut mergein(&outer[1..], inner, offset + 1));
        } else {
            res.push(first);
            res.append(&mut mergein(outer, &inner[1..], offset));
        }
        res
    }
}

fn mergeover(outer: &[usize], inner: &[usize], offset: usize) -> Vec<usize> {
    if inner.is_empty() {
        vec![]
    } else {
        let first = inner[0] + offset;
        let mut res = Vec::new();
        if outer.is_empty() {
            res.push(first);
            res.append(&mut mergeover(&[], &inner[1..], offset));
        } else if outer[0] <= first {
            return mergeover(&outer[1..], inner, offset + 1);
        } else {
            res.push(first);
            res.append(&mut mergeover(outer, &inner[1..], offset));
        }
        res
    }
}

// Pick numchoose things out of numcards options with randomness extracted from vals
// returns (cards newvals).
fn choose(numcards: usize, numchoose: usize, randomness: BigInt) -> (Vec<usize>, BigInt) {
    if numchoose == 1 {
        let (newrandomness, card) = divmod(randomness, numcards.to_bigint().unwrap());
        (vec![card.to_usize().unwrap()], newrandomness)
    } else {
        let half = numchoose >> 1;
        let (cards1, newrandomness2) = choose(numcards, half, randomness);
        let (cards2, newrandomness3) = choose(numcards - half, numchoose - half, newrandomness2);
        (mergein(&cards1, &cards2, 0), newrandomness3)
    }
}

fn cards_to_hand(cards: &[usize]) -> Vec<Card> {
    cards
        .iter()
        .map(|val| {
            let rank = val / 4;
            let suit = val % 4;
            if rank == 12 {
                (1, suit + 1)
            } else {
                (rank + 2, suit + 1)
            }
        })
        .collect()
}

// Does the same thing as make_cards so bob can see the card display that alice can see once
// the message of alice' preimage (alice_hash) goes through.
pub fn make_cards(alice_hash: &[u8], bob_hash: &[u8], amount: Amount) -> (Vec<Card>, Vec<Card>) {
    let amount_bigint = amount.to_u64().to_bigint().unwrap();
    let (_, mut amount_bytes) = amount_bigint.to_bytes_be();
    if amount_bytes == [0] {
        amount_bytes = vec![];
    }
    if amount_bytes[0] & 0x80 != 0 {
        amount_bytes.insert(0, 0);
    }
    eprintln!(
        "make cards with alice_hash {alice_hash:?} bob_hash {bob_hash:?} amount {amount_bytes:?}"
    );
    let rand_input = Sha256Input::Array(vec![
        Sha256Input::Bytes(&alice_hash[..16]),
        Sha256Input::Bytes(&bob_hash[..16]),
        Sha256Input::Bytes(&amount_bytes),
    ])
    .hash()
    .bytes()
    .to_vec();
    let randomness = BigInt::from_signed_bytes_be(&rand_input);
    let (handa, newrandomness) = choose(52, 8, randomness);
    let (handb, _) = choose(52 - 8, 8, newrandomness);
    (
        cards_to_hand(&handa),
        cards_to_hand(&mergeover(&handa, &handb, 0)),
    )
}

pub fn decode_hand_result(
    allocator: &mut AllocEncoder,
    readable: NodePtr,
) -> Result<RawCalpokerHandValue, Error> {
    let mut result_list = Vec::new();
    let as_list: Vec<NodePtr> =
        if let Some(as_list) = proper_list(allocator.allocator(), readable, true) {
            as_list
        } else {
            return Err(Error::StrErr(
                "decode calpoker hand type: non-list".to_string(),
            ));
        };

    for item in as_list.iter() {
        if let Some(sublist) = proper_list(allocator.allocator(), *item, true) {
            let result_sublist = sublist
                .iter()
                .filter_map(|i| atom_from_clvm(allocator, *i).and_then(usize_from_atom))
                .collect();
            return Ok(RawCalpokerHandValue::PrefixList(
                result_list,
                result_sublist,
            ));
        } else if let Some(i) = atom_from_clvm(allocator, *item).and_then(usize_from_atom) {
            result_list.push(i);
        } else {
            return Err(Error::StrErr("decode error, can't make usize".to_string()));
        }
    }

    Ok(RawCalpokerHandValue::SimpleList(result_list))
}

/// Given a readable move, decode it as a calpoker outcome.
pub fn decode_calpoker_readable(allocator: &mut AllocEncoder, readable: NodePtr, amount: Amount, am_alice: bool) -> Result<CalpokerResult, Error> {
    let as_list =
        if let Some(as_list) = proper_list(allocator.allocator(), readable, true) {
            as_list
        } else {
            return Err(Error::StrErr("decode calpoker readable: non-list".to_string()));
        };

    if as_list.len() != 6 {
        return Err(Error::StrErr(
            "decode calpoker readable: wrong result size".to_string(),
        ));
    }

    let bitmasks: Vec<usize> = as_list
        .iter()
        .take(3)
        .filter_map(|i| atom_from_clvm(allocator, *i).and_then(usize_from_atom))
        .collect();
    if bitmasks.len() != 3 {
        return Err(Error::StrErr("not all bitmasks converted".to_string()));
    }

    let bob_hand_value = decode_hand_result(allocator, as_list[3])?;
    let alice_hand_value = decode_hand_result(allocator, as_list[4])?;

    let (your_share, win_direction) =
        if let Some(o) = atom_from_clvm(allocator, as_list[5]).and_then(i64_from_atom) {
            if am_alice {
                if o == -1 {
                    (amount.clone(), o)
                } else if o == 0 {
                    (amount.half(), o)
                } else {
                    (Amount::default(), o)
                }
            } else {
                if o == amount.to_u64() as i64 {
                    (Amount::default(), -1)
                } else if o == 0 {
                    (amount.clone(), 1)
                } else {
                    (Amount::new((o as u64) / 2), 0)
                }
            }
        } else {
            return Err(Error::StrErr("could not convert final outcome".to_string()));
        };

    Ok(CalpokerResult {
        raw_alice_selects: bitmasks[0],
        raw_bob_picks: bitmasks[1],
        raw_alice_picks: bitmasks[2],
        game_amount: amount.to_u64(),
        your_share: your_share.to_u64(),
        bob_hand_value,
        alice_hand_value,
        win_direction,
    })
}

#[test]
fn test_decode_calpoker_readable() {
    let mut allocator = AllocEncoder::new();
    let assembled = assemble(allocator.allocator(), "(60 59 91 (2 2 1 12 11 8) (2 2 1 14 5 2) -1)").expect("should work");
    let decoded = decode_calpoker_readable(&mut allocator, assembled, Amount::new(200), true).expect("should work");
    assert_eq!(
        decoded,
        CalpokerResult {
            raw_alice_selects: 60,
            raw_bob_picks: 59,
            raw_alice_picks: 91,
            bob_hand_value: RawCalpokerHandValue::SimpleList(vec![2,2,1,12,11,8]),
            alice_hand_value: RawCalpokerHandValue::SimpleList(vec![2,2,1,14,5,2]),
            your_share: 200,
            game_amount: 200,
            win_direction: -1
        }
    );
}
