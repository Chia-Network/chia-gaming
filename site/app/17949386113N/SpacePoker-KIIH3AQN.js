import {
  formatSpacepokerAmount,
  formatSpacepokerXch
} from "./chunk-RA4YWXGF.js";
import {
  __toESM,
  requireLiveGameMount,
  require_jsx_runtime,
  require_react,
  require_src
} from "./chunk-ZODP5B7L.js";

// ../games/spacepoker/ui/SpacePoker.tsx
var import_react3 = __toESM(require_react());

// ../games/spacepoker/ui/handPresentation.ts
var RANK_LABELS = {
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "T",
  11: "J",
  12: "Q",
  13: "K",
  14: "A"
};
var FULL_RANKS = {
  2: "Two",
  3: "Three",
  4: "Four",
  5: "Five",
  6: "Six",
  7: "Seven",
  8: "Eight",
  9: "Nine",
  10: "Ten",
  11: "Jack",
  12: "Queen",
  13: "King",
  14: "Ace"
};
function spacePokerRankLabel(rank) {
  return RANK_LABELS[Number(rank)] ?? String(rank);
}
function fullRank(rank) {
  return FULL_RANKS[Number(rank)] ?? String(rank);
}
function kickerSuffix(kickers) {
  if (kickers.length === 0) return "";
  if (kickers.length === 1) return `. ${fullRank(kickers[0])} kicker`;
  return `. ${kickers.map(fullRank).join(", ")} kickers`;
}
function describeSpacePokerHand(eval_) {
  if (!eval_ || eval_.length === 0) return "";
  const c0 = eval_[0];
  if (c0 === 5n) {
    const b = eval_[1], r = eval_[2];
    return b ? `Five of a Kind, Boosted, ${fullRank(r)}s` : `Five of a Kind, ${fullRank(r)}s`;
  }
  if (c0 === 4n && eval_[1] === 1n) {
    const b = eval_[2], r = eval_[3];
    return (b ? `Four of a Kind, Boosted, ${fullRank(r)}s` : `Four of a Kind, ${fullRank(r)}s`) + kickerSuffix([eval_[4]]);
  }
  if (c0 === 3n && eval_[1] === 3n) {
    const b = eval_[2], r = eval_[3];
    return b ? `Straight, Boosted, ${fullRank(r)} high` : `Straight, ${fullRank(r)} high`;
  }
  if (c0 === 3n && eval_[1] === 2n) {
    const b = eval_[2], s = eval_[3], p = eval_[4];
    return b ? `Full House, Boosted, ${fullRank(s)}s full of ${fullRank(p)}s` : `Full House, ${fullRank(s)}s full of ${fullRank(p)}s`;
  }
  if (c0 === 3n && eval_[1] === 1n && eval_[2] === 1n) {
    const b = eval_[3], r = eval_[4];
    return (b ? `Three of a Kind, Boosted, ${fullRank(r)}s` : `Three of a Kind, ${fullRank(r)}s`) + kickerSuffix(eval_.slice(5));
  }
  if (c0 === 2n && eval_[1] === 2n && eval_[2] === 1n) {
    const b = eval_[3], hp = eval_[4], lp = eval_[5];
    return (b ? `Two Pair, Boosted, ${fullRank(hp)}s and ${fullRank(lp)}s` : `Two Pair, ${fullRank(hp)}s and ${fullRank(lp)}s`) + kickerSuffix([eval_[6]]);
  }
  if (c0 === 2n && eval_[1] === 1n && eval_[2] === 1n && eval_[3] === 1n) {
    const b = eval_[4], r = eval_[5];
    return (b ? `Pair, Boosted, ${fullRank(r)}s` : `Pair of ${fullRank(r)}s`) + kickerSuffix(eval_.slice(6));
  }
  if (c0 === 1n && eval_[1] === 1n && eval_[2] === 1n && eval_[3] === 1n && eval_[4] === 1n) {
    const b = eval_[5], r = eval_[6];
    return (b ? `Boosted, ${fullRank(r)} high` : `${fullRank(r)} high`) + kickerSuffix(eval_.slice(7));
  }
  return eval_.join(" ");
}
function logHoleCards(cards, boost) {
  return `${spacePokerRankLabel(cards[0])}${spacePokerRankLabel(cards[1])}${boost ? "+" : "-"}`;
}
function logBestHand(cards, boost) {
  return cards.map((card) => spacePokerRankLabel(card)).join("") + (boost ? "+" : "-");
}
function formatSpacepokerHandLog(playerHoleCards, playerBoost, opponentHoleCards, opponentBoost, communityCards, handHistory, outcome, terminalState, coinTossIOpen, betUnit, stackSize, formatAmount = formatSpacepokerAmount) {
  const weOpenFirst = coinTossIOpen === true;
  const posLabel = weOpenFirst ? "1st" : "2nd";
  const items = [];
  let ourTotal = 1n;
  let theirTotal = 1n;
  let nextRevealIdx = 0;
  for (const entry of handHistory) {
    const isUs = entry.player === "you";
    if (entry.action === "fold" || entry.action === "failed") {
      items.push("\u274C");
      continue;
    }
    if (entry.action === "concede") {
      items.push("\u{1F3F3}\uFE0F");
      continue;
    }
    if (entry.action === "reveal") {
      if (!isUs && opponentHoleCards) {
        items.push("\u{1F440}" + logHoleCards(opponentHoleCards, opponentBoost ?? false));
      }
      continue;
    }
    if (entry.action === "raise") {
      const units = entry.units ?? 0n;
      if (isUs) {
        ourTotal += units;
      } else {
        theirTotal += units;
      }
      if (isUs && ourTotal >= stackSize || !isUs && theirTotal >= stackSize) {
        items.push("all");
      } else {
        items.push(String(units));
      }
    } else {
      if (entry.action === "call") {
        const gap = isUs ? theirTotal - ourTotal : ourTotal - theirTotal;
        if (gap > 0n) {
          if (isUs) ourTotal += gap;
          else theirTotal += gap;
        }
      }
      items.push("\u2705");
    }
    if (entry.endsStreet || entry.action === "call") {
      if (nextRevealIdx === 0) {
        const flop = communityCards.slice(0, 3).filter((card) => card != null);
        if (flop.length > 0) {
          items.push("\u270B" + flop.map((card) => spacePokerRankLabel(card)).join(""));
          nextRevealIdx = 1;
        }
      } else if (nextRevealIdx === 1) {
        const turn = communityCards[3];
        if (turn != null) {
          items.push("\u270B" + spacePokerRankLabel(turn));
          nextRevealIdx = 2;
        }
      } else if (nextRevealIdx === 2) {
        const river = communityCards[4];
        if (river != null) {
          items.push("\u270B" + spacePokerRankLabel(river));
          nextRevealIdx = 3;
        }
      }
    }
  }
  const lastItem = items[items.length - 1];
  const oppRevealed = terminalState === "revealed" && opponentHoleCards;
  if (oppRevealed) {
    const oppStr = "\u{1F440}" + logHoleCards(opponentHoleCards, opponentBoost ?? false);
    if (lastItem !== oppStr && lastItem !== "\u{1F3F3}\uFE0F" && lastItem !== "\u274C") {
      items.push(oppStr);
    }
  }
  let actionLine = `${logHoleCards(playerHoleCards, playerBoost)} ${posLabel}`;
  for (let i = 0; i < items.length; i++) {
    if (i === 0) {
      actionLine += "  ";
    } else {
      const gapIdx = i - 1;
      const isDouble = weOpenFirst ? gapIdx % 2 !== 0 : gapIdx % 2 === 0;
      actionLine += isDouble ? "  " : " ";
    }
    actionLine += items[i];
  }
  let resultLine = "";
  if (terminalState === "folded-by-you") {
    const lost = ourTotal;
    resultLine = `Lose ${lost} (${formatAmount(lost * betUnit)})`;
  } else if (terminalState === "folded-by-opponent" || terminalState === "won-by-opponent-failure") {
    const won = theirTotal;
    resultLine = `Win ${won} (${formatAmount(won * betUnit)})`;
  } else if (terminalState === "conceded-by-opponent") {
    const won = theirTotal;
    resultLine = `Win ${won} (${formatAmount(won * betUnit)})`;
    if (outcome?.playerHandCards && outcome.playerHandCards.length > 0) {
      resultLine += ` with ${logBestHand(outcome.playerHandCards, playerBoost)}`;
    }
  } else if (terminalState === "conceded-by-you") {
    const lost = ourTotal;
    resultLine = `Lose ${lost} (${formatAmount(lost * betUnit)})`;
  } else if (terminalState === "revealed" && outcome) {
    if (outcome.result > 0n) {
      const won = theirTotal;
      resultLine = `Win ${won} (${formatAmount(won * betUnit)})`;
    } else if (outcome.result < 0n) {
      const lost = ourTotal;
      resultLine = `Lose ${lost} (${formatAmount(lost * betUnit)})`;
    } else {
      resultLine = "Split";
    }
    if (outcome.playerHandCards && outcome.playerHandCards.length > 0) {
      resultLine += ` with ${logBestHand(outcome.playerHandCards, playerBoost)}`;
    }
    if (outcome.opponentHandCards && outcome.opponentHandCards.length > 0) {
      resultLine += ` vs ${logBestHand(outcome.opponentHandCards, opponentBoost ?? false)}`;
    }
  }
  return [actionLine, resultLine];
}

// ../games/spacepoker/ui/SpacePokerActionControls.tsx
var import_react2 = __toESM(require_react());

// ../games/spacepoker/ui/useSpacepokerHand.ts
var import_react = __toESM(require_react());
var import_clvm_lib = __toESM(require_src());
var SpHandler = {
  CommitA: 0n,
  CommitB: 1n,
  BeginRound: 2n,
  MidRound: 3n,
  End: 4n,
  Showdown: 5n,
  Folded: 6n
};
function isTerminalSpacepokerHandler(handler) {
  return handler === SpHandler.Showdown || handler === SpHandler.Folded;
}
function useSpacepokerHand(view) {
  const state = view.hand.getState();
  const betSize = state.perPlayerStake * 2n;
  const interactive = !view.frozen;
  const betUnit = state.unitSizeMojos;
  const stackSize = betSize / 2n / betUnit;
  const pot = 2n * state.halfPot + state.lastRaise;
  const playerStack = stackSize - state.halfPot - (state.iRaisedLast ? state.lastRaise : 0n);
  const opponentStack = stackSize - state.halfPot - (state.iRaisedLast ? 0n : state.lastRaise);
  const viewRef = (0, import_react.useRef)(view);
  viewRef.current = view;
  const [terminalDisplayMode, setTerminalDisplayMode] = (0, import_react.useState)(
    null
  );
  const displayMode = interactive ? state.displayMode : terminalDisplayMode ?? state.displayMode;
  const commitLocalAction = (0, import_react.useCallback)(
    (update, command) => {
      const live = requireLiveGameMount(viewRef.current);
      const rejected = live.port.dispatch(
        command.type === "make-move" ? { type: "make-move", memberIndex: 0, readable: command.readable } : command.type === "accept-settlement" ? { type: "accept-settlement", memberIndex: 0 } : { type: "cheat", memberIndex: 0, moverShare: command.moverShare }
      );
      if (rejected) return;
      live.hand.update(update);
      live.port.dispatch({ type: "state-changed" });
    },
    []
  );
  const setDisplayMode = (0, import_react.useCallback)(
    (mode) => {
      if (viewRef.current.frozen) {
        setTerminalDisplayMode(mode);
        return;
      }
      const live = requireLiveGameMount(viewRef.current);
      live.hand.update((current) => ({ ...current, displayMode: mode }));
      live.port.dispatch({ type: "state-changed" });
    },
    []
  );
  const autoFiredSnapshotRef = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    if (!interactive || state.settlementOutcome !== null) return;
    if (state.terminalState !== "none" || isTerminalSpacepokerHandler(state.gameState.handler))
      return;
    const { handler, myTurn, N } = state.gameState;
    if (!myTurn || !requireLiveGameMount(viewRef.current).port.isChannelReady()) return;
    const submitOnce = (update, command) => {
      if (autoFiredSnapshotRef.current === state) return;
      autoFiredSnapshotRef.current = state;
      commitLocalAction(update, command);
    };
    if (handler === SpHandler.CommitA || handler === SpHandler.CommitB) {
      submitOnce(
        (current) => ({ ...current, gameState: { ...current.gameState, myTurn: false } }),
        {
          type: "make-move",
          readable: null
        }
      );
      return;
    }
    if (handler === SpHandler.BeginRound && N === 4n && state.coinTossIOpen === false) {
      submitOnce(
        (current) => ({ ...current, gameState: { ...current.gameState, myTurn: false } }),
        {
          type: "make-move",
          readable: null
        }
      );
      return;
    }
    if ((handler === SpHandler.BeginRound || handler === SpHandler.MidRound) && state.lastRaise === 0n && playerStack <= 0n) {
      if (handler === SpHandler.BeginRound) {
        submitOnce(
          (current) => ({
            ...current,
            gameState: { handler: SpHandler.MidRound, myTurn: false, N },
            handHistory: [...current.handHistory, { player: "you", action: "check" }]
          }),
          { type: "make-move", readable: import_clvm_lib.Program.fromBigInt(0n) }
        );
      } else {
        submitOnce(
          (current) => ({
            ...current,
            gameState: N === 1n ? { handler: SpHandler.End, myTurn: false, N: 1n } : { handler: SpHandler.BeginRound, myTurn: false, N: N - 1n },
            halfPot: current.halfPot + current.lastRaise,
            lastRaise: 0n,
            handHistory: [
              ...current.handHistory,
              { player: "you", action: "check", endsStreet: true }
            ]
          }),
          { type: "make-move", readable: null }
        );
      }
      return;
    }
    if (handler === SpHandler.End && state.outcome) {
      if (state.outcome.result >= 0n) {
        submitOnce(
          (current) => ({
            ...current,
            gameState: { handler: SpHandler.Showdown, myTurn: false, N },
            handHistory: [...current.handHistory, { player: "you", action: "reveal" }],
            terminalState: "revealed"
          }),
          { type: "make-move", readable: null }
        );
      } else {
        submitOnce(
          (current) => ({
            ...current,
            gameState: { handler: SpHandler.Showdown, myTurn: false, N },
            handHistory: [...current.handHistory, { player: "you", action: "concede" }],
            terminalState: "conceded-by-you"
          }),
          { type: "accept-settlement" }
        );
      }
    }
  }, [commitLocalAction, interactive, playerStack, state]);
  const handleCheck = (0, import_react.useCallback)(() => {
    commitLocalAction(
      (current) => ({
        ...current,
        gameState: { handler: SpHandler.MidRound, myTurn: false, N: current.gameState.N },
        handHistory: [...current.handHistory, { player: "you", action: "check" }]
      }),
      { type: "make-move", readable: import_clvm_lib.Program.fromBigInt(0n) }
    );
  }, [commitLocalAction]);
  const handleRaise = (0, import_react.useCallback)(
    (units) => {
      commitLocalAction(
        (current) => ({
          ...current,
          gameState: { handler: SpHandler.MidRound, myTurn: false, N: current.gameState.N },
          halfPot: current.halfPot + current.lastRaise,
          lastRaise: units,
          iRaisedLast: true,
          handHistory: [...current.handHistory, { player: "you", action: "raise", units }]
        }),
        { type: "make-move", readable: import_clvm_lib.Program.fromBigInt(units * betUnit) }
      );
    },
    [betUnit, commitLocalAction]
  );
  const handleCall = (0, import_react.useCallback)(() => {
    commitLocalAction(
      (current) => {
        const action = current.lastRaise > 0n ? "call" : "check";
        return {
          ...current,
          gameState: current.gameState.N === 1n ? { handler: SpHandler.End, myTurn: false, N: 1n } : { handler: SpHandler.BeginRound, myTurn: false, N: current.gameState.N - 1n },
          halfPot: current.halfPot + current.lastRaise,
          lastRaise: 0n,
          handHistory: [
            ...current.handHistory,
            { player: "you", action, ...action === "check" ? { endsStreet: true } : {} }
          ],
          outcome: current.gameState.N === 1n ? null : current.outcome
        };
      },
      { type: "make-move", readable: null }
    );
  }, [commitLocalAction]);
  const handleFold = (0, import_react.useCallback)(() => {
    commitLocalAction(
      (current) => ({
        ...current,
        gameState: { handler: SpHandler.Folded, myTurn: false, N: current.gameState.N },
        handHistory: [...current.handHistory, { player: "you", action: "fold" }],
        terminalState: "folded-by-you"
      }),
      { type: "accept-settlement" }
    );
  }, [commitLocalAction]);
  const handleCheat = (0, import_react.useCallback)(() => {
    commitLocalAction(
      (current) => ({ ...current, gameState: { ...current.gameState, myTurn: false } }),
      { type: "cheat", moverShare: 0n }
    );
  }, [commitLocalAction]);
  const formatBet = (0, import_react.useCallback)(
    (units) => {
      if (displayMode === "units") return String(units);
      const mojos = units * betUnit;
      if (displayMode === "mojos") return `${mojos.toLocaleString()} mojos`;
      return formatSpacepokerXch(mojos);
    },
    [betUnit, displayMode]
  );
  return {
    gameState: state.gameState,
    playerHoleCards: state.playerHoleCards,
    playerBoost: state.playerBoost,
    opponentHoleCards: state.opponentHoleCards,
    opponentBoost: state.opponentBoost,
    communityCards: state.communityCards,
    pot,
    playerStack,
    opponentStack,
    betUnit,
    handHistory: state.handHistory,
    outcome: state.outcome,
    terminalOutcome: state.settlementOutcome,
    terminalState: state.terminalState,
    lastRaise: state.lastRaise,
    coinTossIOpen: state.coinTossIOpen,
    unitSizeMojos: betUnit,
    displayMode,
    setDisplayMode,
    formatBet,
    handleCheck,
    handleRaise,
    handleCall,
    handleFold,
    handleCheat
  };
}

// ../games/spacepoker/ui/SpacePokerActionControls.tsx
var import_jsx_runtime = __toESM(require_jsx_runtime());
function SpacePokerActionControls({
  interactive,
  handler,
  myTurn,
  round,
  coinTossIOpen,
  lastRaiseUnits,
  maxRaiseUnits,
  forcedAuto,
  formatBet,
  handleCheck,
  handleRaise,
  handleCall,
  handleFold
}) {
  const [raiseAmount, setRaiseAmount] = (0, import_react2.useState)(1);
  const inBetting = handler === SpHandler.BeginRound || handler === SpHandler.MidRound;
  const maxRaiseInput = Math.max(1, Number(maxRaiseUnits));
  const raiseAmountInput = Math.min(raiseAmount, maxRaiseInput);
  const isBeginRound = handler === SpHandler.BeginRound;
  const autoPong = isBeginRound && round === "4" && coinTossIOpen === false;
  const actionsEnabled = interactive && myTurn && inBetting && !autoPong && !forcedAuto;
  const checkCallLabel = handler === SpHandler.MidRound && lastRaiseUnits !== "0" ? "Call" : "Check";
  const canFold = handler === SpHandler.MidRound && lastRaiseUnits !== "0";
  (0, import_react2.useEffect)(() => {
    if (!actionsEnabled) {
      setRaiseAmount(1);
    }
  }, [actionsEnabled]);
  const doRaise = (0, import_react2.useCallback)(() => {
    if (!actionsEnabled || raiseAmountInput < 1 || raiseAmountInput > Number(maxRaiseUnits)) return;
    handleRaise(BigInt(raiseAmountInput));
  }, [actionsEnabled, raiseAmountInput, maxRaiseUnits, handleRaise]);
  const btnClass = "px-3 py-1.5 rounded bg-primary-solid text-primary-on-primary text-sm font-medium hover:bg-primary-solid-hover disabled:opacity-40";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-wrap items-center justify-center gap-2", children: [
    isBeginRound ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: handleCheck, disabled: !actionsEnabled, className: `${btnClass} w-16`, children: "Check" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: handleCall, disabled: !actionsEnabled, className: `${btnClass} w-16`, children: checkCallLabel }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex items-center gap-1", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          onClick: doRaise,
          disabled: !actionsEnabled || Number(maxRaiseUnits) < 1,
          className: btnClass,
          children: "Raise"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          type: "range",
          min: 1,
          max: maxRaiseInput,
          value: raiseAmountInput,
          onChange: (event) => setRaiseAmount(Number(event.target.value)),
          disabled: !actionsEnabled,
          className: "w-20 sm:w-32 disabled:opacity-40"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "text-xs text-canvas-text-contrast w-16 text-center", children: formatBet(BigInt(raiseAmountInput)) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { onClick: handleFold, disabled: !actionsEnabled || !canFold, className: btnClass, children: "Fold" })
  ] });
}

// ../games/spacepoker/ui/SpacePokerTable.tsx
var import_jsx_runtime2 = __toESM(require_jsx_runtime());
var SEL_BAR = "w-full h-1 rounded-full";
var SEL_VIS = `${SEL_BAR} bg-canvas-text-contrast`;
var SEL_HIDDEN = `${SEL_BAR} bg-transparent`;
function SpacePokerCard({
  rankLabelText,
  faceDown
}) {
  const base = "inline-flex items-center justify-center rounded border font-bold select-none";
  const size = "w-10 h-14 sm:w-12 sm:h-16";
  if (faceDown) {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "div",
      {
        className: `${base} ${size} bg-canvas-solid border-canvas-line text-canvas-bg text-4xl leading-none`,
        children: "?"
      }
    );
  }
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    "div",
    {
      className: `${base} ${size} bg-canvas-bg border-2 border-canvas-text-contrast text-canvas-text-contrast`,
      children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "svg",
        {
          "aria-label": rankLabelText ?? "",
          className: "h-[90%] w-[90%] overflow-visible",
          role: "img",
          viewBox: "0 0 100 100",
          children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "text",
            {
              className: "fill-current",
              dominantBaseline: "central",
              fontSize: "108",
              fontWeight: "700",
              style: {
                fontFamily: 'Cheltenham, "ITC Cheltenham", "Cheltenham Std", "Times New Roman", Times, serif'
              },
              textAnchor: "middle",
              x: "50",
              y: "50",
              children: rankLabelText ?? ""
            }
          )
        }
      )
    }
  );
}
function CardSlot() {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "inline-flex items-center justify-center rounded border border-dashed border-canvas-line w-10 h-14 sm:w-12 sm:h-16 text-canvas-text opacity-30" });
}
function CardColumn({
  topSel,
  bottomSel,
  children
}) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "flex flex-col items-center gap-0.5", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: topSel ? SEL_VIS : SEL_HIDDEN }),
    children,
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: bottomSel ? SEL_VIS : SEL_HIDDEN })
  ] });
}
function HoleCardsGroup({
  boosted,
  banner,
  children
}) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "relative inline-flex items-center", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "flex gap-2 items-center", children }),
    boosted && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "absolute left-full top-1/2 -translate-y-1/2 ml-1 text-2xl font-bold text-canvas-text-contrast leading-none", children: "+" }),
    banner && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "span",
      {
        className: `absolute left-full top-1/2 -translate-y-1/2 ${boosted ? "ml-6" : "ml-2"} whitespace-nowrap rounded-full px-4 py-2 text-base font-bold shadow-lg ${banner === "win" ? "bg-primary-solid text-primary-on-primary" : "bg-canvas-solid text-canvas-on-canvas"}`,
        children: banner === "win" ? "Winner!" : banner === "tie" ? "Tie" : banner === "concede" ? "Concede" : "Fold"
      }
    )
  ] });
}
function AmountBadge({ children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "font-bold text-lg text-canvas-text-contrast tabular-nums", children });
}
function entrySymbol(entry, formatBet) {
  if (entry.action === "check") return entry.endsStreet ? "\u270B" : "\u2705";
  if (entry.action === "call") return "\u270B";
  if (entry.action === "fold" || entry.action === "failed") return "\u274C";
  if (entry.action === "concede") return "\u{1F3F3}\uFE0F";
  if (entry.action === "reveal") return "\u{1F440}";
  return formatBet(entry.units ?? 0n);
}
function buildHistoryRows(history, formatBet) {
  if (history.length === 0) return [];
  const rows = [];
  let index = 0;
  if (history[0].player === "opponent") {
    rows.push([null, entrySymbol(history[0], formatBet)]);
    index = 1;
  }
  for (; index < history.length; index += 2) {
    rows.push([
      entrySymbol(history[index], formatBet),
      history[index + 1] ? entrySymbol(history[index + 1], formatBet) : null
    ]);
  }
  return rows;
}
function SpacePokerHandHistory({
  history,
  formatBet
}) {
  const rows = buildHistoryRows(history, formatBet);
  if (rows.length === 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("table", { className: "text-base mx-auto table-auto", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("tbody", { children: rows.map(([left, right], index) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("tr", { className: index > 0 ? "border-t border-canvas-line" : "", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "px-3 py-1 text-canvas-text-contrast text-center min-w-12 whitespace-nowrap tabular-nums", children: left ?? "" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("td", { className: "px-3 py-1 text-canvas-text-contrast text-center min-w-12 whitespace-nowrap tabular-nums", children: right ?? "" })
  ] }, index)) }) });
}
function SpacePokerTable({
  opponentName,
  playerName,
  opponentIndicator,
  playerIndicator,
  opponentStack,
  playerStack,
  pot,
  opponentHoleCards,
  playerHoleCards,
  opponentBoost,
  playerBoost,
  communityCards,
  opponentHandDescription,
  playerHandDescription,
  opponentBanner,
  playerBanner,
  outcome,
  showPrivateShowdown,
  formatBet
}) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(AmountBadge, { children: [
      opponentName,
      opponentIndicator
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "relative flex justify-center w-full", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "absolute left-0 top-1/2 -translate-y-1/2", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(AmountBadge, { children: formatBet(opponentStack) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        HoleCardsGroup,
        {
          boosted: opponentHoleCards ? opponentBoost ?? false : false,
          banner: opponentBanner,
          children: opponentHoleCards ? opponentHoleCards.map((card, index) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            CardColumn,
            {
              topSel: showPrivateShowdown && outcome?.opponentHandCards?.includes(card),
              children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SpacePokerCard, { rankLabelText: spacePokerRankLabel(card) })
            },
            index
          )) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CardColumn, { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SpacePokerCard, { faceDown: true }) }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CardColumn, { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SpacePokerCard, { faceDown: true }) })
          ] })
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "text-xs text-canvas-text-contrast text-center min-h-4", children: opponentHandDescription }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "relative flex justify-center w-full", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "absolute left-0 top-1/2 -translate-y-1/2", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(AmountBadge, { children: formatBet(pot) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "flex gap-1.5 items-center", children: Array.from({ length: 5 }).map((_, index) => {
        const card = communityCards[index];
        if (card != null) {
          return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            CardColumn,
            {
              topSel: showPrivateShowdown && outcome?.opponentHandCards?.includes(card),
              bottomSel: showPrivateShowdown && outcome?.playerHandCards?.includes(card),
              children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SpacePokerCard, { rankLabelText: spacePokerRankLabel(card) })
            },
            index
          );
        }
        return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CardColumn, { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CardSlot, {}) }, index);
      }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "text-xs text-canvas-text-contrast text-center min-h-4", children: playerHandDescription }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "relative flex justify-center w-full", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "absolute left-0 top-1/2 -translate-y-1/2", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(AmountBadge, { children: formatBet(playerStack) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(HoleCardsGroup, { boosted: playerHoleCards ? playerBoost : false, banner: playerBanner, children: playerHoleCards ? playerHoleCards.map((card, index) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        CardColumn,
        {
          bottomSel: showPrivateShowdown && outcome?.playerHandCards?.includes(card),
          children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SpacePokerCard, { rankLabelText: spacePokerRankLabel(card) })
        },
        index
      )) : /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CardColumn, { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CardSlot, {}) }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CardColumn, { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(CardSlot, {}) })
      ] }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(AmountBadge, { children: [
      playerName,
      playerIndicator
    ] })
  ] });
}

// ../games/spacepoker/ui/statusPresentation.ts
var SETTLEMENT_LABELS = {
  accept_settlement: "Accepted",
  settled_cleanly: "Settled cleanly",
  opponent_timed_out: "Opponent timed out",
  forfeited_skipped_reveal: "Opponent won",
  lost: "Lost",
  forfeited_we_accepted: "Opponent won",
  we_accepted: "Accepted",
  attempt_to_move_failed: "Attempt to move failed",
  timed_out_waiting_for_our_move: "Timed out waiting for our move",
  slashed_opponent: "Slashed opponent",
  opponent_slashed_us: "Opponent slashed us",
  opponent_cheated: "Opponent cheated"
};
function spacePokerTerminalBanners(terminalState, showdownResult) {
  if (terminalState === "conceded-by-you") return { player: null, opponent: "win" };
  if (terminalState === "conceded-by-opponent") return { player: "win", opponent: null };
  if (terminalState === "folded-by-you") return { player: "fold", opponent: null };
  if (terminalState === "folded-by-opponent") return { player: null, opponent: "fold" };
  if (terminalState === "won-by-opponent-failure") return { player: "win", opponent: null };
  if (showdownResult === null) return { player: null, opponent: null };
  if (showdownResult > 0n) return { player: "win", opponent: null };
  if (showdownResult < 0n) return { player: null, opponent: "win" };
  return { player: "tie", opponent: "tie" };
}
function spacePokerTerminalIndicators(terminalState, showdownResult) {
  if (terminalState === "conceded-by-opponent") {
    return { player: " \u2705", opponent: " \u{1F3F3}\uFE0F" };
  }
  if (terminalState === "conceded-by-you") {
    return { player: " \u{1F3F3}\uFE0F", opponent: " \u2705" };
  }
  if (terminalState === "folded-by-you") {
    return { player: " \u274C", opponent: " \u2705" };
  }
  if (terminalState === "folded-by-opponent" || terminalState === "won-by-opponent-failure") {
    return { player: " \u2705", opponent: " \u274C" };
  }
  if (showdownResult === null) return { player: "", opponent: "" };
  return {
    player: showdownResult > 0n ? " \u2705" : showdownResult < 0n ? " \u274C" : "",
    opponent: showdownResult < 0n ? " \u2705" : showdownResult > 0n ? " \u274C" : ""
  };
}
function spacePokerFooterStatus(handler, turnLine) {
  return isTerminalSpacepokerHandler(handler) ? "" : turnLine;
}
function spacePokerTransitionCommentary(handler, myTurn) {
  if (handler === SpHandler.CommitA || handler === SpHandler.CommitB) return "Dealing cards\u2026";
  if (handler === SpHandler.End) {
    return myTurn ? "Finishing hand\u2026" : "Waiting for opponent to finish\u2026";
  }
  return "";
}
function spacePokerTurnLine(handler, myTurn, round, coinTossIOpen, lastRaise, formatBet) {
  const inBetting = handler === SpHandler.BeginRound || handler === SpHandler.MidRound;
  if (myTurn && inBetting && !(handler === SpHandler.BeginRound && round === 4n && coinTossIOpen === false)) {
    return handler === SpHandler.MidRound && lastRaise > 0n ? `Your turn, ${formatBet(lastRaise)} to call` : "Your turn";
  }
  if (myTurn && handler === SpHandler.BeginRound && round === 4n && coinTossIOpen === false) {
    return "Coin toss: opponent opens\u2026";
  }
  if (!myTurn && inBetting) return "Waiting for opponent\u2026";
  return spacePokerTransitionCommentary(handler, myTurn);
}
function spacePokerTerminalCommentary(terminalState, showdownResult, terminalOutcome, opponentLabel = "The opponent", potLabel) {
  const opponentWonAfterFold = `You folded. ${opponentLabel} won${potLabel ? ` ${potLabel}` : " the hand"}.`;
  if (terminalOutcome === "forfeited_skipped_reveal" || terminalOutcome === "forfeited_we_accepted") {
    return opponentWonAfterFold;
  }
  if (terminalState === "conceded-by-opponent") {
    return "You revealed first and the opponent conceded.";
  }
  if (terminalState === "conceded-by-you") {
    return "The opponent revealed first and you conceded.";
  }
  if (terminalState === "folded-by-opponent") return "The opponent folded. You won the hand.";
  if (terminalState === "folded-by-you") return opponentWonAfterFold;
  if (terminalState === "won-by-opponent-failure") {
    return "The opponent's final action failed. You won the hand.";
  }
  if (terminalState === "revealed" && showdownResult !== null) {
    if (showdownResult > 0n) return "You won at showdown.";
    if (showdownResult < 0n) return "The opponent won at showdown.";
    return "The showdown ended in a tie.";
  }
  if (terminalOutcome !== null) return `${SETTLEMENT_LABELS[terminalOutcome]}.`;
  if (terminalState !== "none") return "The hand ended.";
  return "";
}

// ../games/spacepoker/ui/SpacePoker.tsx
var import_jsx_runtime3 = __toESM(require_jsx_runtime());
function advanceSpacepokerCheatSequence(current, key) {
  const sequence = "cheat^";
  const next = current + key;
  if (next === sequence) return { buffer: "", triggered: true };
  if (sequence.startsWith(next)) return { buffer: next, triggered: false };
  return { buffer: sequence.startsWith(key) ? key : "", triggered: false };
}
function useSpacepokerCheatKeys(handleCheat, enabled) {
  const buffer = (0, import_react3.useRef)("");
  (0, import_react3.useEffect)(() => {
    if (!enabled) return;
    const onKeyDown = (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
      if (event.key.length !== 1) return;
      const next = advanceSpacepokerCheatSequence(buffer.current, event.key);
      buffer.current = next.buffer;
      if (next.triggered) handleCheat();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, handleCheat]);
}
function SpacePoker({
  view,
  onGameLog
}) {
  const interactive = !view.frozen;
  const state = view.hand.getState();
  const betSizeValue = state.perPlayerStake * 2n;
  const sp = useSpacepokerHand(view);
  const { handler, myTurn, N } = sp.gameState;
  useSpacepokerCheatKeys(sp.handleCheat, interactive);
  const [alreadyTerminalAtMount] = (0, import_react3.useState)(() => {
    const state2 = view.hand.getState();
    return state2.terminalState !== "none";
  });
  const gameLogFiredRef = (0, import_react3.useRef)(alreadyTerminalAtMount);
  (0, import_react3.useEffect)(() => {
    if (sp.terminalState === "none" || gameLogFiredRef.current || !sp.playerHoleCards) return;
    gameLogFiredRef.current = true;
    const stackSize = sp.betUnit > 0n ? betSizeValue / 2n / sp.betUnit : 0n;
    onGameLog?.(
      formatSpacepokerHandLog(
        sp.playerHoleCards,
        sp.playerBoost,
        sp.opponentHoleCards,
        sp.opponentBoost,
        sp.communityCards,
        sp.handHistory,
        sp.outcome,
        sp.terminalState,
        sp.coinTossIOpen,
        sp.betUnit,
        stackSize,
        formatSpacepokerAmount
      )
    );
  }, [
    sp.terminalState,
    sp.playerHoleCards,
    sp.playerBoost,
    sp.opponentHoleCards,
    sp.opponentBoost,
    sp.communityCards,
    sp.handHistory,
    sp.outcome,
    sp.coinTossIOpen,
    sp.betUnit,
    betSizeValue,
    onGameLog
  ]);
  const inBetting = handler === SpHandler.BeginRound || handler === SpHandler.MidRound;
  const maxRaise = sp.playerStack - (sp.lastRaise > 0n ? sp.lastRaise : 0n);
  const forcedAuto = inBetting && sp.lastRaise === 0n && sp.playerStack <= 0n;
  const showdownOutcome = sp.outcome;
  const showPrivateShowdown = sp.terminalState === "revealed" || showdownOutcome !== null;
  const finished = handler === SpHandler.Showdown || handler === SpHandler.Folded;
  const visibleShowdownResult = showdownOutcome && (finished || handler === SpHandler.End) ? showdownOutcome.result : null;
  const opponentHandDescription = showPrivateShowdown && showdownOutcome?.opponentHandEval && showdownOutcome.opponentHandEval.length > 0 ? describeSpacePokerHand(showdownOutcome.opponentHandEval) : "";
  const playerHandDescription = showPrivateShowdown && showdownOutcome?.playerHandEval && showdownOutcome.playerHandEval.length > 0 ? describeSpacePokerHand(showdownOutcome.playerHandEval) : "";
  const banners = spacePokerTerminalBanners(sp.terminalState, visibleShowdownResult);
  const indicators = spacePokerTerminalIndicators(sp.terminalState, visibleShowdownResult);
  const turnLine = spacePokerTurnLine(
    handler,
    myTurn,
    N,
    sp.coinTossIOpen,
    sp.lastRaise,
    sp.formatBet
  );
  const terminalCommentary = spacePokerTerminalCommentary(
    sp.terminalState,
    showdownOutcome?.result ?? null,
    sp.terminalOutcome,
    view.opponentName ?? "Opponent",
    sp.displayMode === "units" ? `${sp.pot} units` : sp.formatBet(sp.pot)
  );
  const footerStatus = terminalCommentary || spacePokerFooterStatus(handler, turnLine) || "Updating hand\u2026";
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "relative flex flex-col items-center gap-1.5 py-0 w-full max-w-lg mx-auto text-canvas-text", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "absolute right-0 top-0 flex items-center gap-1 text-xs text-canvas-text", children: ["xch", "mojos", "units"].map((mode) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
      "button",
      {
        type: "button",
        className: `rounded px-2 py-0.5 ${sp.displayMode === mode ? "bg-canvas-solid text-canvas-bg" : "border border-canvas-line text-canvas-text-contrast"}`,
        onClick: () => sp.setDisplayMode(mode),
        children: mode === "xch" ? "XCH" : mode
      },
      mode
    )) }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
      SpacePokerTable,
      {
        opponentName: view.opponentName ?? "Opponent",
        playerName: view.myName ?? "You",
        opponentIndicator: indicators.opponent,
        playerIndicator: indicators.player,
        opponentStack: sp.opponentStack,
        playerStack: sp.playerStack,
        pot: sp.pot,
        opponentHoleCards: sp.opponentHoleCards,
        playerHoleCards: sp.playerHoleCards,
        opponentBoost: sp.opponentBoost,
        playerBoost: sp.playerBoost,
        communityCards: sp.communityCards,
        opponentHandDescription,
        playerHandDescription,
        opponentBanner: banners.opponent,
        playerBanner: banners.player,
        outcome: showdownOutcome,
        showPrivateShowdown,
        formatBet: sp.formatBet
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "flex min-h-[4.5rem] flex-col justify-center gap-2", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        SpacePokerActionControls,
        {
          interactive,
          handler,
          myTurn,
          round: String(N),
          coinTossIOpen: sp.coinTossIOpen,
          lastRaiseUnits: String(sp.lastRaise),
          maxRaiseUnits: String(maxRaise),
          forcedAuto,
          formatBet: sp.formatBet,
          handleCheck: sp.handleCheck,
          handleRaise: sp.handleRaise,
          handleCall: sp.handleCall,
          handleFold: sp.handleFold
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "text-sm text-canvas-text-contrast font-medium text-center min-h-5", children: footerStatus })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(SpacePokerHandHistory, { history: sp.handHistory, formatBet: sp.formatBet })
  ] });
}
export {
  advanceSpacepokerCheatSequence,
  SpacePoker as default
};
