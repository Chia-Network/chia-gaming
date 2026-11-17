import {
  KrunkHandler,
  formatKrunkAmount,
  krunkGameStateFromHand,
  krunkOutcomeFromPlay
} from "./chunk-2727RITZ.js";
import {
  __toESM,
  requireLiveGameMount,
  require_jsx_runtime,
  require_react,
  require_src
} from "./chunk-ZODP5B7L.js";

// ../games/krunk/ui/Krunk.tsx
var import_react2 = __toESM(require_react());

// ../games/krunk/ui/useKrunkHand.ts
var import_react = __toESM(require_react());
var import_clvm_lib = __toESM(require_src());

// ../games/krunk/ui/settlement.ts
function krunkSettlementStatus(outcome, opponentLabel) {
  switch (outcome) {
    case "accept_settlement":
    case "we_accepted":
    case "settled_cleanly":
      return "Settled.";
    case "opponent_timed_out":
      return `${opponentLabel} timed out.`;
    case "forfeited_skipped_reveal":
    case "forfeited_we_accepted":
      return `${opponentLabel} won.`;
    case "lost":
      return "We lost.";
    case "attempt_to_move_failed":
      return "Attempt to move failed.";
    case "timed_out_waiting_for_our_move":
      return "We timed out.";
    case "slashed_opponent":
      return `Slashed ${opponentLabel}.`;
    case "opponent_slashed_us":
      return `${opponentLabel} slashed us.`;
    case "opponent_cheated":
      return `${opponentLabel} cheated.`;
  }
}

// ../games/krunk/ui/useKrunkHand.ts
var MAX_KRUNK_GUESSES = 5;
function canDraftKrunkGuess(wordCommitted, handler, filledCount) {
  if (!wordCommitted || filledCount >= MAX_KRUNK_GUESSES) return false;
  return handler === KrunkHandler.BobWaiting || handler === KrunkHandler.BobGuess;
}
function canQueueKrunkGuess(wordCommitted, handler, filledCount) {
  return wordCommitted && handler === KrunkHandler.BobWaiting && filledCount < MAX_KRUNK_GUESSES;
}
var PENDING_CLUE = [-1n, -1n, -1n, -1n, -1n];
function krunkGuessesWithQueued(guesses, queuedGuesses) {
  if (queuedGuesses.length === 0) return guesses;
  return [...guesses, ...queuedGuesses.map((word) => ({ word, clue: PENDING_CLUE }))];
}
var KRUNK_PAYOUT_SCHEDULE = [100n, 100n, 20n, 5n, 1n];
function krunkGuesserPayout(state, perPlayerStake) {
  const guessCount = state.guesses.length;
  if (guessCount < 1 || guessCount > KRUNK_PAYOUT_SCHEDULE.length) return null;
  const lastClue = state.guesses[guessCount - 1].clue;
  if (!lastClue.every((value) => value === 2n)) return null;
  return perPlayerStake / 100n * KRUNK_PAYOUT_SCHEDULE[guessCount - 1];
}
function krunkTerminalNotice(state, opponentLabel, perPlayerStake) {
  if (state.handler !== KrunkHandler.Terminal) return null;
  if (state.settlementOutcome != null) {
    if (state.settlementOutcome === "opponent_timed_out" || state.settlementOutcome === "timed_out_waiting_for_our_move") {
      const weTimedOut = state.settlementOutcome === "timed_out_waiting_for_our_move";
      const guesserLabel = state.role === "bob" ? "You" : opponentLabel;
      const guesserTimedOut = state.role === "bob" ? weTimedOut : !weTimedOut;
      return {
        text: `${guesserLabel} got ${guesserTimedOut ? "nothing" : krunkAmountLabel(perPlayerStake)} due to timeout.`,
        kind: "info"
      };
    }
    const clean = state.settlementOutcome === "accept_settlement" || state.settlementOutcome === "we_accepted" || state.settlementOutcome === "settled_cleanly";
    if (state.settlementOutcome === "forfeited_skipped_reveal" || state.settlementOutcome === "forfeited_we_accepted") {
      return {
        text: krunkWinnerMessage(opponentLabel, perPlayerStake),
        kind: "info"
      };
    }
    if (!clean) {
      return { text: krunkSettlementStatus(state.settlementOutcome, opponentLabel), kind: "info" };
    }
    const outcome = state.outcome ?? krunkOutcomeFromPlay(state);
    const winnerAmount = state.moverShare !== null ? state.moverShare : krunkGuesserPayout(state, perPlayerStake) ?? perPlayerStake;
    if (outcome === "win") {
      if (state.role === "alice") {
        return { text: `${opponentLabel} didn't win anything.`, kind: "info" };
      }
      return {
        text: krunkWinMessage(winnerAmount),
        kind: "win"
      };
    }
    if (outcome === "lose") {
      if (state.role === "bob") {
        return { text: "You didn't win anything.", kind: "info" };
      }
      return {
        text: krunkWinnerMessage(opponentLabel, winnerAmount),
        kind: "info"
      };
    }
    return { text: "Result unavailable.", kind: "info" };
  }
  if (state.outcome === "win" && state.moverShare !== null && state.moverShare > 0n) {
    return { text: krunkWinMessage(state.moverShare), kind: "win" };
  }
  if (state.role === "bob") {
    return { text: "Out of guesses.", kind: "info" };
  }
  return {
    text: state.outcome === "win" ? `${opponentLabel} couldn't guess it!` : `${opponentLabel} guessed your word.`,
    kind: "info"
  };
}
function krunkBoardNotice(state, opponentLabel, perPlayerStake) {
  return krunkTerminalNotice(state, opponentLabel, perPlayerStake);
}
function krunkWinMessage(moverShare) {
  return krunkWinnerMessage("You", moverShare);
}
function krunkAmountLabel(mojos) {
  if (mojos < 1000000n) return `${mojos} mojo`;
  const TRILLION = 1000000000000n;
  const whole = mojos / TRILLION;
  const frac = mojos % TRILLION;
  if (frac === 0n) return `${whole} chia`;
  const fracStr = frac.toString().padStart(12, "0").replace(/0+$/, "");
  return `${whole}.${fracStr} chia`;
}
function krunkWinnerMessage(winner, amount) {
  return `${winner} won ${krunkAmountLabel(amount)}!`;
}
var MAX_GUESSES = 5;
function wordToProgram(word) {
  return import_clvm_lib.Program.fromBytes(new TextEncoder().encode(word.toUpperCase()));
}
function finishedKrunkState(current, revealedWord, lastClue, moverShare = null) {
  const correct = (clue) => clue.every((value) => value === 2n);
  const bobGuessedCorrectly = current.guesses.some((guess) => correct(guess.clue)) || lastClue !== null && correct(lastClue);
  const aliceWon = !bobGuessedCorrectly;
  return {
    ...current,
    handler: KrunkHandler.Terminal,
    myTurn: false,
    revealedWord,
    moverShare,
    outcome: current.role === "alice" && aliceWon || current.role === "bob" && !aliceWon ? "win" : "lose"
  };
}
function useKrunkHand(view, memberIndex) {
  const handState = view.hand.getState();
  const perPlayerStake = handState.perPlayerStake;
  const gameState = krunkGameStateFromHand(handState, memberIndex);
  const interactive = !view.frozen && gameState.handler !== KrunkHandler.Terminal;
  const gameStateRef = (0, import_react.useRef)(gameState);
  const viewRef = (0, import_react.useRef)(view);
  const memberIndexRef = (0, import_react.useRef)(memberIndex);
  const activeRef = (0, import_react.useRef)(interactive);
  gameStateRef.current = gameState;
  viewRef.current = view;
  memberIndexRef.current = memberIndex;
  activeRef.current = interactive;
  const [rejection, setRejection] = (0, import_react.useState)(null);
  const commitLocalAction = (0, import_react.useCallback)(
    (next, command) => {
      const memberIndex2 = memberIndexRef.current;
      const live = requireLiveGameMount(viewRef.current);
      const rejected = live.port.dispatch({
        type: "make-move",
        memberIndex: memberIndex2,
        readable: command.readable
      });
      setRejection(
        rejected ? rejected.tag === "not_in_dictionary" ? `${rejected.message} is not in the dictionary.` : rejected.message : null
      );
      if (rejected) {
        if (live.hand.getState().members[memberIndex2].queuedGuesses.length > 0) {
          live.hand.updateGame(memberIndex2, (current) => ({ ...current, queuedGuesses: [] }));
          live.port.dispatch({ type: "state-changed" });
        }
        return false;
      }
      live.hand.updateGame(memberIndex2, () => next);
      live.port.dispatch({ type: "state-changed" });
      return true;
    },
    []
  );
  const commitStateChange = (0, import_react.useCallback)((next) => {
    const memberIndex2 = memberIndexRef.current;
    const live = requireLiveGameMount(viewRef.current);
    live.hand.updateGame(memberIndex2, () => next);
    live.port.dispatch({ type: "state-changed" });
  }, []);
  (0, import_react.useEffect)(() => {
    if (!interactive) return;
    if (!activeRef.current || gameState.role !== "alice" || gameState.handler !== KrunkHandler.AliceClue || !gameState.myTurn)
      return;
    if (!requireLiveGameMount(viewRef.current).port.isChannelReady()) return;
    if (!activeRef.current) return;
    const latest = gameState.guesses[gameState.guesses.length - 1];
    const isReveal = !!latest && (latest.clue.every((v) => v === 2n) || gameState.guesses.length >= MAX_GUESSES);
    const next = isReveal ? finishedKrunkState(
      gameState,
      gameState.secretWord,
      latest.clue,
      krunkGuesserPayout(gameState, perPlayerStake)
    ) : { ...gameState, handler: KrunkHandler.AliceWaiting, myTurn: false };
    commitLocalAction(next, { type: "make-move", readable: null });
  }, [gameState, interactive, perPlayerStake, commitLocalAction]);
  const setSecretWord = (0, import_react.useCallback)(
    (word) => {
      if (!activeRef.current) return false;
      const cur = gameStateRef.current;
      if (cur.role !== "alice" || cur.handler !== KrunkHandler.WaitingCommit) return false;
      const normalised = word.trim().toUpperCase();
      if (!/^[A-Z]{5}$/.test(normalised)) {
        console.warn("[krunk] secret word must be 5 letters");
        return false;
      }
      requireLiveGameMount(viewRef.current);
      const next = {
        ...cur,
        secretWord: normalised,
        handler: KrunkHandler.AliceWaiting,
        myTurn: false
      };
      return commitLocalAction(next, {
        type: "make-move",
        readable: wordToProgram(normalised)
      });
    },
    [commitLocalAction]
  );
  const submitGuess = (0, import_react.useCallback)(
    (word) => {
      if (!activeRef.current) return false;
      const cur = gameStateRef.current;
      if (cur.role !== "bob" || cur.handler !== KrunkHandler.BobGuess || cur.queuedGuesses.length > 0)
        return false;
      const normalised = word.trim().toUpperCase();
      if (!/^[A-Z]{5}$/.test(normalised)) {
        console.warn("[krunk] guess must be 5 letters");
        return false;
      }
      requireLiveGameMount(viewRef.current);
      const next = {
        ...cur,
        guesses: [
          ...cur.guesses,
          // Use -1 as a "pending" sentinel; replaced when alice's
          // clue readable arrives.
          { word: normalised, clue: PENDING_CLUE }
        ],
        handler: KrunkHandler.BobWaiting,
        myTurn: false
      };
      return commitLocalAction(next, {
        type: "make-move",
        readable: wordToProgram(normalised)
      });
    },
    [commitLocalAction]
  );
  const queueGuess = (0, import_react.useCallback)(
    (word) => {
      if (!activeRef.current) return;
      const cur = gameStateRef.current;
      const canQueue = cur.role === "bob" && (cur.handler === KrunkHandler.BobWaiting || cur.handler === KrunkHandler.BobGuess && cur.queuedGuesses.length > 0) && cur.guesses.length + cur.queuedGuesses.length < MAX_KRUNK_GUESSES;
      if (!canQueue) return;
      const normalised = word.trim().toUpperCase();
      if (!/^[A-Z]{5}$/.test(normalised)) {
        console.warn("[krunk] queued guess must be 5 letters");
        return;
      }
      commitStateChange({
        ...cur,
        queuedGuesses: [...cur.queuedGuesses, normalised]
      });
    },
    [commitStateChange]
  );
  const submitNextQueuedGuess = (0, import_react.useCallback)(() => {
    if (!activeRef.current) return;
    const cur = gameStateRef.current;
    if (cur.role !== "bob" || cur.handler !== KrunkHandler.BobGuess || cur.queuedGuesses.length === 0)
      return;
    const [word, ...queuedGuesses] = cur.queuedGuesses;
    const dequeued = { ...cur, queuedGuesses };
    commitLocalAction(
      {
        ...dequeued,
        guesses: [...dequeued.guesses, { word, clue: PENDING_CLUE }],
        handler: KrunkHandler.BobWaiting,
        myTurn: false
      },
      { type: "make-move", readable: wordToProgram(word) }
    );
  }, [commitLocalAction]);
  return {
    gameState,
    rejection,
    setSecretWord,
    submitGuess,
    queueGuess,
    submitNextQueuedGuess
  };
}

// ../games/krunk/ui/Krunk.tsx
var import_jsx_runtime = __toESM(require_jsx_runtime());
var CLUE_TILE = ["\u2B1B", "\u{1F7E7}", "\u{1F7E9}"];
function formatKrunkHandLog(role, betSize, guesses, revealedWord, formatAmount = formatKrunkAmount) {
  const roleLabel = role === "alice" ? "picking" : "guessing";
  const lines = [`Krunk (${roleLabel}) ${formatAmount(betSize)}`];
  for (const g of guesses) {
    lines.push(g.clue.map((v) => CLUE_TILE[Number(v)]).join("") + g.word);
  }
  const solved = guesses.some((g) => g.clue.every((v) => v === 2n));
  if (!solved && revealedWord) {
    lines.push("\u2B1B\u2B1B\u2B1B\u2B1B\u2B1B" + revealedWord);
  }
  return lines;
}
function krunkGameSlots(handState) {
  const aliceMemberIndex = handState.members.findIndex((member) => member.role === "alice");
  const bobMemberIndex = handState.members.findIndex((member) => member.role === "bob");
  if (aliceMemberIndex < 0 || bobMemberIndex < 0 || aliceMemberIndex === bobMemberIndex) {
    throw new Error("Krunk persisted roles must contain one alice and one bob");
  }
  return {
    aliceMemberIndex,
    bobMemberIndex,
    aliceActive: handState.members[aliceMemberIndex].handler !== KrunkHandler.Terminal,
    bobActive: handState.members[bobMemberIndex].handler !== KrunkHandler.Terminal
  };
}
function newlyResolvedKrunkIndex(resolvedCount, previousResolvedCount) {
  return resolvedCount > previousResolvedCount ? resolvedCount - 1 : void 0;
}
var MAX_GUESSES2 = 5;
var WORD_LEN = 5;
var TILE = "w-12 h-12 text-xl";
var FLIP_HALF_MS = 400;
var FLIP_STAGGER_MS = 200;
var GUESS_ROW_FLIP_MS = (WORD_LEN - 1) * FLIP_STAGGER_MS + 2 * FLIP_HALF_MS;
var CLUE_COLORS = {
  2: { bg: "#00875f", border: "#00875f" },
  1: { bg: "#e89f00", border: "#e89f00" },
  0: { bg: "#787c7e", border: "#787c7e" }
};
function krunkLetterStatuses(guesses) {
  const rank = {
    unused: 0,
    absent: 1,
    present: 2,
    correct: 3
  };
  const out = {};
  for (const g of guesses) {
    if (g.clue.every((v) => v === -1n)) continue;
    for (let i = 0; i < 5; i++) {
      const letter = g.word.charAt(i);
      if (!letter) continue;
      const next = g.clue[i] === 2n ? "correct" : g.clue[i] === 1n ? "present" : g.clue[i] === 0n ? "absent" : "unused";
      const prev = out[letter] ?? "unused";
      if (rank[next] > rank[prev]) out[letter] = next;
    }
  }
  return out;
}
var KEYBOARD_ROWS = [
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["Z", "X", "C", "V", "B", "N", "M", "\u232B"]
];
function LetterCell({
  letter,
  clueValue,
  flipDelay
}) {
  const animationDelay = (0, import_react2.useRef)(flipDelay).current;
  const [phase, setPhase] = (0, import_react2.useState)(
    animationDelay == null ? "done" : "idle"
  );
  (0, import_react2.useEffect)(() => {
    if (animationDelay == null) return;
    setPhase("idle");
    const start = setTimeout(() => setPhase("half"), animationDelay);
    return () => clearTimeout(start);
  }, [animationDelay]);
  (0, import_react2.useEffect)(() => {
    if (phase !== "half") return;
    const fallback = setTimeout(
      () => setPhase((current) => current === "half" ? "done" : current),
      FLIP_HALF_MS + 100
    );
    return () => clearTimeout(fallback);
  }, [phase]);
  const showColor = phase === "done";
  const color = CLUE_COLORS[Number(clueValue)];
  const style = {
    transition: `transform ${FLIP_HALF_MS}ms ease-in-out`,
    transform: phase === "half" ? "rotateX(90deg)" : "rotateX(0deg)",
    perspective: "600px",
    ...showColor && color ? { backgroundColor: color.bg, borderColor: color.border, color: "white" } : {}
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "div",
    {
      className: `inline-flex items-center justify-center rounded border border-canvas-line bg-canvas-bg font-bold uppercase tabular-nums select-none text-canvas-text-contrast ${TILE}`,
      style,
      onTransitionEnd: (event) => {
        if (event.propertyName === "transform" && phase === "half") {
          setPhase("done");
        }
      },
      children: letter
    }
  );
}
function EmptyCell({ letter }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "div",
    {
      className: `inline-flex items-center justify-center rounded border border-dashed border-canvas-line bg-canvas-bg font-bold uppercase text-canvas-text-contrast ${TILE}`,
      children: letter ?? ""
    }
  );
}
function TargetCell({ letter, flipDelay }) {
  const animationDelay = (0, import_react2.useRef)(flipDelay).current;
  const [phase, setPhase] = (0, import_react2.useState)(
    animationDelay == null ? "done" : "idle"
  );
  (0, import_react2.useEffect)(() => {
    if (animationDelay == null) return;
    setPhase("idle");
    const start = setTimeout(() => setPhase("half"), animationDelay);
    return () => clearTimeout(start);
  }, [animationDelay]);
  (0, import_react2.useEffect)(() => {
    if (phase !== "half") return;
    const fallback = setTimeout(
      () => setPhase((current) => current === "half" ? "done" : current),
      FLIP_HALF_MS + 100
    );
    return () => clearTimeout(fallback);
  }, [phase]);
  const revealed = phase === "done";
  const style = {
    transition: `transform ${FLIP_HALF_MS}ms ease-in-out`,
    transform: phase === "half" ? "rotateX(90deg)" : "rotateX(0deg)",
    perspective: "600px",
    ...revealed ? { backgroundColor: "#e0e0e0", borderColor: "#999", color: "black" } : {}
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "div",
    {
      className: `inline-flex items-center justify-center rounded border border-canvas-line bg-canvas-bg font-bold uppercase tabular-nums select-none text-canvas-text-contrast ${TILE}`,
      style,
      onTransitionEnd: (event) => {
        if (event.propertyName === "transform" && phase === "half") {
          setPhase("done");
        }
      },
      children: revealed ? letter : ""
    }
  );
}
function PendingGuessRow({ word }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex gap-1", children: [0, 1, 2, 3, 4].map((i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EmptyCell, { letter: word.charAt(i) }, i)) });
}
function GuessRow({ guess, animate }) {
  const pending = guess.clue.every((v) => v === -1n);
  if (pending) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PendingGuessRow, { word: guess.word });
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex gap-1", children: [0, 1, 2, 3, 4].map((i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    LetterCell,
    {
      letter: guess.word.charAt(i),
      clueValue: guess.clue[i],
      flipDelay: animate ? i * FLIP_STAGGER_MS : void 0
    },
    i
  )) });
}
function Grid({
  guesses,
  draft,
  showDraftRow,
  latestAnimateIndex
}) {
  const draftLetters = (draft ?? "").split("").slice(0, 5);
  const rows = [];
  for (let i = 0; i < MAX_GUESSES2; i++) {
    if (i < guesses.length) {
      rows.push(/* @__PURE__ */ (0, import_jsx_runtime.jsx)(GuessRow, { guess: guesses[i], animate: latestAnimateIndex === i }, i));
    } else if (showDraftRow && i === guesses.length) {
      rows.push(
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex gap-1", children: [0, 1, 2, 3, 4].map((j) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EmptyCell, { letter: draftLetters[j] }, j)) }, i)
      );
    } else {
      rows.push(
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex gap-1", children: [0, 1, 2, 3, 4].map((j) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EmptyCell, {}, j)) }, i)
      );
    }
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex flex-col gap-1 items-center", children: rows });
}
function TargetRow({ word, animate }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex gap-1 mt-2", children: [0, 1, 2, 3, 4].map((i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    TargetCell,
    {
      letter: word.charAt(i),
      flipDelay: animate ? i * FLIP_STAGGER_MS : void 0
    },
    i
  )) });
}
function keyBackground(status) {
  if (status === "correct") {
    return {
      backgroundColor: CLUE_COLORS[2].bg,
      borderColor: CLUE_COLORS[2].border,
      color: "white"
    };
  }
  if (status === "present") {
    return {
      backgroundColor: CLUE_COLORS[1].bg,
      borderColor: CLUE_COLORS[1].border,
      color: "white"
    };
  }
  if (status === "absent") {
    return {
      backgroundColor: CLUE_COLORS[0].bg,
      borderColor: CLUE_COLORS[0].border,
      color: "white"
    };
  }
  return {};
}
function KeyboardKey({
  label,
  status,
  wide,
  disabled,
  onPress
}) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      type: "button",
      disabled,
      onClick: onPress,
      className: `inline-flex items-center justify-center rounded border border-canvas-line bg-canvas-bg font-bold uppercase select-none text-canvas-text-contrast disabled:opacity-40 ${wide ? "h-12 min-w-[3rem] px-2 text-xs" : "h-12 w-9 text-sm"}`,
      style: keyBackground(status),
      children: label
    }
  );
}
function OnScreenKeyboard({
  statuses,
  disabled,
  onLetter,
  onBackspace
}) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex flex-col gap-1.5 items-center", children: KEYBOARD_ROWS.map((row, ri) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex gap-1.5 justify-center", children: row.map((key) => {
    if (key === "\u232B") {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(KeyboardKey, { label: "\u232B", wide: true, disabled, onPress: onBackspace }, key);
    }
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      KeyboardKey,
      {
        label: key,
        status: statuses[key],
        disabled,
        onPress: () => onLetter(key)
      },
      key
    );
  }) }, ri)) });
}
var Krunk = ({
  view,
  onGameLog
}) => {
  const interactive = !view.frozen;
  const handState = view.hand.getState();
  const { aliceMemberIndex, bobMemberIndex } = krunkGameSlots(handState);
  const betSize = handState.perPlayerStake * 2n;
  const aliceInHand = handState.members[aliceMemberIndex].handler !== KrunkHandler.Terminal;
  const bobInHand = handState.members[bobMemberIndex].handler !== KrunkHandler.Terminal;
  const aliceInteractive = interactive && aliceInHand;
  const aliceHand = useKrunkHand(view, aliceMemberIndex);
  const bobHand = useKrunkHand(view, bobMemberIndex);
  const setAliceSecretWord = aliceHand.setSecretWord;
  const submitBobGuessMove = bobHand.submitGuess;
  const queueBobGuess = bobHand.queueGuess;
  const submitNextQueuedBobGuess = bobHand.submitNextQueuedGuess;
  const aliceLogFiredRef = (0, import_react2.useRef)(false);
  const bobLogFiredRef = (0, import_react2.useRef)(false);
  (0, import_react2.useEffect)(() => {
    if (aliceHand.gameState.handler !== KrunkHandler.Terminal || aliceLogFiredRef.current) {
      return;
    }
    aliceLogFiredRef.current = true;
    onGameLog?.(
      formatKrunkHandLog(
        "alice",
        betSize,
        aliceHand.gameState.guesses,
        aliceHand.gameState.revealedWord ?? aliceHand.gameState.secretWord,
        formatKrunkAmount
      )
    );
  }, [
    aliceHand.gameState.handler,
    aliceHand.gameState.guesses,
    aliceHand.gameState.revealedWord,
    aliceHand.gameState.secretWord,
    betSize,
    onGameLog
  ]);
  (0, import_react2.useEffect)(() => {
    if (bobHand.gameState.handler !== KrunkHandler.Terminal || bobLogFiredRef.current) {
      return;
    }
    bobLogFiredRef.current = true;
    onGameLog?.(
      formatKrunkHandLog(
        "bob",
        betSize,
        bobHand.gameState.guesses,
        bobHand.gameState.revealedWord,
        formatKrunkAmount
      )
    );
  }, [
    bobHand.gameState.handler,
    bobHand.gameState.guesses,
    bobHand.gameState.revealedWord,
    betSize,
    onGameLog
  ]);
  const wordCommitted = aliceHand.gameState.secretWord !== null;
  const [wordDraft, setWordDraft] = (0, import_react2.useState)("");
  const [guessDraft, setGuessDraft] = (0, import_react2.useState)("");
  const guessQueue = bobHand.gameState.queuedGuesses;
  const prevResolvedCountRef = (0, import_react2.useRef)(0);
  const resolvedCount = bobHand.gameState.guesses.filter(
    (g) => !g.clue.every((v) => v === -1n)
  ).length;
  const newlyResolvedIndex = newlyResolvedKrunkIndex(resolvedCount, prevResolvedCountRef.current);
  const displayQueue = guessQueue;
  const displayedBobGuesses = krunkGuessesWithQueued(bobHand.gameState.guesses, displayQueue);
  const [animateIndex, setAnimateIndex] = (0, import_react2.useState)(void 0);
  (0, import_react2.useEffect)(() => {
    if (newlyResolvedIndex === void 0) return;
    prevResolvedCountRef.current = resolvedCount;
    setAnimateIndex(newlyResolvedIndex);
  }, [newlyResolvedIndex, resolvedCount]);
  const latestAnimateIndex = newlyResolvedIndex ?? animateIndex;
  const bobRevealedWord = bobHand.gameState.revealedWord;
  const bobSolved = bobHand.gameState.guesses.some((g) => g.clue.every((v) => v === 2n));
  const bobMissed = bobRevealedWord != null && !bobSolved;
  const animateBobReveal = bobMissed && latestAnimateIndex === bobHand.gameState.guesses.length - 1;
  const [bobRevealReady, setBobRevealReady] = (0, import_react2.useState)(false);
  (0, import_react2.useEffect)(() => {
    if (!bobMissed) {
      setBobRevealReady(false);
      return;
    }
    if (!animateBobReveal) {
      setBobRevealReady(true);
      return;
    }
    setBobRevealReady(false);
    const t = setTimeout(() => setBobRevealReady(true), GUESS_ROW_FLIP_MS);
    return () => clearTimeout(t);
  }, [bobMissed, animateBobReveal]);
  const filledGuessCount = bobHand.gameState.guesses.length + displayQueue.length;
  const isBobGuessPhase = interactive && bobInHand && wordCommitted && bobHand.gameState.role === "bob" && bobHand.gameState.handler === KrunkHandler.BobGuess;
  const canDraftGuess = interactive && bobInHand && canDraftKrunkGuess(wordCommitted, bobHand.gameState.handler, filledGuessCount);
  const canQueueGuess = interactive && bobInHand && canQueueKrunkGuess(wordCommitted, bobHand.gameState.handler, filledGuessCount);
  (0, import_react2.useEffect)(() => {
    if (!interactive) return;
    if (!isBobGuessPhase || guessQueue.length === 0) return;
    if (bobHand.gameState.handler !== KrunkHandler.BobGuess) return;
    submitNextQueuedBobGuess();
  }, [
    isBobGuessPhase,
    interactive,
    guessQueue.length,
    bobHand.gameState.handler,
    submitNextQueuedBobGuess
  ]);
  const pickingWord = aliceInteractive && !wordCommitted;
  const showWordDraft = aliceInHand && !wordCommitted;
  const keyboardMode = pickingWord ? "pick" : canDraftGuess ? "guess" : null;
  const activeDraft = keyboardMode === "pick" ? wordDraft : guessDraft;
  const showGuessDraft = canDraftGuess || guessDraft.length > 0;
  const keyboardFocusRef = (0, import_react2.useRef)(null);
  const commitWord = (0, import_react2.useCallback)(() => {
    if (wordDraft.length !== 5) return false;
    if (!setAliceSecretWord(wordDraft)) return false;
    setWordDraft("");
    return true;
  }, [wordDraft, setAliceSecretWord]);
  const submitGuess = (0, import_react2.useCallback)(() => {
    if (guessDraft.length !== 5) return false;
    if (isBobGuessPhase && guessQueue.length === 0) {
      if (!submitBobGuessMove(guessDraft)) return false;
    } else if (canQueueGuess || isBobGuessPhase && guessQueue.length > 0) {
      if (filledGuessCount >= MAX_GUESSES2) return false;
      queueBobGuess(guessDraft);
    } else {
      return false;
    }
    setGuessDraft("");
    return true;
  }, [
    guessDraft,
    isBobGuessPhase,
    canQueueGuess,
    guessQueue.length,
    filledGuessCount,
    submitBobGuessMove,
    queueBobGuess
  ]);
  const submitActive = (0, import_react2.useCallback)(() => {
    const submitted = keyboardMode === "pick" ? commitWord() : keyboardMode === "guess" ? submitGuess() : false;
    if (submitted) keyboardFocusRef.current?.focus();
  }, [keyboardMode, commitWord, submitGuess]);
  const themLabel = view.opponentName ?? "Opponent";
  const handComplete = bobHand.gameState.handler === KrunkHandler.Terminal && aliceHand.gameState.handler === KrunkHandler.Terminal;
  const bobBoardNotice = (0, import_react2.useMemo)(
    () => bobHand.rejection ? { text: bobHand.rejection, kind: "error" } : krunkBoardNotice(bobHand.gameState, themLabel, handState.perPlayerStake),
    [bobHand.gameState, bobHand.rejection, themLabel, handState.perPlayerStake]
  );
  const aliceBoardNotice = (0, import_react2.useMemo)(
    () => aliceHand.rejection ? { text: aliceHand.rejection, kind: "error" } : krunkBoardNotice(aliceHand.gameState, themLabel, handState.perPlayerStake),
    [aliceHand.gameState, aliceHand.rejection, themLabel, handState.perPlayerStake]
  );
  const sharedStatusNotice = (0, import_react2.useMemo)(() => {
    if (handComplete) return { text: "", kind: "info" };
    if (!wordCommitted) return { text: "Pick your secret word", kind: "info" };
    if (displayQueue.length > 0) {
      return {
        text: displayQueue.length === 1 ? "1 guess queued\u2026" : `${displayQueue.length} guesses queued\u2026`,
        kind: "info"
      };
    }
    if (bobHand.gameState.handler === KrunkHandler.BobGuess) {
      return {
        text: `Guess ${bobHand.gameState.guesses.length + 1} of ${MAX_GUESSES2}`,
        kind: "info"
      };
    }
    if (aliceHand.gameState.handler === KrunkHandler.AliceClue) {
      return { text: "Scoring\u2026", kind: "info" };
    }
    return { text: `Waiting for ${themLabel}\u2026`, kind: "info" };
  }, [
    aliceHand.gameState.handler,
    bobHand.gameState,
    handComplete,
    wordCommitted,
    displayQueue.length,
    themLabel
  ]);
  const letterStatuses = (0, import_react2.useMemo)(
    () => krunkLetterStatuses(bobHand.gameState.guesses),
    [bobHand.gameState.guesses]
  );
  const typeLetter = (0, import_react2.useCallback)(
    (letter) => {
      if (keyboardMode === null) return;
      const setter = keyboardMode === "pick" ? setWordDraft : setGuessDraft;
      setter((prev) => {
        if (prev.length >= 5) return prev;
        return (prev + letter.toUpperCase()).replace(/[^A-Z]/g, "").slice(0, 5);
      });
    },
    [keyboardMode]
  );
  const backspace = (0, import_react2.useCallback)(() => {
    if (keyboardMode === null) return;
    const setter = keyboardMode === "pick" ? setWordDraft : setGuessDraft;
    setter((prev) => prev.slice(0, -1));
  }, [keyboardMode]);
  (0, import_react2.useEffect)(() => {
    if (!interactive) return;
    if (keyboardMode === null) return;
    const onKeyDown = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (activeDraft.length === 5) submitActive();
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        backspace();
        return;
      }
      if (/^[a-zA-Z]$/.test(e.key)) {
        e.preventDefault();
        typeLetter(e.key);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [interactive, keyboardMode, activeDraft, submitActive, backspace, typeLetter]);
  const actionLabel = !wordCommitted ? "Pick" : "Guess";
  const actionEnabled = keyboardMode === "pick" ? wordDraft.length === 5 : keyboardMode === "guess" && guessDraft.length === 5 && (isBobGuessPhase || canQueueGuess);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-col gap-4 items-center py-4", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex gap-6 items-start justify-center", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-col items-center gap-2", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "text-sm font-semibold text-canvas-text-contrast", children: "Your guesses" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          Grid,
          {
            guesses: displayedBobGuesses,
            draft: guessDraft,
            showDraftRow: showGuessDraft,
            latestAnimateIndex
          }
        ),
        bobMissed && bobRevealReady && bobRevealedWord ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TargetRow, { word: bobRevealedWord, animate: animateBobReveal }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex gap-1 mt-2", children: [0, 1, 2, 3, 4].map((i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EmptyCell, {}, i)) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "p",
          {
            className: `min-h-5 max-w-60 text-center text-xs ${bobBoardNotice?.kind === "error" ? "text-red-600" : bobBoardNotice?.kind === "win" ? "font-semibold text-canvas-text-contrast" : "text-canvas-text-contrast"}`,
            children: bobBoardNotice?.text ?? ""
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-col items-center gap-2", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "text-sm font-semibold text-canvas-text-contrast", children: [
          themLabel,
          "'s guesses"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Grid, { guesses: aliceHand.gameState.guesses }),
        showWordDraft ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex gap-1 mt-2", children: [0, 1, 2, 3, 4].map((i) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EmptyCell, { letter: wordDraft.charAt(i) }, i)) }) : aliceHand.gameState.secretWord ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TargetRow, { word: aliceHand.gameState.secretWord }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "p",
          {
            className: `min-h-5 max-w-60 text-center text-xs ${aliceBoardNotice?.kind === "error" ? "text-red-600" : "text-canvas-text-contrast"}`,
            children: aliceBoardNotice?.text ?? ""
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        ref: keyboardFocusRef,
        tabIndex: -1,
        className: "flex flex-col items-center gap-2 focus:outline-none",
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            OnScreenKeyboard,
            {
              statuses: letterStatuses,
              disabled: !interactive || keyboardMode === null || handComplete,
              onLetter: typeLetter,
              onBackspace: backspace
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              className: "px-4 py-1.5 rounded bg-primary-solid text-primary-on-primary text-sm font-medium hover:bg-primary-solid-hover disabled:opacity-40",
              disabled: !interactive || !actionEnabled || handComplete,
              onClick: submitActive,
              children: actionLabel
            }
          )
        ]
      }
    ),
    sharedStatusNotice.text && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "text-center text-sm text-canvas-text-contrast", children: sharedStatusNotice.text })
  ] });
};
var Krunk_default = Krunk;
export {
  Krunk_default as default,
  formatKrunkHandLog,
  krunkGameSlots,
  krunkLetterStatuses,
  newlyResolvedKrunkIndex
};
