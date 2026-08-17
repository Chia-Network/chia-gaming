import { Program } from 'clvm-lib';

import { makeDescription } from './components/utils';
import { cardIdToRankSuit, handValueToDescription } from './types/cardHelpers';

function selectCardsUsingBits<T>(cards: T[], mask: bigint): T[][] {
  const kept: T[] = [];
  const selected: T[] = [];

  cards.forEach((card, index) => {
    if ((mask & (1n << BigInt(index))) !== 0n) {
      selected.push(card);
    } else {
      kept.push(card);
    }
  });

  return [kept, selected];
}

function compareCards(a: bigint, b: bigint): number {
  const aRankSuit = cardIdToRankSuit(a);
  const bRankSuit = cardIdToRankSuit(b);
  const rankDifference = aRankSuit.rank - bRankSuit.rank;
  return rankDifference === 0 ? aRankSuit.suit - bRankSuit.suit : rankDifference;
}

export interface CalpokerOutcomeShape<T extends bigint | string> {
  my_win_outcome: 'win' | 'lose' | 'tie';
  my_cards: T[];
  their_cards: T[];
  my_final_hand: T[];
  their_final_hand: T[];
  my_used_cards: T[];
  their_used_cards: T[];
  my_hand_value: T[];
  their_hand_value: T[];
}

export interface CalpokerFinalDisplayProjection<T extends bigint | string> {
  winner: 'player' | 'ai' | 'tie';
  playerCards: T[];
  opponentCards: T[];
  playerDiscardIds: T[];
  opponentDiscardIds: T[];
  playerHaloCardIds: T[];
  opponentHaloCardIds: T[];
  playerBestHandCardIds: T[];
  opponentBestHandCardIds: T[];
  playerDisplayText: string;
  opponentDisplayText: string;
}

export function projectCalpokerFinalDisplay<T extends bigint | string>(
  outcome: CalpokerOutcomeShape<T>,
): CalpokerFinalDisplayProjection<T> {
  const playerFinalSet = new Set(outcome.my_final_hand);
  const opponentFinalSet = new Set(outcome.their_final_hand);
  const playerDiscardIds = outcome.my_cards.filter((id) => !playerFinalSet.has(id));
  const opponentDiscardIds = outcome.their_cards.filter((id) => !opponentFinalSet.has(id));
  const playerDiscardToIncoming = new Map<T, T>();
  const opponentDiscardToIncoming = new Map<T, T>();
  for (let index = 0; index < playerDiscardIds.length; index++) {
    playerDiscardToIncoming.set(playerDiscardIds[index], opponentDiscardIds[index]);
  }
  for (let index = 0; index < opponentDiscardIds.length; index++) {
    opponentDiscardToIncoming.set(opponentDiscardIds[index], playerDiscardIds[index]);
  }
  const playerCards = outcome.my_cards.map((card) => playerDiscardToIncoming.get(card) ?? card);
  const opponentCards = outcome.their_cards.map(
    (card) => opponentDiscardToIncoming.get(card) ?? card,
  );
  const asBigints = (values: T[]) => values.map(BigInt);

  return {
    winner:
      outcome.my_win_outcome === 'win'
        ? 'player'
        : outcome.my_win_outcome === 'lose'
          ? 'ai'
          : 'tie',
    playerCards,
    opponentCards,
    playerDiscardIds,
    opponentDiscardIds,
    playerHaloCardIds: opponentDiscardIds,
    opponentHaloCardIds: playerDiscardIds,
    playerBestHandCardIds: outcome.my_used_cards,
    opponentBestHandCardIds: outcome.their_used_cards,
    playerDisplayText: makeDescription(
      handValueToDescription(asBigints(outcome.my_hand_value), asBigints(outcome.my_used_cards)),
    ),
    opponentDisplayText: makeDescription(
      handValueToDescription(
        asBigints(outcome.their_hand_value),
        asBigints(outcome.their_used_cards),
      ),
    ),
  };
}

export class CalpokerOutcome {
  alice_discards: bigint;
  bob_discards: bigint;

  alice_selects: bigint;
  bob_selects: bigint;

  alice_hand_value: bigint[];
  bob_hand_value: bigint[];

  win_direction: bigint;
  my_win_outcome: 'win' | 'lose' | 'tie';

  alice_cards: bigint[];
  bob_cards: bigint[];

  alice_final_hand: bigint[];
  bob_final_hand: bigint[];

  alice_used_cards: bigint[];
  bob_used_cards: bigint[];

  my_cards: bigint[];
  their_cards: bigint[];
  my_final_hand: bigint[];
  their_final_hand: bigint[];
  my_used_cards: bigint[];
  their_used_cards: bigint[];
  my_hand_value: bigint[];
  their_hand_value: bigint[];

  constructor(
    iStarted: boolean,
    myDiscards: bigint,
    aliceCards: bigint[],
    bobCards: bigint[],
    readableBytes: Uint8Array | number[],
  ) {
    const resultList = Program.deserialize(Uint8Array.from(readableBytes)).toList();
    this.alice_cards = aliceCards;
    this.bob_cards = bobCards;

    this.alice_selects = resultList[1].toBigInt();
    this.bob_selects = resultList[2].toBigInt();
    this.alice_hand_value = resultList[3].toList().map((value) => value.toBigInt());
    this.bob_hand_value = resultList[4].toList().map((value) => value.toBigInt());
    let rawWinDirection = resultList[5].toBigInt();
    if (iStarted) {
      rawWinDirection *= -1n;
      this.alice_discards = resultList[0].toBigInt();
      this.bob_discards = myDiscards;
    } else {
      this.alice_discards = myDiscards;
      this.bob_discards = resultList[0].toBigInt();
    }

    this.win_direction = rawWinDirection;
    const aliceWins = this.win_direction < 0n;
    this.my_win_outcome =
      this.win_direction === 0n ? 'tie' : aliceWins === iStarted ? 'win' : 'lose';

    const [aliceForAlice, aliceForBob] = selectCardsUsingBits(
      this.alice_cards,
      this.alice_discards,
    );
    const [bobForBob, bobForAlice] = selectCardsUsingBits(this.bob_cards, this.bob_discards);

    this.alice_final_hand = [...bobForAlice, ...aliceForAlice].sort(compareCards);
    this.bob_final_hand = [...aliceForBob, ...bobForBob].sort(compareCards);
    this.alice_used_cards = selectCardsUsingBits(this.alice_final_hand, this.alice_selects)[1];
    this.bob_used_cards = selectCardsUsingBits(this.bob_final_hand, this.bob_selects)[1];

    const iAmAlice = !iStarted;
    this.my_cards = iAmAlice ? this.alice_cards : this.bob_cards;
    this.their_cards = iAmAlice ? this.bob_cards : this.alice_cards;
    this.my_final_hand = iAmAlice ? this.alice_final_hand : this.bob_final_hand;
    this.their_final_hand = iAmAlice ? this.bob_final_hand : this.alice_final_hand;
    this.my_used_cards = iAmAlice ? this.alice_used_cards : this.bob_used_cards;
    this.their_used_cards = iAmAlice ? this.bob_used_cards : this.alice_used_cards;
    this.my_hand_value = iAmAlice ? this.alice_hand_value : this.bob_hand_value;
    this.their_hand_value = iAmAlice ? this.bob_hand_value : this.alice_hand_value;
  }
}
