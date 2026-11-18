import {
  isSettlementOutcome
} from "./chunk-ZODP5B7L.js";

// ../games/krunk/ui/serialize.ts
var KrunkHandler = {
  WaitingCommit: 0n,
  AliceWaiting: 1n,
  AliceClue: 2n,
  BobWaiting: 3n,
  BobGuess: 4n,
  Terminal: 5n
};
function initialKrunkGameState(role) {
  return {
    handler: role === "alice" ? KrunkHandler.WaitingCommit : KrunkHandler.BobWaiting,
    myTurn: role === "alice",
    role,
    guesses: [],
    queuedGuesses: [],
    secretWord: null,
    revealedWord: null,
    outcome: null,
    settlementOutcome: null,
    moverShare: null
  };
}
function isNullableString(value) {
  return value === null || typeof value === "string";
}
function isWord(value) {
  return typeof value === "string" && /^[A-Z]{5}$/.test(value);
}
function isAmount(value) {
  return value === null || typeof value === "bigint" && value >= 0n;
}
function isKrunkGameState(value) {
  if (typeof value !== "object" || value === null) return false;
  const state = value;
  if (typeof state.handler !== "bigint" || state.handler < KrunkHandler.WaitingCommit || state.handler > KrunkHandler.Terminal || state.role !== "alice" && state.role !== "bob" || !Array.isArray(state.guesses) || state.guesses.length > 5 || !Array.isArray(state.queuedGuesses) || state.guesses.length + state.queuedGuesses.length > 5 || !state.queuedGuesses.every(isWord) || state.role === "alice" && state.queuedGuesses.length !== 0) {
    return false;
  }
  const validHandlerForRole = state.handler === KrunkHandler.Terminal || state.role === "alice" && (state.handler === KrunkHandler.WaitingCommit || state.handler === KrunkHandler.AliceWaiting || state.handler === KrunkHandler.AliceClue) || state.role === "bob" && (state.handler === KrunkHandler.BobWaiting || state.handler === KrunkHandler.BobGuess);
  if (!validHandlerForRole) return false;
  const expectedTurn = state.handler === KrunkHandler.WaitingCommit || state.handler === KrunkHandler.BobGuess;
  if (typeof state.myTurn !== "boolean" || state.handler !== KrunkHandler.AliceClue && state.myTurn !== expectedTurn) {
    return false;
  }
  const pendingGuessIndexes = [];
  if (!state.guesses.every((guess, index) => {
    if (typeof guess !== "object" || guess === null || !isWord(guess.word)) return false;
    if (!Array.isArray(guess.clue) || guess.clue.length !== 5) return false;
    const pending = guess.clue.every((clue) => clue === -1n);
    if (pending) pendingGuessIndexes.push(index);
    return pending || guess.clue.every((clue) => typeof clue === "bigint" && clue >= 0n && clue <= 2n);
  })) {
    return false;
  }
  if (pendingGuessIndexes.length > 1 || pendingGuessIndexes.length === 1 && (state.role !== "bob" || pendingGuessIndexes[0] !== state.guesses.length - 1)) {
    return false;
  }
  if (state.secretWord !== null && !isWord(state.secretWord)) return false;
  if (state.revealedWord !== null && !isWord(state.revealedWord)) return false;
  if (state.role === "bob" && state.secretWord !== null) return false;
  const terminal = state.handler === KrunkHandler.Terminal;
  if (!terminal && (state.revealedWord !== null || state.outcome !== null || state.settlementOutcome !== null || state.moverShare !== null) || terminal && state.myTurn) {
    return false;
  }
  return isNullableString(state.secretWord) && isNullableString(state.revealedWord) && (state.outcome === null || state.outcome === "win" || state.outcome === "lose") && (state.settlementOutcome === null || isSettlementOutcome(state.settlementOutcome)) && isAmount(state.moverShare);
}
function isKrunkHandState(value) {
  if (typeof value !== "object" || value === null) return false;
  const hand = value;
  return typeof hand.perPlayerStake === "bigint" && hand.perPlayerStake > 0n && Array.isArray(hand.members) && hand.members.length === 2 && isKrunkGameState(hand.members[0]) && isKrunkGameState(hand.members[1]);
}
function krunkGameStateFromHand(handState, memberIndex) {
  if (!Number.isInteger(memberIndex) || memberIndex < 0) {
    throw new Error(`Krunk member index must be a nonnegative integer: ${memberIndex}`);
  }
  const game = handState.members[memberIndex];
  if (!game) throw new Error(`Krunk hand is missing member ${memberIndex}`);
  return game;
}
function parseReadable(readable) {
  const items = readable.toList();
  if (items.length === 0) return { word: null, clue: null };
  const clueFrom = (values) => {
    const clue = values.map((item) => item.toBigInt());
    if (clue.length !== 5 || clue.some((item) => item < 0n || item > 2n)) {
      throw new Error("Krunk handler returned an invalid clue");
    }
    return clue;
  };
  if (items.length === 5) return { word: null, clue: clueFrom(items) };
  if (items.length !== 2) {
    throw new Error(`Krunk handler returned ${items.length} readable fields`);
  }
  const word = new TextDecoder("utf-8", { fatal: true }).decode(items[0].atom).toUpperCase();
  if (!isWord(word)) throw new Error("Krunk handler returned an invalid word");
  return {
    word,
    clue: clueFrom(items[1].toList())
  };
}
function finishedState(state, revealedWord, clue, moverShare) {
  const correct = (value) => value.every((item) => item === 2n);
  const bobWon = state.guesses.some((guess) => correct(guess.clue)) || (clue ? correct(clue) : false);
  const aliceWon = !bobWon;
  return {
    ...state,
    handler: KrunkHandler.Terminal,
    myTurn: false,
    queuedGuesses: [],
    revealedWord,
    moverShare,
    outcome: state.role === "alice" && aliceWon || state.role === "bob" && bobWon ? "win" : "lose"
  };
}
function krunkOutcomeFromPlay(game) {
  const bobWon = game.guesses.some((guess) => guess.clue.every((item) => item === 2n));
  const finished = bobWon || game.guesses.length >= 5;
  if (!finished) return null;
  return game.role === "bob" ? bobWon ? "win" : "lose" : bobWon ? "lose" : "win";
}
function reduceKrunkFeatureState(game, event) {
  if (event.type === "settled") {
    return {
      ...game,
      handler: KrunkHandler.Terminal,
      myTurn: false,
      queuedGuesses: [],
      outcome: game.outcome ?? krunkOutcomeFromPlay(game),
      settlementOutcome: event.outcome
    };
  }
  const parsed = parseReadable(event.readable);
  if (game.role === "alice" && parsed.word && parsed.clue) {
    return {
      ...game,
      handler: KrunkHandler.AliceClue,
      myTurn: true,
      guesses: [...game.guesses, { word: parsed.word, clue: parsed.clue }]
    };
  }
  if (game.role === "bob" && !parsed.word && !parsed.clue) {
    return { ...game, handler: KrunkHandler.BobGuess, myTurn: true };
  }
  if (game.role === "bob" && parsed.clue && !parsed.word) {
    const guesses = [...game.guesses];
    const index = guesses.length - 1;
    if (index < 0 || !guesses[index].clue.every((value) => value === -1n)) {
      throw new Error("Krunk handler returned a clue without a pending guess");
    }
    guesses[index] = { ...guesses[index], clue: parsed.clue };
    const terminalClue = parsed.clue.every((value) => value === 2n) || guesses.length >= 5;
    return {
      ...game,
      handler: terminalClue ? KrunkHandler.BobWaiting : KrunkHandler.BobGuess,
      myTurn: !terminalClue,
      guesses
    };
  }
  if (game.role === "bob" && parsed.word && parsed.clue) {
    const guesses = [...game.guesses];
    const index = guesses.length - 1;
    if (index >= 0 && guesses[index].clue.every((value) => value === -1n)) {
      guesses[index] = { ...guesses[index], clue: parsed.clue };
    }
    return finishedState({ ...game, guesses }, parsed.word, parsed.clue, event.moverShare);
  }
  throw new Error(
    `Krunk handler returned an unexpected readable for ${game.role} handler ${game.handler}`
  );
}
function reduceKrunkHandState(current, event) {
  const game = krunkGameStateFromHand(current, event.memberIndex);
  let next;
  if (event.type === "move-rejected") {
    next = game.role === "bob" && game.handler === KrunkHandler.BobGuess && game.queuedGuesses.length > 0 ? { ...game, queuedGuesses: game.queuedGuesses.slice(1) } : game;
  } else if (event.type === "hand-ended") {
    next = reduceKrunkFeatureState(game, { type: "settled", outcome: event.outcome });
  } else if (event.type === "move-readable") {
    next = reduceKrunkFeatureState(game, {
      type: "opponent-moved",
      readable: event.readable,
      moverShare: event.moverShare
    });
  } else {
    throw new Error("Krunk does not support handler message readables");
  }
  if (next === game) return current;
  const members = [...current.members];
  members[event.memberIndex] = next;
  return { ...current, members };
}
function krunkHandFromState(initial) {
  let state = initial;
  return {
    getState: () => state,
    receive: (update) => {
      state = reduceKrunkHandState(state, update);
    },
    updateGame: (memberIndex, reducer) => {
      const game = krunkGameStateFromHand(state, memberIndex);
      const members = [...state.members];
      members[memberIndex] = reducer(game);
      state = { ...state, members };
    }
  };
}
function createKrunkHand(init) {
  if (init.members.length !== 2) {
    throw new Error("Krunk requires two games");
  }
  const firstStake = init.members[0].playerAContribution + init.members[0].playerBContribution;
  const secondStake = init.members[1].playerAContribution + init.members[1].playerBContribution;
  if (firstStake <= 0n || secondStake !== firstStake || init.members[0].playerAContribution === 0n === (init.members[0].playerBContribution === 0n) || init.members[1].playerAContribution === 0n === (init.members[1].playerBContribution === 0n) || init.members[0].playerAContribution > 0n === init.members[1].playerAContribution > 0n || init.members.some((member) => member.readableParameters.toBigInt() !== firstStake)) {
    throw new Error("Krunk requires matching approved and readable split contributions");
  }
  return krunkHandFromState({
    perPlayerStake: firstStake,
    members: [
      initialKrunkGameState(init.members[0].ourTurn ? "alice" : "bob"),
      initialKrunkGameState(init.members[1].ourTurn ? "alice" : "bob")
    ]
  });
}
function restoreKrunkHand(savedState) {
  if (!isKrunkHandState(savedState)) {
    throw new Error("Cannot restore Krunk hand: saved state is invalid");
  }
  return krunkHandFromState(savedState);
}

// ../games/krunk/ui/formatting.ts
var TRILLION = 1000000000000n;
function formatKrunkAmount(mojos) {
  if (mojos < 1000000n) return `${mojos} MOJO`;
  const whole = mojos / TRILLION;
  const frac = mojos % TRILLION;
  if (frac === 0n) return `${whole} XCH`;
  return `${whole}.${frac.toString().padStart(12, "0").replace(/0+$/, "")} XCH`;
}
function formatKrunkMojos(mojos) {
  const abs = mojos < 0n ? -mojos : mojos;
  if (abs < 100000000n) return `${mojos.toLocaleString()} mojos`;
  const sign = mojos < 0n ? "-" : "";
  const whole = abs / TRILLION;
  const frac = (abs % TRILLION).toString().padStart(12, "0").slice(0, 4);
  return `${sign}${whole.toLocaleString()}.${frac} XCH`;
}

// ../games/krunk/ui/handProposal.ts
var krunkProposalParameters = {
  decode: (value) => typeof value === "bigint" && isValidKrunkStake(value) ? value : null,
  encode: (value) => value
};
function isValidKrunkStake(stake) {
  return stake > 0n && stake % 100n === 0n;
}
var registration = {
  displayName: "Krunk",
  createHand: createKrunkHand,
  restoreHand: restoreKrunkHand,
  proposalParameters: krunkProposalParameters,
  describeHandProposal(handProposal) {
    const stake = krunkProposalParameters.decode(handProposal.parameters);
    if (stake === null) {
      throw new Error("Krunk proposal parameters are invalid");
    }
    return `Stake ${formatKrunkMojos(stake)} each`;
  }
};
var handProposal_default = registration;

export {
  KrunkHandler,
  krunkGameStateFromHand,
  krunkOutcomeFromPlay,
  formatKrunkAmount,
  isValidKrunkStake,
  handProposal_default
};
