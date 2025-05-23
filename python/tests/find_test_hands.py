#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from functools import total_ordering
from hashlib import sha256
from itertools import permutations
from pathlib import Path
from typing import List

from calpoker import Card, CardIndex, Hand, Rank, Suit, index_to_card
from clvm_types.program import Program
from seed import GameSeed
from util import dbg_assert_eq, load_clvm_hex

cwd = Path(os.path.dirname(__file__))
test_handcalc_micro = load_clvm_hex(cwd / "../clsp/test/test_handcalc_micro.hex")

# src/games/calpoker.rs

seed = 0


# Note on card formats:
def load_clvm_hex(path: Path) -> Program:
    with open(path, "r") as hexfile:
        return Program.fromhex(hexfile.read())


cwd = Path(os.path.dirname(__file__))
test_handcalc_micro = load_clvm_hex(cwd / "../clsp/test/test_handcalc_micro.hex")


@dataclass  # (frozen=True)
class Hand:
    cards: List[Card]

    def __init__(self, card_list):
        self.cards = card_list

    def to_clvm(self):
        # print("self.cards", self.cards)
        return Program.to([(card.rank, card.suit) for card in self.cards])


def card_to_index(card: Card) -> CardIndex:
    return CardIndex((card.rank - 2) * 4 + (card.suit - 1))


def index_to_card(card_index: CardIndex) -> Card:
    rank = card_index.index // 4
    suit = card_index.index % 4
    return Card(rank=rank + 2, suit=suit + 1)


@dataclass  # (frozen=True)
class CardIndex:
    index: int

    def __init__(self, index):
        self.index = index

    def __repr__(self):
        return f"CardIndex({self.index})"

    def to_card(self) -> Card:
        return index_to_card(self)


@dataclass  # (frozen=True)
class Rank:
    value: int

    def __init__(self, value):
        assert value >= 2
        assert value <= 14
        self.value = value


@dataclass  # (frozen=True)
class Suit:
    value: int

    def __init__(self, value):
        assert value >= 1
        assert value <= 4
        self.value = value


@dataclass  # (frozen=True)
@total_ordering
class Card:
    rank: Rank
    suit: Suit

    def __init__(self, rank, suit):
        _, _ = Rank(rank), Suit(suit)
        self.rank = rank
        self.suit = suit

    def __eq__(self, other):
        return self.rank == other.rank and self.suit == other.suit

    def __lt__(self, other):
        return (
            self.rank < other.rank or self.rank == other.rank and self.suit < other.suit
        )

    def to_index():
        return None

    def to_card_index(self) -> CardIndex:
        return card_to_index(self)


# Rank 2-14
# Suit 1-4


# def cards_to_hand(cards) -> Hand:
#     return Hand()


# randomness: Sha256
def make_cards(randomness):
    # (handa (mergeover handa handb 0)
    # randomness is the sha256 of (alice seed, bob_seed, amount)
    result = test_handcalc_micro.run(["make_cards", randomness])
    handa = result.as_python()[0]
    handb = result.as_python()[1]
    return handa, handb


def onehandcalc(hand: Hand):
    result = test_handcalc_micro.run(["onehandcalc", hand.to_clvm()])
    return result.as_python()


def handcalc(hand: Hand):
    result = test_handcalc_micro.run(["handcalc", hand.to_clvm()])
    py_result = result.as_python()
    # print('handcalc', py_result)
    return (py_result[0], [Program.to(x).as_int() for x in py_result[1]])


def int_to_clvm_bytes(i: int) -> bytes:
    return bytes(Program.to(i))


# def generate_hand_from_seed(alice_hash: bytes32, bob_hash: bytes32, amount: int):
#     amount_bytes = int_to_clvm_bytes(amount)
#     byte_string = alice_hash + bob_hash + amount_bytes
#     # assert len(byte_string) == 32 + 32 +
#     randomness = sha256(byte_string).digest()


"""
pub enum RawCalpokerHandValue {
    SimpleList(Vec<usize>),
    PrefixList(Vec<usize>, Vec<usize>),
}
"""


def compare_hands():
    pass


def find_good_hand():
    pass


def find_bad_hand():
    pass


def clvm_byte_to_int(b: bytes) -> int:
    # print(f"input byte: {b}")
    if len(b) == 0:
        return 0
    assert len(b) == 1
    return ord(b)


@dataclass
class SelectedCards:
    selected: List[Card]
    leftover: List[Card]


def selected_cards_by_index(cards, indicies):
    """Cards is a list of cards, discards is a list of indices"""
    return SelectedCards(
        [card for (i, card) in enumerate(cards) if i in indicies],
        [card for (i, card) in enumerate(cards) if i not in indicies],
    )


def poker_selected_cards(cards, indicies) -> Hand:
    assert len(cards) == 8
    dbg_assert_eq(len(indicies), 5)
    """The local game driver code will choose the best hand for us"""
    hand = selected_cards_by_index(cards, indicies).selected
    assert len(hand) == 5
    return Hand(hand)


def cards_for_discards(cards, discards):
    return selected_cards_by_index(cards, discards)


def exchange_cards(alice_hand, bob_hand, alice_discards, bob_discards):
    def cards_to_indices(cards):
        return [x.to_card_index().index for x in cards]

    def bytes_to_int(b):
        if len(b) == 0:
            return 0
        return b[0]

    def indices_to_cards(indices):
        return [CardIndex(bytes_to_int(i)).to_card() for i in indices]

    def indices_to_number(i):
        res = 0
        for x in i:
            res |= 1 << x
        return res

    raw_input = Program.to(
        [
            "get_final_cards_in_canonical_order",
            cards_to_indices(alice_hand),
            indices_to_number(alice_discards),
            cards_to_indices(bob_hand),
            indices_to_number(bob_discards),
        ]
    )
    raw_output = test_handcalc_micro.run(raw_input).as_python()
    return (indices_to_cards(raw_output[0]), indices_to_cards(raw_output[1]))


def check_for_losing_selects(opponent_hand_rating, my_final_cards):
    potential_choices = list(range(8))
    tried = set()

    for full_bob_choice in permutations(potential_choices):
        lose_bob_selects = full_bob_choice[:5]
        if lose_bob_selects in tried:
            continue

        tried.add(lose_bob_selects)
        # taking 5 of the 8 cards. The "selected" cards become our hand
        bob_hand = poker_selected_cards(my_final_cards, lose_bob_selects)
        bob_hand_rating = onehandcalc(bob_hand)
        print(
            f"checking bob selects {lose_bob_selects} alice rating {opponent_hand_rating} bob {bob_hand_rating}"
        )
        if opponent_hand_rating > bob_hand_rating:
            return lose_bob_selects

    return None


def find_win_and_loss(
    alice_initial_hand,
    bob_initial_hand,
    alice_discards,
    bob_discards,
    alice_selects,
    bob_selects,
):
    tried = set()

    alice_final_cards, bob_final_cards = exchange_cards(
        alice_initial_hand, bob_initial_hand, alice_discards, bob_discards
    )
    alice_hand_rating = onehandcalc(
        poker_selected_cards(alice_final_cards, alice_selects)
    )
    bob_hand_rating = onehandcalc(poker_selected_cards(bob_final_cards, bob_selects))

    lose_alice_selects = check_for_losing_selects(bob_hand_rating, alice_final_cards)
    lose_bob_selects = check_for_losing_selects(alice_hand_rating, bob_final_cards)

    if lose_alice_selects is not None and lose_bob_selects is not None:
        return (lose_alice_selects, lose_bob_selects)
    else:
        return None


# An example of a good hand:
# good_hand = Hand([Card(14, 1), Card(14, 2), Card(14, 3), Card(14, 4), Card(2, 2)])
# good_hand_rating = onehandcalc(good_hand)
# print(f"good_hand_rating: {good_hand_rating}")
def find_tie():
    int_seed = 1000
    alice_hand_rating = 0
    bob_hand_rating = 1
    can_make_win_and_loss = None
    alice_initial_hand = None
    bob_initial_hand = None

    while (can_make_win_and_loss is None) and alice_hand_rating != bob_hand_rating:
        int_seed += 1
        print(f"int_seed={int_seed}")
        game_seed = GameSeed(int_seed)
        r = make_cards(game_seed.seed)
        alice_initial_hand = [CardIndex(clvm_byte_to_int(i)).to_card() for i in r[0]]
        bob_initial_hand = [CardIndex(clvm_byte_to_int(i)).to_card() for i in r[1]]
        alice_discards = [1, 3, 4, 7]
        bob_discards = [0, 2, 4, 6]
        alice_final_cards, bob_final_cards = exchange_cards(
            alice_initial_hand, bob_initial_hand, alice_discards, bob_discards
        )
        print(
            f"alice_final_cards, bob_final_cards = {alice_final_cards, bob_final_cards}"
        )
        alice_handcalc = handcalc(Hand(alice_final_cards))
        bob_handcalc = handcalc(Hand(bob_final_cards))
        dbg_assert_eq(len(alice_handcalc[1]), 5, msg=f"alice_handcalc={alice_handcalc}")
        dbg_assert_eq(len(bob_handcalc[1]), 5, msg=f"bob_handcalc={bob_handcalc}")
        alice_selects = alice_handcalc[1]
        bob_selects = bob_handcalc[1]

        alice_picked_hand = poker_selected_cards(alice_final_cards, alice_selects)
        bob_picked_hand = poker_selected_cards(bob_final_cards, bob_selects)

        alice_hand_rating = onehandcalc(alice_picked_hand)
        bob_hand_rating = onehandcalc(bob_picked_hand)

        if alice_hand_rating != bob_hand_rating:
            print(f"{int_seed} alice and bob didn't tie on tie discards")
            continue

        can_make_win_and_loss = find_win_and_loss(
            alice_initial_hand,
            bob_initial_hand,
            alice_discards,
            bob_discards,
            alice_selects,
            bob_selects,
        )

        if not can_make_win_and_loss:
            print(f"{int_seed} can't make win and loss")
            # Can't make win and loss so this isn't a suitable seed
            alice_hand_rating = None

    alice_loss_selects, bob_loss_selects = can_make_win_and_loss

    # Note that we never compare alice "loss" selections to bob's "loss" selections
    print(f"\n\n***\n\nTie found. int_seed={int_seed}")
    print("Alice pre picks cards:", alice_initial_hand)
    print("  Bob pre picks cards:", bob_initial_hand)
    print(f"Make cards seed: {Program.to(game_seed.seed)}")
    print("Alice full hand:", sorted(alice_final_cards))
    print("  Bob full hand:", sorted(bob_final_cards))
    print("Alice hand:", sorted(alice_picked_hand.cards))
    print("  Bob hand:", sorted(bob_picked_hand.cards))
    print(f"  Tie outcome: {alice_hand_rating}")
    print(f"Alice loss selects:", alice_loss_selects)
    print(
        f"Alice loss cards:",
        poker_selected_cards(alice_final_cards, alice_loss_selects),
    )
    print(
        f"Alice loss outcome:",
        onehandcalc(poker_selected_cards(alice_final_cards, alice_loss_selects)),
    )
    print(f"  Bob loss selects:", bob_loss_selects)
    print("  Bob loss cards:", poker_selected_cards(bob_final_cards, bob_loss_selects))
    print(
        f"  Bob outcome:",
        onehandcalc(poker_selected_cards(bob_final_cards, bob_loss_selects)),
    )
    print(f"alice final cards: {alice_final_cards}")
    print(f"bob_final_cards: {bob_final_cards}")

    test_input = {
        "amount": 200,
        "seed": int_seed,
        "alice_discards": alice_discards,
        "bob_discards": bob_discards,
        # selects in the format of "move" in the validation programs
        "alice_good_selections": alice_selects,  # ???
        "bob_good_selections": bob_selects,  # ???
        "alice_loss_selections": alice_loss_selects,
        "bob_loss_selections": bob_loss_selects,
        "alice_hand_rating": [x[0] for x in alice_hand_rating],
        "bob_hand_rating": [x[0] for x in bob_hand_rating],
    }
    print()
    print(json.dumps(test_input))


# TODO: discards, selects, and use handcalc

if __name__ == "__main__":
    find_tie()
    sys.exit(0)
