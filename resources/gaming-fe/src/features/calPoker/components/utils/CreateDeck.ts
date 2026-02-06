import { CardValueSuit } from "../../../../types/californiaPoker";
import { RANKS, SUITS } from "../constants/constants";

function createDeck(): CardValueSuit[] {
  const deck: Array<any> = [];
  SUITS.forEach((suit) => {
    RANKS.forEach((rank) => {
      deck.push({ suit, rank });
    });
  });
  return deck;
}

export default createDeck;