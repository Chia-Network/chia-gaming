#!/usr/bin/env python3

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import List

from clvm_types.program import Program

# src/games/calpoker.rs

seed = 0

# Note on card formats:


# make_cards = load_clvm("onchain/calpoker/make_cards.clinc")  # choose
# onehandcalc = load_clvm("clsp/onchain/calpoker/onehandcalc.clinc")


@dataclass  # (frozen=True)
class Hand:
    cards: List[Card]

    def __init__(self, card_list):
        self.cards = card_list

    def to_clvm(self):
        print("self.cards", self.cards)
        return Program.to([(card.rank, card.suit) for card in self.cards])


def card_to_index(card: Card) -> CardIndex:
    return CardIndex(card.rank + card.suit * 4)


def index_to_card(card_index: CardIndex) -> Card:
    rank = card_index.index // 4
    suit = card_index.index % 4
    if rank == 12:
        return Card(1, suit + 1)
    else:
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
class Card:
    rank: Rank
    suit: Suit

    def to_index():
        return None

    def to_card_index(self) -> CardIndex:
        return card_to_index(self.rank, self.suit)


# Rank 2-14
# Suit 1-4


def load_clvm_hex(path: Path) -> Program:
    with open(path, "r") as hexfile:
        return Program.fromhex(hexfile.read())


cwd = Path(os.path.dirname(__file__))
test_handcalc_micro = load_clvm_hex(cwd / "../clsp/test/test_handcalc_micro.hex")


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


# An example of a good hand:
# good_hand = Hand([Card(14, 1), Card(14, 2), Card(14, 3), Card(14, 4), Card(2, 2)])
# good_hand_rating = onehandcalc(good_hand)
# print(f"good_hand_rating: {good_hand_rating}")
def find_tie():
    int_seed = 0
    alice_hand_rating = 0
    bob_hand_rating = 1

    while alice_hand_rating != bob_hand_rating:
        alice_seed = sha256(("alice" + str(int_seed)).encode("utf8")).digest()
        bob_seed = sha256(("bob" + str(int_seed)).encode("utf8")).digest()
        seed = sha256(alice_seed + bob_seed + bytes(Program.to(200))).digest()
        r = make_cards(seed)
        alice_hand = [CardIndex(clvm_byte_to_int(i)).to_card() for i in r[0]]
        bob_hand = [CardIndex(clvm_byte_to_int(i)).to_card() for i in r[1]]
        alice_hand_rating = onehandcalc(Hand(alice_hand))
        bob_hand_rating = onehandcalc(Hand(bob_hand))
        int_seed += 1

    print(f"Tie found. int_seed={int_seed}")
    print("Alice hand:", alice_hand)
    print("  Bob hand:", [CardIndex(clvm_byte_to_int(i)) for i in r[1]])


# TODO: picks, selects, and use handcalc

if __name__ == "__main__":
    find_tie()
    sys.exit(0)
