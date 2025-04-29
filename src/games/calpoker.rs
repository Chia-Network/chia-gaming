use std::cmp::Ordering;

use log::debug;

use crate::channel_handler::types::ReadableMove;
#[cfg(test)]
use clvm_traits::ClvmEncoder;
use clvm_traits::ToClvm;
use clvmr::{run_program, NodePtr};

#[cfg(test)]
use crate::common::types::Node;
use crate::common::types::{chia_dialect, IntoErr};

use crate::common::standard_coin::read_hex_puzzle;
use crate::utils::{map_m, proper_list};

use serde::{Deserialize, Serialize};

use crate::common::types::{
    atom_from_clvm, i64_from_atom, usize_from_atom, AllocEncoder, Error, Program,
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
//
// Things we need as input
//
// Available by message, alice driver b and bob driver c.
//
// pub my_initial_cards: Vec<u8>,
// pub opponent_initial_cards: Vec<u8>,
pub struct CalpokerResult {
    //
    // Things we must preserve
    //
    pub my_discards: u8,

    //
    // Things in the report
    //
    pub opponent_discards: u8,
    pub raw_alice_selects: u8,
    pub raw_bob_selects: u8,
    pub alice_hand_value: RawCalpokerHandValue,
    pub bob_hand_value: RawCalpokerHandValue,
    pub raw_win_direction: i64,

    //
    // Synthesized
    //
    pub win_direction: Option<WinDirectionUser>,
    pub alice_final_hand: Vec<Card>,
    pub bob_final_hand: Vec<Card>,
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

pub fn select_cards_using_bits(cardlist: &[Card], selections: usize) -> (CardList, CardList) {
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

pub fn card_to_clvm(allocator: &mut AllocEncoder, card: &Card) -> Result<NodePtr, Error> {
    [card.0, card.1].to_clvm(allocator).into_gen()
}

pub fn card_list_to_clvm(
    allocator: &mut AllocEncoder,
    cards: &[Card],
) -> Result<Vec<NodePtr>, Error> {
    map_m(&mut |card: &Card| card_to_clvm(allocator, card), cards)
}

pub fn card_list_from_clvm(
    allocator: &mut AllocEncoder,
    nodeptr: NodePtr,
) -> Result<Vec<Card>, Error> {
    let main_list = if let Some(p) = proper_list(allocator.allocator(), nodeptr, true) {
        p
    } else {
        return Err(Error::StrErr("improper card list".to_string()));
    };
    map_m(
        &mut |card_node: &NodePtr| {
            let card_list = if let Some(c) = proper_list(allocator.allocator(), *card_node, true) {
                c
            } else {
                return Err(Error::StrErr("improper card in list".to_string()));
            };
            Ok((
                atom_from_clvm(allocator, card_list[0])
                    .and_then(|a| usize_from_atom(&a))
                    .unwrap_or_default(),
                atom_from_clvm(allocator, card_list[1])
                    .and_then(|a| usize_from_atom(&a))
                    .unwrap_or_default(),
            ))
        },
        &main_list,
    )
}

pub fn get_final_cards_in_canonical_order(
    allocator: &mut AllocEncoder,
    alice_initial_cards: &[Card],
    alice_discards: u8,
    bob_initial_cards: &[Card],
    bob_discards: u8,
) -> Result<(Vec<Card>, Vec<Card>), Error> {
    let split_cards_prog = read_hex_puzzle(allocator, "clsp/test/test_handcalc_micro.hex")?;
    // Generate the final split cards from the discards.
    let alice_cards_node = card_list_to_clvm(allocator, alice_initial_cards)?;
    let bob_cards_node = card_list_to_clvm(allocator, bob_initial_cards)?;
    let split_cards_args = (
        "get_final_cards_in_canonical_order",
        (
            alice_cards_node,
            (alice_discards, (bob_cards_node, (bob_discards, ()))),
        ),
    )
        .to_clvm(allocator)
        .into_gen()?;
    let split_cards_node = split_cards_prog.to_clvm(allocator).into_gen()?;
    let split_result = run_program(
        allocator.allocator(),
        &chia_dialect(),
        split_cards_node,
        split_cards_args,
        0,
    )
    .into_gen()?
    .1;
    if let Some(l) = proper_list(allocator.allocator(), split_result, true) {
        let alice_final_cards = card_list_from_clvm(allocator, l[0])?;
        let bob_final_cards = card_list_from_clvm(allocator, l[1])?;
        Ok((alice_final_cards, bob_final_cards))
    } else {
        Err(Error::StrErr(
            "bad list result from get_final_cards_in_canonical_order".to_string(),
        ))
    }
}

// Given a readable move, decode it as a calpoker outcome.
// This is the last reply that each side receives
// > opd ff81aaff81e3ff818fffff02ff01ff01ff01ff03ff0eff0dff0b80ffff02ff02ff01ff04ff02ff0c80ff81ff80
// (-86 -29 -113 (a 1 1 1 3 14 13 11) (a 2 1 4 2 12) -1)
// > opd ff55ff81e3ff818fffff02ff01ff01ff01ff03ff0eff0dff0b80ffff02ff02ff01ff04ff02ff0c80ff0180
// (85 -29 -113 (a 1 1 1 3 14 13 11) (a 2 1 4 2 12) 1)

pub fn decode_calpoker_readable(
    allocator: &mut AllocEncoder,
    readable: NodePtr,
    i_am_alice: bool,
    my_discards: u8,
    alice_initial_cards: &[Card],
    bob_initial_cards: &[Card],
) -> Result<CalpokerResult, Error> {
    debug!(
        "decode_calpoker_readable {:?}",
        Program::from_nodeptr(allocator, readable)
    );

    let as_list = if let Some(as_list) = proper_list(allocator.allocator(), readable, true) {
        as_list
    } else {
        return Err(Error::StrErr(
            "decode calpoker readable: non-list".to_string(),
        ));
    };

    if as_list.len() < 6 {
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

    let alice_hand_value = decode_hand_result(allocator, as_list[3])?;
    let bob_hand_value = decode_hand_result(allocator, as_list[4])?;

    let mut raw_win_direction = atom_from_clvm(allocator, as_list[5])
        .and_then(|a| i64_from_atom(&a))
        .unwrap_or_default();

    raw_win_direction = if i_am_alice {
        -raw_win_direction
    } else {
        raw_win_direction
    };

    let win_direction = match raw_win_direction.cmp(&0) {
        Ordering::Greater => Some(WinDirectionUser::Bob),
        Ordering::Less => Some(WinDirectionUser::Alice),
        _ => None,
    };

    let opponent_discards = bitmasks[0] as u8;
    let (alice_discards, bob_discards) = if i_am_alice {
        (my_discards, opponent_discards)
    } else {
        (opponent_discards, my_discards)
    };

    let (alice_final_cards, bob_final_cards) = get_final_cards_in_canonical_order(
        allocator,
        alice_initial_cards,
        alice_discards,
        bob_initial_cards,
        bob_discards,
    )?;

    let raw_alice_selects = bitmasks[1] as u8;
    let raw_bob_selects = bitmasks[2] as u8;
    let (alice_final_hand, _) =
        select_cards_using_bits(&alice_final_cards, raw_alice_selects as usize);
    let (bob_final_hand, _) = select_cards_using_bits(&bob_final_cards, raw_bob_selects as usize);

    Ok(CalpokerResult {
        my_discards,

        opponent_discards,
        raw_alice_selects,
        raw_bob_selects,
        alice_hand_value,
        bob_hand_value,
        raw_win_direction,

        win_direction,
        alice_final_hand,
        bob_final_hand,
    })
}

#[test]
fn test_decode_calpoker_readable() {
    let mut allocator = AllocEncoder::new();
    let alice_selects_node = allocator
        .encode_atom(clvm_traits::Atom::Borrowed(&[0xf8]))
        .expect("ok");
    let bob_selects_node = allocator
        .encode_atom(clvm_traits::Atom::Borrowed(&[0xce]))
        .expect("ok");
    let assembled = (
        0x55, // Opponent discards
        (
            Node(alice_selects_node), // Alice selects
            (
                Node(bob_selects_node), // Bob selects
                (
                    [2, 2, 1, 14, 8, 12], // Alice hand value
                    (
                        [2, 2, 1, 14, 8, 12], // Bob hand value
                        (0, ()),
                    ),
                ),
            ),
        ),
    )
        .to_clvm(&mut allocator)
        .expect("should work");

    let alice_initial_cards = &[
        (2, 2),
        (5, 3),
        (8, 2),
        (11, 3),
        (14, 1),
        (14, 2),
        (14, 3),
        (14, 4),
    ];
    let bob_initial_cards = &[
        (3, 3),
        (4, 1),
        (5, 4),
        (8, 1),
        (8, 3),
        (8, 4),
        (12, 2),
        (12, 3),
    ];

    let (alice_final_cards, bob_final_cards) = get_final_cards_in_canonical_order(
        &mut allocator,
        alice_initial_cards,
        0xaa,
        bob_initial_cards,
        0x55,
    )
    .expect("should pick");

    let (alice_final_hand, _) = select_cards_using_bits(&alice_final_cards, 0xf8);
    let (bob_final_hand, _) = select_cards_using_bits(&bob_final_cards, 0xce);

    let decoded = decode_calpoker_readable(
        &mut allocator,
        assembled,
        true,
        0xaa as u8,
        alice_initial_cards,
        bob_initial_cards,
    )
    .expect("should work");

    let alicev = RawCalpokerHandValue::SimpleList(vec![2, 2, 1, 14, 8, 12]); // Alice hand value

    let bobv = RawCalpokerHandValue::SimpleList(vec![2, 2, 1, 14, 8, 12]); // Bob hand value same
    assert_eq!(
        decoded,
        CalpokerResult {
            my_discards: 0xaa as u8,
            opponent_discards: 0x55 as u8,
            raw_alice_selects: 0xf8 as u8,
            raw_bob_selects: 0xce as u8,
            alice_hand_value: alicev,
            bob_hand_value: bobv,
            raw_win_direction: 0 as i64,
            alice_final_hand,
            bob_final_hand,
            win_direction: None,
        }
    );
}

#[test]
fn test_decode_calpoker_readable_outcome_matches() {
    let mut allocator = AllocEncoder::new();
    let alice_selects_node = allocator
        .encode_atom(clvm_traits::Atom::Borrowed(&[0xf8]))
        .expect("ok");
    let bob_selects_node = allocator
        .encode_atom(clvm_traits::Atom::Borrowed(&[0xce]))
        .expect("ok");
    let assembled = (
        0x55, // Opponent discards
        (
            Node(alice_selects_node), // Alice selects
            (
                Node(bob_selects_node), // Bob selects
                (
                    [2, 2, 1, 14, 8, 12], // Alice hand value
                    (
                        [2, 2, 1, 14, 8, 12], // Bob hand value
                        (0, ()),
                    ),
                ),
            ),
        ),
    )
        .to_clvm(&mut allocator)
        .expect("should work");

    let alice_initial_cards = &[
        (2, 2),
        (5, 3),
        (8, 2),
        (11, 3),
        (14, 1),
        (14, 2),
        (14, 3),
        (14, 4),
    ];
    let bob_initial_cards = &[
        (3, 3),
        (4, 1),
        (5, 4),
        (8, 1),
        (8, 3),
        (8, 4),
        (12, 2),
        (12, 3),
    ];

    let (alice_final_cards, bob_final_cards) = get_final_cards_in_canonical_order(
        &mut allocator,
        alice_initial_cards,
        0xaa,
        bob_initial_cards,
        0x55,
    )
    .expect("should pick");

    let (alice_final_hand, _) = select_cards_using_bits(&alice_final_cards, 0xf8);
    let (bob_final_hand, _) = select_cards_using_bits(&bob_final_cards, 0xce);

    let decoded = decode_calpoker_readable(
        &mut allocator,
        assembled,
        true,
        0xaa as u8,
        alice_initial_cards,
        bob_initial_cards,
    )
    .expect("should work");

    let alicev = RawCalpokerHandValue::SimpleList(vec![2, 2, 1, 14, 8, 12]); // Alice hand value

    let bobv = RawCalpokerHandValue::SimpleList(vec![2, 2, 1, 14, 8, 12]); // Bob hand value same
    assert_eq!(
        decoded,
        CalpokerResult {
            my_discards: 0xaa as u8,
            opponent_discards: 0x55 as u8,
            raw_alice_selects: 0xf8 as u8,
            raw_bob_selects: 0xce as u8,
            alice_hand_value: alicev,
            bob_hand_value: bobv,
            raw_win_direction: 0 as i64,
            alice_final_hand,
            bob_final_hand,
            win_direction: None,
        }
    );
}
