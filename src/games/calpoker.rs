use std::cmp::Ordering;

use log::debug;

use crate::channel_handler::types::ReadableMove;
#[cfg(test)]
use clvm_traits::ToClvm;
use clvmr::NodePtr;

use crate::utils::proper_list;

use num_bigint::{BigInt, ToBigInt};
use num_traits::ToPrimitive;

use serde::{Deserialize, Serialize};

use crate::common::types::{
    atom_from_clvm, divmod, i64_from_atom, usize_from_atom, AllocEncoder, Amount, Error,
    Sha256Input,
};

#[derive(Eq, PartialEq, Debug, Clone, Serialize, Deserialize)]
pub enum WinDirectionUser {
    Alice,
    Bob,
}

pub type Card = (usize, usize);

#[derive(Eq, PartialEq, Debug, Serialize, Deserialize)]
pub enum RawCalpokerHandValue {
    SimpleList(Vec<usize>),
    PrefixList(Vec<usize>, Vec<usize>),
}

#[derive(Eq, PartialEq, Debug, Serialize, Deserialize)]
pub enum CalpokerHandValue {
    HighCard(Vec<usize>),
    Pair(usize, Vec<usize>),
    TwoPair(usize, usize, usize),
    ThreeOfAKind(usize, usize, usize),
    Straight(usize),
    Flush(Vec<usize>),
    FullHouse(usize, usize),
    FourOfAKind(usize, usize),
    StraightFlush(usize),
}

impl Default for CalpokerHandValue {
    fn default() -> Self {
        CalpokerHandValue::Straight(0)
    }
}

impl RawCalpokerHandValue {
    pub fn hand_value(&self) -> Result<CalpokerHandValue, Error> {
        match self {
            RawCalpokerHandValue::SimpleList(lst) => {
                if lst.starts_with(&[1, 1, 1, 1, 1]) {
                    // High card
                    return Ok(CalpokerHandValue::HighCard(
                        lst.iter().skip(5).copied().collect(),
                    ));
                } else if lst.starts_with(&[2, 1, 1, 1]) {
                    // Two of a kind
                    if let Some(card) = lst.get(4) {
                        return Ok(CalpokerHandValue::Pair(
                            *card,
                            lst.iter().skip(4).copied().collect(),
                        ));
                    }
                } else if lst.starts_with(&[2, 2, 1]) {
                    // Two pair
                    let first_two: Vec<_> = lst.iter().skip(3).copied().collect();
                    if let [c1, c2, other] = &first_two[..] {
                        return Ok(CalpokerHandValue::TwoPair(*c1, *c2, *other));
                    }
                } else if lst.starts_with(&[3, 1, 1]) {
                    // Three of a kind
                    let first_three: Vec<_> = lst.iter().skip(3).copied().collect();
                    if let [trio, o1, o2] = &first_three[..] {
                        return Ok(CalpokerHandValue::ThreeOfAKind(*trio, *o1, *o2));
                    }
                } else if lst.starts_with(&[3, 1, 2]) {
                    // Straight
                    if let Some(straight_high) = lst.get(3) {
                        return Ok(CalpokerHandValue::Straight(*straight_high));
                    }
                } else if lst.starts_with(&[3, 1, 3]) {
                    // Flush
                    return Ok(CalpokerHandValue::Flush(
                        lst.iter().skip(3).copied().collect(),
                    ));
                } else if lst.starts_with(&[3, 2]) {
                    // Full house
                    if let [_, _, high, low] = &lst[..] {
                        return Ok(CalpokerHandValue::FullHouse(*high, *low));
                    }
                } else if lst.starts_with(&[5]) {
                    // Straight Flush
                    if let Some(card) = lst.get(1) {
                        return Ok(CalpokerHandValue::StraightFlush(*card));
                    }
                }
            }
            RawCalpokerHandValue::PrefixList(prefix, suffix) => {
                let mut pfx = prefix.clone();
                pfx.append(&mut suffix.clone());
                return RawCalpokerHandValue::SimpleList(pfx).hand_value();
            }
        }

        Err(Error::StrErr(format!(
            "unable to translate hand value: {self:?}"
        )))
    }
}

#[test]
fn test_simple_hand_values() {
    assert_eq!(
        RawCalpokerHandValue::SimpleList(vec![3, 1, 3, 13, 10, 9, 6, 3])
            .hand_value()
            .unwrap(),
        CalpokerHandValue::Flush(vec![13, 10, 9, 6, 3])
    );
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
    pub bob_hand_result: CalpokerHandValue,
    pub alice_hand_value: RawCalpokerHandValue,
    pub alice_hand_result: CalpokerHandValue,
    pub raw_win_direction: i64,
    pub win_direction: Option<WinDirectionUser>,
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

pub fn convert_cards(allocator: &mut AllocEncoder, card_list: NodePtr) -> Vec<(usize, usize)> {
    if let Some(cards_nodeptrs) = proper_list(allocator.allocator(), card_list, true) {
        return cards_nodeptrs
            .iter()
            .filter_map(|elt| {
                proper_list(allocator.allocator(), *elt, true).map(|card| {
                    let rank: usize = atom_from_clvm(allocator, card[0])
                        .and_then(|a| usize_from_atom(&a))
                        .unwrap_or_default();
                    let suit: usize = atom_from_clvm(allocator, card[1])
                        .and_then(|a| usize_from_atom(&a))
                        .unwrap_or_default();
                    (rank, suit)
                })
            })
            .collect();
    }

    Vec::new()
}

pub type CardList = Vec<(usize, usize)>;

pub fn decode_readable_card_choices(
    allocator: &mut AllocEncoder,
    opponent_readable_move: ReadableMove,
) -> Result<(CardList, CardList), Error> {
    let opponent_nodeptr = opponent_readable_move.to_nodeptr(allocator)?;
    if let Some(cardlist) = proper_list(allocator.allocator(), opponent_nodeptr, true) {
        let tmp: Vec<_> = cardlist
            .iter()
            .map(|c| convert_cards(allocator, *c))
            .collect();
        if tmp.len() != 2 {
            return Err(Error::StrErr(format!(
                "Unexpected cardlist length: {}",
                tmp.len()
            )));
        }
        Ok((tmp[0].clone(), tmp[1].clone()))
    } else {
        Err(Error::StrErr("wrong decode of two card sets".to_string()))
    }
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
                .filter_map(|i| atom_from_clvm(allocator, *i).and_then(|a| usize_from_atom(&a)))
                .collect();
            return Ok(RawCalpokerHandValue::PrefixList(
                result_list,
                result_sublist,
            ));
        } else if let Some(i) = atom_from_clvm(allocator, *item).and_then(|a| usize_from_atom(&a)) {
            result_list.push(i);
        } else {
            return Err(Error::StrErr("decode error, can't make usize".to_string()));
        }
    }

    Ok(RawCalpokerHandValue::SimpleList(result_list))
}

type IndexAndCard = (usize, (usize, usize));

fn select_cards_using_bits(cardlist: &CardList, selections: usize) -> (CardList, CardList) {
    let (p1, p2): (Vec<IndexAndCard>, Vec<IndexAndCard>) = cardlist
        .iter()
        .cloned()
        .enumerate()
        .partition(|(i, _c)| (selections & (1 << i)) != 0);
    (
        p1.into_iter().map(|(_i, c)| c).collect(),
        p2.into_iter().map(|(_i, c)| c).collect(),
    )
}

/// Show the cards given a win result.
pub fn get_final_used_cards(
    cardlists: &(CardList, CardList),
    alice_result: &CalpokerResult,
    bob_result: &CalpokerResult,
) -> (CardList, CardList) {
    let (mut alice_giveaway_cards, alice_kept_cards) =
        select_cards_using_bits(&cardlists.0, bob_result.raw_alice_selects);
    let (mut bob_giveaway_cards, bob_kept_cards) =
        select_cards_using_bits(&cardlists.1, alice_result.raw_alice_selects);
    let mut alice_total_cards = alice_kept_cards;
    alice_total_cards.append(&mut bob_giveaway_cards);
    debug!("alice_total_cards {alice_total_cards:?}");
    let mut bob_total_cards = bob_kept_cards;
    bob_total_cards.append(&mut alice_giveaway_cards);
    debug!("bob_total_cards   {bob_total_cards:?}");
    assert_eq!(alice_total_cards.len(), 8);
    assert_eq!(bob_total_cards.len(), 8);
    let alice_used_cards: CardList = alice_total_cards
        .iter()
        .cloned()
        .enumerate()
        .filter(|(i, _c)| alice_result.raw_alice_picks & (1 << i) != 0)
        .map(|(_i, c)| c)
        .collect();
    let bob_used_cards: CardList = bob_total_cards
        .iter()
        .cloned()
        .enumerate()
        .filter(|(i, _c)| alice_result.raw_bob_picks & (1 << i) != 0)
        .map(|(_i, c)| c)
        .collect();
    assert_eq!(alice_used_cards.len(), 5);
    assert_eq!(bob_used_cards.len(), 5);
    (alice_used_cards, bob_used_cards)
}

/// Given a readable move, decode it as a calpoker outcome.
pub fn decode_calpoker_readable(
    allocator: &mut AllocEncoder,
    readable: NodePtr,
    amount: Amount,
    am_bob: bool,
) -> Result<CalpokerResult, Error> {
    let as_list = if let Some(as_list) = proper_list(allocator.allocator(), readable, true) {
        as_list
    } else {
        return Err(Error::StrErr(
            "decode calpoker readable: non-list".to_string(),
        ));
    };

    if as_list.len() != 6 {
        return Err(Error::StrErr(
            "decode calpoker readable: wrong result size".to_string(),
        ));
    }

    let bitmasks: Vec<usize> = as_list
        .iter()
        .take(3)
        .filter_map(|i| atom_from_clvm(allocator, *i).and_then(|a| usize_from_atom(&a)))
        .collect();
    if bitmasks.len() != 3 {
        return Err(Error::StrErr("not all bitmasks converted".to_string()));
    }

    let start_index = 1;
    let offset_for_player = am_bob as usize;

    let alice_hand_value =
        decode_hand_result(allocator, as_list[start_index + (2 ^ offset_for_player)])?;
    let bob_hand_value =
        decode_hand_result(allocator, as_list[start_index + (3 ^ offset_for_player)])?;

    let (your_share, win_direction) =
        if let Some(o) = atom_from_clvm(allocator, as_list[5]).and_then(|a| i64_from_atom(&a)) {
            if !am_bob {
                match o.cmp(&0) {
                    Ordering::Less => (amount.clone(), o),
                    Ordering::Equal => (amount.half(), o),
                    _ => (Amount::default(), o),
                }
            } else {
                match (o as u64).cmp(&(amount.to_u64() / 2)) {
                    Ordering::Greater => (Amount::default(), -1),
                    Ordering::Less => (amount.clone(), 1),
                    _ => (Amount::new((o as u64) / 2), 0),
                }
            }
        } else {
            return Err(Error::StrErr("could not convert final outcome".to_string()));
        };

    let hva = alice_hand_value.hand_value();
    let hvb = bob_hand_value.hand_value();

    Ok(CalpokerResult {
        raw_alice_selects: bitmasks[0],
        raw_bob_picks: bitmasks[start_index + offset_for_player],
        raw_alice_picks: bitmasks[start_index + (1 ^ offset_for_player)],
        game_amount: amount.to_u64(),
        your_share: your_share.to_u64(),
        bob_hand_result: hvb?,
        alice_hand_result: hva?,
        bob_hand_value,
        alice_hand_value,
        raw_win_direction: win_direction,
        win_direction: match win_direction {
            1 => Some(WinDirectionUser::Alice),
            -1 => Some(WinDirectionUser::Bob),
            _ => None,
        },
    })
}

#[test]
fn test_decode_calpoker_readable() {
    let mut allocator = AllocEncoder::new();
    let assembled = (
        60,
        (
            59,
            (91, ([2, 2, 1, 12, 11, 8], ([2, 2, 1, 14, 5, 2], (-1, ())))),
        ),
    )
        .to_clvm(&mut allocator)
        .expect("should work");
    let decoded = decode_calpoker_readable(&mut allocator, assembled, Amount::new(200), false)
        .expect("should work");
    let alicev = RawCalpokerHandValue::SimpleList(vec![2, 2, 1, 12, 11, 8]);
    let bobv = RawCalpokerHandValue::SimpleList(vec![2, 2, 1, 14, 5, 2]);
    let alicer = alicev.hand_value().unwrap();
    let bobr = bobv.hand_value().unwrap();
    assert_eq!(
        decoded,
        CalpokerResult {
            raw_alice_selects: 60,
            raw_bob_picks: 59,
            raw_alice_picks: 91,
            alice_hand_result: alicer,
            bob_hand_result: bobr,
            alice_hand_value: alicev,
            bob_hand_value: bobv,
            your_share: 200,
            game_amount: 200,
            raw_win_direction: -1,
            win_direction: Some(WinDirectionUser::Bob),
        }
    );
}
