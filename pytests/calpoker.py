from __future__ import annotations

from dataclasses import dataclass
from functools import total_ordering
from pathlib import Path
from typing import List

from clvm_types.program import Program
from util import dbg_assert_eq

# src/games/calpoker.rs

seed = 0


@dataclass  # (frozen=True)
class Hand:
    cards: List[Card]

    def __init__(self, card_list):
        self.cards = card_list

    def to_clvm(self):
        # print("self.cards", self.cards)
        return Program.to([(card.rank, card.suit) for card in self.cards])


def card_to_index(card: Card) -> CardIndex:
    return CardIndex((card.rank.value - 2) * 4 + (card.suit.value - 1))


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
class Rank:  # TODO: Enum
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

    def to_index(self):
        return None

    def to_card_index(self) -> CardIndex:
        return card_to_index(self)

    def as_list(self) -> List[int]:
        return [self.rank, self.suit]
