import {
  __toESM,
  requireLiveGameMount,
  require_react,
  require_src
} from "./chunk-ZODP5B7L.js";

// ../games/calpoker/ui/types/cardHelpers.ts
function cardIdToRankSuit(cardId) {
  const id = typeof cardId === "bigint" ? Number(cardId) : cardId;
  const rank = Math.floor(id / 4) + 2;
  const suit = id % 4 + 1;
  return { rank, suit };
}
function aget(handValue, choice, def) {
  if (choice > handValue.length || choice < 0) {
    return def;
  }
  return handValue[choice];
}
function rget(array, start, end, def) {
  const result = [];
  for (let i = start; i < end; i++) {
    result.push(aget(array, i, def));
  }
  return result;
}
function handValueToDescription(handValue, _myCards) {
  const handType = rget(handValue, 0, 3, 0n);
  switch (handType.toString()) {
    case "3,1,3":
      return {
        name: "Flush",
        values: rget(handValue, 3, 8, 0n)
      };
    case "3,1,2":
      return {
        name: "Straight",
        values: [aget(handValue, 3, 0n)]
      };
    case "3,1,1":
      return {
        name: "Three of a kind",
        values: rget(handValue, 3, 6, 0n)
      };
    case "2,2,1":
      return {
        name: "Two Pair",
        values: rget(handValue, 3, 6, 0n)
      };
    case "2,1,1":
      return {
        name: "Pair",
        values: rget(handValue, 4, 8, 0n)
      };
  }
  handType.pop();
  switch (handType.toString()) {
    case "4,1":
      return {
        name: "Four of a kind",
        values: rget(handValue, 2, 4, 0n)
      };
    case "3,2":
      return {
        name: "Full house",
        values: rget(handValue, 2, 4, 0n)
      };
  }
  if (handType[0] === 5n) {
    const highCard = aget(handValue, 1, 0n);
    return {
      name: highCard === 14n ? "Royal flush" : "Straight flush",
      values: [highCard]
    };
  }
  return {
    name: "High card",
    values: rget(handValue, 5, 10, 0n)
  };
}

// ../games/calpoker/ui/components/utils/gameLog.ts
var LOG_RANKS = {
  14: "A",
  13: "K",
  12: "Q",
  11: "J",
  10: "T",
  9: "9",
  8: "8",
  7: "7",
  6: "6",
  5: "5",
  4: "4",
  3: "3",
  2: "2"
};
var LOG_SUITS = { 1: "\u{1FA8F}", 2: "\u2764\uFE0F", 3: "\u{1F48E}", 4: "\u{1F340}" };
var SUIT_SORT_KEY = { 1: 0, 2: 1, 3: 2, 4: 3 };
function formatCardForLog(cardId) {
  const { rank, suit } = cardIdToRankSuit(cardId);
  return `${LOG_RANKS[rank] ?? String(rank)}${LOG_SUITS[suit] ?? "?"}`;
}
function compareCardsDescending(a, b) {
  const aRS = cardIdToRankSuit(a);
  const bRS = cardIdToRankSuit(b);
  if (aRS.rank !== bRS.rank) return bRS.rank - aRS.rank;
  return SUIT_SORT_KEY[aRS.suit] - SUIT_SORT_KEY[bRS.suit];
}
function sortCardsForLog(cardIds) {
  return [...cardIds].sort(compareCardsDescending);
}
function formatCardsForLog(cardIds) {
  return sortCardsForLog(cardIds).map(formatCardForLog).join("");
}
function formatOrderedCardsForLog(cardIds) {
  return cardIds.map(formatCardForLog).join("");
}
function isFlushOrStraight(handValue) {
  if (handValue.length < 1) return false;
  if (handValue[0] === 5n) return true;
  if (handValue.length < 3) return false;
  if (handValue[0] === 3n && handValue[1] === 1n && (handValue[2] === 3n || handValue[2] === 2n))
    return true;
  return false;
}
function isWheel(handValue) {
  if (handValue[0] === 5n && handValue[1] === 5n) return true;
  if (handValue[0] === 3n && handValue[1] === 1n && handValue[2] === 2n && handValue[3] === 5n)
    return true;
  return false;
}
function orderUsedCardsForLog(usedCards, handValue) {
  if (isFlushOrStraight(handValue)) {
    const sorted = [...usedCards].sort(compareCardsDescending);
    if (isWheel(handValue)) {
      const aces = [];
      const rest = [];
      for (const c of sorted) {
        if (cardIdToRankSuit(c).rank === 14) aces.push(c);
        else rest.push(c);
      }
      return [...rest, ...aces];
    }
    return sorted;
  }
  const byRank = /* @__PURE__ */ new Map();
  for (const c of usedCards) {
    const { rank } = cardIdToRankSuit(c);
    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank).push(c);
  }
  const groups = [...byRank.entries()].map(([rank, cards]) => ({
    rank,
    size: cards.length,
    cards: cards.sort(compareCardsDescending)
  }));
  groups.sort((a, b) => {
    if (a.size !== b.size) return b.size - a.size;
    return b.rank - a.rank;
  });
  return groups.flatMap((g) => g.cards);
}

// ../games/calpoker/ui/components/utils/MakeDescription.ts
var FULL_RANKS = {
  14: "Ace",
  13: "King",
  12: "Queen",
  11: "Jack",
  10: "Ten",
  9: "Nine",
  8: "Eight",
  7: "Seven",
  6: "Six",
  5: "Five",
  4: "Four",
  3: "Three",
  2: "Two"
};
var getRankName = (n) => FULL_RANKS[Number(n)] ?? n.toString();
var makeDescription = (desc) => {
  if (!desc || !desc.name) return "";
  const name = desc.name;
  const values = desc.values.map(getRankName);
  const main = values[0] || "";
  const kickers = values.slice(1);
  switch (name.toLowerCase()) {
    case "royal flush":
      return name;
    case "straight flush":
    case "straight":
      return `${name}, ${main} High`;
    case "flush":
      return `${name}, ${main} high${kickers.length ? ", " + kickers.join(", ") + " kickers" : ""}`;
    case "four of a kind":
      return kickers.length ? `${name}, ${main}s, ${kickers[0]} kicker` : `${name}, ${main}s`;
    case "full house":
      return values.length >= 2 ? `${name}, ${values[0]}s over ${values[1]}s` : name;
    case "set":
    case "three of a kind":
      return kickers.length ? `${name}, ${main}s. ${kickers.join(", ")} kickers` : `${name}, ${main}s`;
    case "two pair":
      return values.length >= 3 ? `Two Pair, ${values[0]}s over ${values[1]}s, ${values[2]} kicker` : values.length >= 2 ? `Two Pair, ${values[0]}s over ${values[1]}s` : name;
    case "pair":
      return kickers.length ? `${name}, ${main}s. ${kickers.join(", ")} kickers` : `${name}, ${main}s`;
    case "high card":
      return kickers.length ? `${main} high. ${kickers.join(", ")} kickers` : `${main} high`;
    default:
      return `${name} ${values.join(", ")}`;
  }
};

// ../games/calpoker/ui/outcome.ts
function selectCardsUsingBits(cards, mask) {
  const kept = [];
  const selected = [];
  cards.forEach((card, index) => {
    if ((mask & 1n << BigInt(index)) !== 0n) {
      selected.push(card);
    } else {
      kept.push(card);
    }
  });
  return [kept, selected];
}
function compareCards(a, b) {
  const aRankSuit = cardIdToRankSuit(a);
  const bRankSuit = cardIdToRankSuit(b);
  const rankDifference = aRankSuit.rank - bRankSuit.rank;
  return rankDifference === 0 ? aRankSuit.suit - bRankSuit.suit : rankDifference;
}
function projectCalpokerFinalDisplay(outcome) {
  const playerFinalSet = new Set(outcome.my_final_hand);
  const opponentFinalSet = new Set(outcome.their_final_hand);
  const playerDiscardIds = outcome.my_cards.filter((id) => !playerFinalSet.has(id));
  const opponentDiscardIds = outcome.their_cards.filter((id) => !opponentFinalSet.has(id));
  const playerDiscardToIncoming = /* @__PURE__ */ new Map();
  const opponentDiscardToIncoming = /* @__PURE__ */ new Map();
  for (let index = 0; index < playerDiscardIds.length; index++) {
    playerDiscardToIncoming.set(playerDiscardIds[index], opponentDiscardIds[index]);
  }
  for (let index = 0; index < opponentDiscardIds.length; index++) {
    opponentDiscardToIncoming.set(opponentDiscardIds[index], playerDiscardIds[index]);
  }
  const playerCards = outcome.my_cards.map((card) => playerDiscardToIncoming.get(card) ?? card);
  const opponentCards = outcome.their_cards.map(
    (card) => opponentDiscardToIncoming.get(card) ?? card
  );
  const asBigints = (values) => values.map(BigInt);
  return {
    winner: outcome.my_win_outcome === "win" ? "player" : outcome.my_win_outcome === "lose" ? "ai" : "tie",
    playerCards,
    opponentCards,
    playerDiscardIds,
    opponentDiscardIds,
    playerHaloCardIds: opponentDiscardIds,
    opponentHaloCardIds: playerDiscardIds,
    playerBestHandCardIds: outcome.my_used_cards,
    opponentBestHandCardIds: outcome.their_used_cards,
    playerDisplayText: makeDescription(
      handValueToDescription(asBigints(outcome.my_hand_value), asBigints(outcome.my_used_cards))
    ),
    opponentDisplayText: makeDescription(
      handValueToDescription(
        asBigints(outcome.their_hand_value),
        asBigints(outcome.their_used_cards)
      )
    )
  };
}
var CalpokerOutcome = class {
  alice_discards;
  bob_discards;
  alice_selects;
  bob_selects;
  alice_hand_value;
  bob_hand_value;
  win_direction;
  my_win_outcome;
  alice_cards;
  bob_cards;
  alice_final_hand;
  bob_final_hand;
  alice_used_cards;
  bob_used_cards;
  my_cards;
  their_cards;
  my_final_hand;
  their_final_hand;
  my_used_cards;
  their_used_cards;
  my_hand_value;
  their_hand_value;
  constructor(iStarted, myDiscards, aliceCards, bobCards, readable) {
    const resultList = readable.toList();
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
    this.my_win_outcome = this.win_direction === 0n ? "tie" : aliceWins === iStarted ? "win" : "lose";
    const [aliceForAlice, aliceForBob] = selectCardsUsingBits(
      this.alice_cards,
      this.alice_discards
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
};

// ../games/calpoker/ui/useCalpokerHand.ts
var import_react = __toESM(require_react());
var import_clvm_lib = __toESM(require_src());
function shouldAutoFireCalpokerMove(handFinished, isPlayerTurn, moveNumber) {
  return !handFinished && isPlayerTurn && (moveNumber === 0n || moveNumber === 2n);
}
function shouldRestoreCalpokerSelection(moveNumber, hasOutcome, hasTerminalOutcome) {
  return moveNumber === "1" && !hasOutcome && !hasTerminalOutcome;
}
function calpokerResponderFinishesAtReveal(iStarted) {
  return iStarted;
}
function calpokerRestoredDisplaySnapshot(snapshot, outcome) {
  if (snapshot?.gameState !== "final" || outcome === void 0) return snapshot;
  const display = projectCalpokerFinalDisplay(outcome);
  return {
    ...snapshot,
    playerDisplayText: display.playerDisplayText,
    opponentDisplayText: display.opponentDisplayText
  };
}
function useCalpokerHand(view) {
  const interactive = !view.frozen;
  const handState = view.hand.getState();
  const viewRef = (0, import_react.useRef)(view);
  const pendingPlayRef = (0, import_react.useRef)(false);
  const autoSubmissionRef = (0, import_react.useRef)(null);
  const suppressInitialOutcomeRef = (0, import_react.useRef)(
    handState.outcome !== void 0 && handState.displaySnapshot?.gameState === "final"
  );
  viewRef.current = view;
  const currentState = (0, import_react.useCallback)(() => {
    return viewRef.current.hand.getState();
  }, []);
  const commitState = (0, import_react.useCallback)(
    (update) => {
      const live = requireLiveGameMount(viewRef.current);
      live.hand.update(update);
      live.port.dispatch({ type: "state-changed" });
    },
    []
  );
  const commitLocalAction = (0, import_react.useCallback)(
    (update, command) => {
      const live = requireLiveGameMount(viewRef.current);
      const rejected = live.port.dispatch({
        type: "make-move",
        memberIndex: 0,
        readable: command.readable
      });
      if (rejected) return;
      live.hand.update(update);
      live.port.dispatch({ type: "state-changed" });
    },
    []
  );
  const submitMove1 = (0, import_react.useCallback)(() => {
    const live = requireLiveGameMount(viewRef.current);
    if (!live.port.isChannelReady()) return;
    const current = currentState();
    if ((current.cardSelections ?? []).length !== 4) return;
    const cards = current.cardSelections ?? [];
    commitLocalAction((current2) => ({ ...current2, moveNumber: 2n, isPlayerTurn: false }), {
      type: "make-move",
      readable: import_clvm_lib.Program.fromList(cards.map((c) => import_clvm_lib.Program.fromBigInt(c)))
    });
    pendingPlayRef.current = false;
  }, [commitLocalAction, currentState]);
  const handleMakeMove = (0, import_react.useCallback)(() => {
    const live = requireLiveGameMount(viewRef.current);
    if (!live.port.isChannelReady()) return;
    const current = currentState();
    const handFinished = current.settlementOutcome !== null || current.outcome !== void 0 && calpokerResponderFinishesAtReveal(current.iStarted);
    if (handFinished) return;
    const currentMove = current.moveNumber;
    if (currentMove === 0n) {
      commitLocalAction((current2) => ({ ...current2, moveNumber: 1n, isPlayerTurn: false }), {
        type: "make-move",
        readable: null
      });
    } else if (currentMove === 1n) {
      if ((current.cardSelections ?? []).length !== 4) return;
      if (current.isPlayerTurn) {
        submitMove1();
      } else {
        pendingPlayRef.current = true;
      }
    } else if (currentMove === 2n) {
      commitLocalAction((current2) => ({ ...current2, moveNumber: 3n, isPlayerTurn: false }), {
        type: "make-move",
        readable: null
      });
    }
  }, [commitLocalAction, currentState, submitMove1]);
  (0, import_react.useEffect)(() => {
    if (!interactive) return;
    const handFinished = handState.settlementOutcome !== null || handState.outcome !== void 0 && calpokerResponderFinishesAtReveal(handState.iStarted);
    if (handFinished || !handState.isPlayerTurn) return;
    const live = requireLiveGameMount(viewRef.current);
    if (!live.port.isChannelReady()) return;
    const m = handState.moveNumber;
    const submissionKey = `0:${m}`;
    if (autoSubmissionRef.current === submissionKey) return;
    if (shouldAutoFireCalpokerMove(handFinished, handState.isPlayerTurn, m)) {
      autoSubmissionRef.current = submissionKey;
      handleMakeMove();
    } else if (m === 1n && pendingPlayRef.current) {
      autoSubmissionRef.current = submissionKey;
      submitMove1();
    }
  }, [
    view,
    handState.isPlayerTurn,
    handState.moveNumber,
    handState.outcome,
    interactive,
    handleMakeMove,
    submitMove1,
    handState.iStarted,
    handState.settlementOutcome
  ]);
  const setCardSelections = (0, import_react.useCallback)(
    (selectionsOrFn) => {
      if (typeof selectionsOrFn === "function") {
        commitState((current) => ({
          ...current,
          cardSelections: selectionsOrFn(current.cardSelections ?? [])
        }));
      } else {
        commitState((current) => ({ ...current, cardSelections: selectionsOrFn }));
      }
    },
    [commitState]
  );
  const setHandOrder = (0, import_react.useCallback)(
    (nextPlayerHand, nextOpponentHand) => {
      commitState((current) => ({
        ...current,
        playerHand: nextPlayerHand,
        opponentHand: nextOpponentHand ?? current.opponentHand,
        cardSelections: (current.cardSelections ?? []).filter(
          (card) => nextPlayerHand.includes(card)
        )
      }));
    },
    [commitState]
  );
  const saveDisplaySnapshot = (0, import_react.useCallback)(
    (snapshot) => {
      requireLiveGameMount(viewRef.current);
      commitState((current) => ({ ...current, displaySnapshot: snapshot }));
    },
    [commitState]
  );
  return {
    playerHand: handState.playerHand,
    opponentHand: handState.opponentHand,
    cardSelections: handState.cardSelections ?? [],
    setCardSelections,
    setHandOrder,
    moveNumber: handState.moveNumber,
    outcome: suppressInitialOutcomeRef.current ? void 0 : handState.outcome,
    terminalOutcome: handState.settlementOutcome,
    handleMakeMove,
    saveDisplaySnapshot,
    initialDisplaySnapshot: calpokerRestoredDisplaySnapshot(
      handState.displaySnapshot,
      handState.outcome
    )
  };
}

export {
  cardIdToRankSuit,
  formatCardsForLog,
  formatOrderedCardsForLog,
  orderUsedCardsForLog,
  projectCalpokerFinalDisplay,
  CalpokerOutcome,
  shouldRestoreCalpokerSelection,
  useCalpokerHand
};
