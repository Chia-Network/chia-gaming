#!/usr/bin/env python3

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import List
from itertools import permutations

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
        # print("self.cards", self.cards)
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


def cards_for_discards(cards, discards):
    """Cards is a list of cards, discards is a list of indices"""
    return ([card for (i,card) in enumerate(cards) if i in discards], [card for (i,card) in enumerate(cards) if i not in discards])




def exchange_cards(alice_hand, bob_hand, alice_discards, bob_discards):
    alice_give_away, alice_keep = cards_for_discards(alice_hand, alice_discards)
    bob_give_away, bob_keep = cards_for_discards(bob_hand, bob_discards)
    return (alice_keep + bob_give_away, bob_keep + alice_give_away)


def check_for_losing_selects(opponent_hand_rating, my_final_cards):
    potential_choices = list(range(8))
    tried = set()

    for full_bob_choice in permutations(potential_choices):
        lose_bob_selects = full_bob_choice[:5]
        if lose_bob_selects in tried:
            continue

        tried.add(lose_bob_selects)
        bob_hand = cards_for_discards(my_final_cards, lose_bob_selects)[0]
        bob_hand_rating = onehandcalc(Hand(bob_hand))
        print(f"checking bob selects {lose_bob_selects} alice rating {opponent_hand_rating} bob {bob_hand_rating}")
        if opponent_hand_rating > bob_hand_rating:
            return lose_bob_selects

    return None


def find_win_and_loss(alice_initial_hand, bob_initial_hand, alice_discards, bob_discards, alice_selects, bob_selects):
    tried = set()

    alice_final_cards, bob_final_cards = exchange_cards(alice_initial_hand, bob_initial_hand, alice_discards, bob_discards)
    alice_hand_rating = onehandcalc(Hand(cards_for_discards(alice_final_cards, alice_selects)[0]))
    bob_hand_rating = onehandcalc(Hand(cards_for_discards(bob_final_cards, bob_selects)[0]))

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
    int_seed = 490
    alice_hand_rating = 0
    bob_hand_rating = 1
    can_make_win_and_loss = None

    while (can_make_win_and_loss is None) and alice_hand_rating != bob_hand_rating:
        int_seed += 1
        alice_seed = sha256(("alice" + str(int_seed)).encode("utf8")).digest()
        bob_seed = sha256(("bob" + str(int_seed)).encode("utf8")).digest()
        seed = sha256(alice_seed + bob_seed + bytes(Program.to(200))).digest()
        r = make_cards(seed)
        alice_initial_hand = [CardIndex(clvm_byte_to_int(i)).to_card() for i in r[0]]
        bob_initial_hand = [CardIndex(clvm_byte_to_int(i)).to_card() for i in r[1]]
        alice_discards = [1,3,4,7]
        bob_discards = [0,2,4,6]
        alice_final_cards, bob_final_cards = exchange_cards(alice_initial_hand, bob_initial_hand, alice_discards, bob_discards)
        alice_handcalc = handcalc(Hand(alice_final_cards))
        bob_handcalc = handcalc(Hand(bob_final_cards))
        alice_selects = alice_handcalc[1]
        bob_selects = bob_handcalc[1]

        alice_picked_hand = cards_for_discards(alice_final_cards, alice_selects)[0]
        bob_picked_hand = cards_for_discards(bob_final_cards, bob_selects)[0]

        alice_hand_rating = onehandcalc(Hand(alice_picked_hand))
        bob_hand_rating = onehandcalc(Hand(bob_picked_hand))

        if alice_hand_rating != bob_hand_rating:
            print(f"{int_seed} alice and bob didn't tie on tie discards")
            continue

        can_make_win_and_loss = find_win_and_loss(alice_initial_hand, bob_initial_hand, alice_discards, bob_discards, alice_selects, bob_selects)

        if not can_make_win_and_loss:
            print(f"{int_seed} can't make win and loss")
            # Can't make win and loss so this isn't a suitable seed
            alice_hand_rating = None

    alice_loss_selects, bob_loss_selects = can_make_win_and_loss

    print(f"\n\n***\n\nTie found. int_seed={int_seed}")
    print("Alice hand:", alice_picked_hand)
    print("  Bob hand:", [CardIndex(clvm_byte_to_int(i)) for i in r[1]])
    print(f"  Tie outcome: {alice_hand_rating}")
    print(f"Alice loss selects:", alice_loss_selects)
    print(f"Alice loss cards:", cards_for_discards(alice_final_cards, alice_loss_selects)[0])
    print(f"Alice loss outcome:", onehandcalc(Hand(cards_for_discards(alice_final_cards, alice_loss_selects)[0])))
    print(f"  Bob loss selects:", bob_loss_selects)
    print("  Bob loss cards:", cards_for_discards(bob_final_cards, bob_loss_selects)[0])
    print(f"  Bob outcome:", onehandcalc(Hand(cards_for_discards(bob_final_cards, bob_loss_selects)[0])))


# TODO: discards, selects, and use handcalc

if __name__ == "__main__":
    find_tie()
    sys.exit(0)
