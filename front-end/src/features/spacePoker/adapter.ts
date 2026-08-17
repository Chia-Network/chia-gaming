import { Program } from 'clvm-lib';
import {
  equalBaseTerms,
  reduceGameStateSnapshot,
  type DurableGameStateEvent,
  type GameFeatureRegistration,
  type TermsFor,
} from '../../lib/gameAdapter';
import { isForfeitOutcome, type SettlementOutcome } from '../../lib/settlement';
import { spacepokerStateCodec, type SpacepokerHandState, type SpHandEntry } from './stateCodec';
import { resolveSpacepokerUnitSize } from './unitSize';

function initialState(isMyTurn: boolean, unitSizeMojos: bigint): SpacepokerHandState {
  return {
    gameState: { handler: 0n, myTurn: isMyTurn, N: 4n },
    playerHoleCards: null,
    playerBoost: false,
    opponentHoleCards: null,
    opponentBoost: null,
    communityCards: [null, null, null, null, null],
    halfPot: 1n,
    lastRaise: 0n,
    iRaisedLast: false,
    handHistory: [],
    outcome: null,
    terminalState: 'none',
    terminalRecovery: null,
    pendingTerminalAction: null,
    coinTossIOpen: null,
    unitSizeMojos,
    displayMode: unitSizeMojos >= 1_000_000n ? 'xch' : 'mojos',
  };
}

function parseReadable(readable: Uint8Array): Program[] {
  try {
    return Program.deserialize(readable).toList();
  } catch {
    return [];
  }
}

function tag(items: Program[]): string | null {
  if (items.length === 0) return null;
  try {
    return new TextDecoder().decode(items[0].atom);
  } catch {
    return null;
  }
}

function appendHistory(current: SpacepokerHandState, entry: SpHandEntry): SpacepokerHandState {
  return { ...current, handHistory: [...current.handHistory, entry] };
}

function withLocalConcession(current: SpacepokerHandState): SpacepokerHandState {
  const last = current.handHistory[current.handHistory.length - 1];
  const replacesTerminalAction =
    last?.player === 'you' &&
    (last.action === 'fold' ||
      last.action === 'concede' ||
      last.action === 'reveal' ||
      last.action === 'failed');
  if (last?.player === 'you' && last.action === 'concede') return current;
  return {
    ...current,
    handHistory: replacesTerminalAction
      ? [...current.handHistory.slice(0, -1), { player: 'you', action: 'concede' }]
      : [...current.handHistory, { player: 'you', action: 'concede' }],
  };
}

type SpacepokerReadableEvent =
  | { type: 'opponent-moved'; readable: Uint8Array }
  | { type: 'game-message'; readable: Uint8Array };

function reduceSpacepokerSettlementStateCore(
  current: SpacepokerHandState,
  outcome: SettlementOutcome,
): SpacepokerHandState {
  const voluntary = outcome === 'accept_settlement' || outcome === 'we_accepted';
  if (isForfeitOutcome(outcome) && current.outcome !== null) {
    return withLocalConcession({
      ...current,
      gameState: { handler: 5n, myTurn: false, N: 1n },
      terminalState: 'conceded-by-you',
      terminalRecovery: null,
    });
  }
  if (outcome === 'opponent_timed_out' && current.terminalState === 'none') {
    if (current.outcome !== null && current.outcome.result > 0n) {
      return appendHistory(
        {
          ...current,
          gameState: { handler: 5n, myTurn: false, N: 1n },
          terminalState: 'conceded-by-opponent',
          terminalRecovery: null,
        },
        { player: 'opponent', action: 'concede' },
      );
    }
    return appendHistory(
      {
        ...current,
        gameState: {
          handler: 6n,
          myTurn: false,
          N: current.gameState.N >= 1n ? current.gameState.N : 1n,
        },
        terminalState: 'won-by-opponent-failure',
        terminalRecovery: null,
      },
      { player: 'opponent', action: 'failed' },
    );
  }
  if (current.terminalState === 'revealed' && current.outcome !== null) {
    return {
      ...current,
      gameState: { ...current.gameState, myTurn: false },
      terminalRecovery: null,
    };
  }
  if (voluntary && current.terminalState !== 'none') {
    return {
      ...current,
      gameState: { ...current.gameState, myTurn: false },
      terminalRecovery: null,
    };
  }
  if (voluntary && (current.gameState.handler === 3n || current.gameState.handler === 4n)) {
    const player = outcome === 'we_accepted' || current.gameState.myTurn ? 'you' : 'opponent';
    const action = current.gameState.handler === 3n ? 'fold' : 'concede';
    return appendHistory(
      {
        ...current,
        gameState:
          action === 'fold'
            ? { handler: 6n, myTurn: false, N: current.gameState.N }
            : { handler: 5n, myTurn: false, N: 0n },
        terminalState:
          action === 'fold'
            ? player === 'you'
              ? 'folded-by-you'
              : 'folded-by-opponent'
            : player === 'you'
              ? 'conceded-by-you'
              : 'conceded-by-opponent',
        terminalRecovery: null,
      },
      { player, action },
    );
  }
  return {
    ...current,
    gameState: {
      handler: 6n,
      myTurn: false,
      N: current.gameState.N >= 1n ? current.gameState.N : 1n,
    },
    outcome: null,
    terminalState: 'settled',
    terminalRecovery: null,
  };
}

export function reduceSpacepokerSettlementState(
  current: SpacepokerHandState,
  outcome: SettlementOutcome,
): SpacepokerHandState {
  return {
    ...reduceSpacepokerSettlementStateCore(current, outcome),
    pendingTerminalAction: null,
  };
}

function bigints(program: Program): bigint[] {
  try {
    return program.toList().map((item) => item.toBigInt());
  } catch {
    return [];
  }
}

function placeCards(
  current: SpacepokerHandState,
  position: bigint,
  cards: bigint[],
): SpacepokerHandState {
  const communityCards = [...current.communityCards];
  const start = position === 3n ? 0 : position === 2n ? 3 : 4;
  cards.forEach((card, index) => {
    communityCards[start + index] = card;
  });
  return { ...current, communityCards };
}

function outcomeFrom(
  playerCards: Program,
  playerEval: Program,
  opponentCards: Program,
  opponentEval: Program,
  result: Program,
) {
  return {
    result: result.toBigInt(),
    playerHandCards: bigints(playerCards),
    playerHandEval: bigints(playerEval),
    opponentHandCards: bigints(opponentCards),
    opponentHandEval: bigints(opponentEval),
  };
}

export function reduceSpacepokerFeatureState(
  current: SpacepokerHandState,
  event: SpacepokerReadableEvent,
): SpacepokerHandState {
  const items = parseReadable(event.readable);
  const readableTag = tag(items);
  if (!readableTag) {
    return event.type === 'opponent-moved'
      ? { ...current, gameState: { handler: 1n, myTurn: true, N: 4n } }
      : current;
  }

  if (event.type === 'game-message') {
    if (readableTag === 'deal' && items.length >= 4) {
      return {
        ...current,
        playerHoleCards: [items[1].toBigInt(), items[2].toBigInt()],
        playerBoost: items[3].toBigInt() !== 0n,
        coinTossIOpen: items.length >= 5 ? items[4].toBigInt() !== 0n : current.coinTossIOpen,
      };
    }
    if (readableTag === 'cards' && items.length > 1) {
      const cards = items.slice(1).map((item) => item.toBigInt());
      return placeCards(current, current.gameState.N, cards);
    }
    if (readableTag === 'call' && items.length > 3) {
      const nextN = items[2].toBigInt();
      return nextN > 1n
        ? placeCards(
            current,
            nextN - 1n,
            items.slice(3).map((item) => item.toBigInt()),
          )
        : current;
    }
    return current;
  }

  const units = (value: bigint) => value / current.unitSizeMojos;
  if (readableTag === 'deal' || readableTag === 'pong') {
    return {
      ...current,
      playerHoleCards:
        items.length >= 3 ? [items[1].toBigInt(), items[2].toBigInt()] : current.playerHoleCards,
      playerBoost: items.length >= 4 ? items[3].toBigInt() !== 0n : current.playerBoost,
      coinTossIOpen:
        readableTag === 'pong'
          ? true
          : items.length >= 5
            ? items[4].toBigInt() !== 0n
            : current.coinTossIOpen,
      gameState: { handler: 2n, myTurn: true, N: 4n },
    };
  }
  if (readableTag === 'open' || readableTag === 'raise') {
    const raise = units(items[1].toBigInt());
    let next: SpacepokerHandState = {
      ...current,
      halfPot: units(items[2].toBigInt()),
      lastRaise: raise,
      iRaisedLast: false,
      gameState: { handler: 3n, myTurn: true, N: current.gameState.N },
    };
    if (readableTag === 'open' && items.length > 3) {
      if (current.gameState.N === 4n) {
        next = {
          ...next,
          playerHoleCards: [items[3].toBigInt(), items[4].toBigInt()],
          playerBoost: items[5].toBigInt() !== 0n,
        };
      } else {
        next = placeCards(
          next,
          current.gameState.N,
          items.slice(3).map((item) => item.toBigInt()),
        );
      }
    }
    return appendHistory(next, {
      player: 'opponent',
      action: raise > 0n ? 'raise' : 'check',
      ...(raise > 0n ? { units: raise } : {}),
    });
  }
  if (readableTag === 'call') {
    const nextN = items[2].toBigInt();
    const action = current.lastRaise > 0n ? 'call' : 'check';
    let next: SpacepokerHandState = {
      ...current,
      halfPot: units(items[1].toBigInt()),
      lastRaise: 0n,
      gameState:
        nextN === 1n
          ? { handler: 4n, myTurn: true, N: 1n }
          : { handler: 2n, myTurn: true, N: nextN - 1n },
    };
    if (nextN === 1n && items.length >= 12) {
      const playerCards = bigints(items[3]);
      const opponentCards = bigints(items[5]);
      next = {
        ...next,
        opponentHoleCards: [opponentCards[0], opponentCards[1]],
        opponentBoost: items[6].toBigInt() !== 0n,
        communityCards: playerCards.slice(2, 7),
        outcome: outcomeFrom(items[7], items[8], items[9], items[10], items[11]),
      };
    } else if (nextN > 1n && items.length > 3) {
      next = placeCards(
        next,
        nextN - 1n,
        items.slice(3).map((item) => item.toBigInt()),
      );
    }
    return appendHistory(next, {
      player: 'opponent',
      action,
      ...(action === 'check' ? { endsStreet: true } : {}),
    });
  }
  if (readableTag === 'end' && items.length >= 6) {
    return appendHistory(
      {
        ...current,
        gameState: { handler: 5n, myTurn: false, N: 0n },
        opponentHoleCards:
          items.length > 7 ? [items[6].toBigInt(), items[7].toBigInt()] : current.opponentHoleCards,
        opponentBoost: items.length > 8 ? items[8].toBigInt() !== 0n : current.opponentBoost,
        outcome: outcomeFrom(items[1], items[2], items[3], items[4], items[5]),
        terminalState: 'revealed',
        terminalRecovery: null,
      },
      { player: 'opponent', action: 'reveal' },
    );
  }
  return current;
}

export function reduceSpacepokerDurableState(
  current: SpacepokerHandState | null,
  event: DurableGameStateEvent,
): SpacepokerHandState | null {
  if (event.type === 'abandoned' || event.type === 'remove-group') return null;
  if (event.type === 'accepted-group') {
    if (event.terms.gameType !== 'spacepoker') return current;
    return current ?? initialState(event.isMyTurn, event.terms.unitSizeMojos);
  }
  if (event.type === 'feature-state') {
    const state = spacepokerStateCodec.isState(event.state) ? event.state : null;
    if (state === null) throw new Error('Invalid Space Poker feature-state payload');
    return state;
  }
  if (!current) return null;
  if (event.type === 'local-turn') {
    return {
      ...current,
      gameState: { ...current.gameState, myTurn: event.isMyTurn },
    };
  }
  if (event.type === 'settled') {
    return event.terminal.outcome
      ? reduceSpacepokerSettlementState(current, event.terminal.outcome)
      : current;
  }
  if (event.type !== 'game-status') return current;
  if (!event.readable) {
    return {
      ...current,
      gameState: { ...current.gameState, myTurn: event.status === 'my-turn' },
    };
  }
  const readableEvent = {
    type: event.moverShare === null ? 'game-message' : 'opponent-moved',
    readable: event.readable,
  } as const;
  const next = reduceSpacepokerFeatureState(current, readableEvent);
  return readableEvent.type === 'opponent-moved' ? { ...next, pendingTerminalAction: null } : next;
}

export function validateSpacepokerTerms(terms: TermsFor<'spacepoker'>): boolean {
  return (
    terms.myContribution === terms.theirContribution &&
    terms.myContribution > 0n &&
    terms.gameTimeout > 0n &&
    resolveSpacepokerUnitSize({ terms }) !== null &&
    terms.myContribution % terms.unitSizeMojos === 0n
  );
}

export const spacepokerRegistration: GameFeatureRegistration<'spacepoker', SpacepokerHandState> = {
  gameType: 'spacepoker',
  displayName: 'Space Poker',
  stateCodec: spacepokerStateCodec,
  handMembershipDescription: 'exactly one currentHandGameId',
  validateHandMembership: (gameIds) => gameIds.length === 1,
  decodeFeatureState: (value) => (spacepokerStateCodec.isState(value) ? value : null),
  lifecycle: {
    proposalSenderGoesFirst: (iStarted) => !iStarted,
  },
  compose: {
    defaultDraft: () => ({ unitSize: 1n, stackSize: 10n }),
    draftFromTerms: (terms) => ({
      unitSize: terms.unitSizeMojos,
      stackSize: terms.myContribution / terms.unitSizeMojos,
    }),
    updateDraft: (current, update) => ({ ...current, ...update }),
    toTerms(draft, gameTimeout) {
      if (draft.stackSize > BigInt(Number.MAX_SAFE_INTEGER) || draft.stackSize <= 0n) return null;
      const amount = draft.unitSize * draft.stackSize;
      const terms = {
        gameType: 'spacepoker' as const,
        myContribution: amount,
        theirContribution: amount,
        gameTimeout,
        unitSizeMojos: draft.unitSize,
      };
      return validateSpacepokerTerms(terms) ? terms : null;
    },
  },
  decodeProposalTerms(base, parameterState) {
    const unitSizeMojos = resolveSpacepokerUnitSize({ encodedParameterState: parameterState });
    if (unitSizeMojos === null) return null;
    const terms = { gameType: 'spacepoker' as const, ...base, unitSizeMojos };
    return validateSpacepokerTerms(terms) ? terms : null;
  },
  encodeProposalParameters(terms, iStarted) {
    const unitSizeMojos = resolveSpacepokerUnitSize({ terms });
    if (!unitSizeMojos || !this.validateTerms(terms)) {
      throw new Error('Space Poker proposal requires a valid positive unit size');
    }
    return Program.fromList([
      Program.fromBigInt(terms.myContribution),
      Program.fromBigInt(unitSizeMojos),
      Program.fromBigInt(this.lifecycle.proposalSenderGoesFirst(iStarted) ? 1n : 0n),
    ]);
  },
  validateTerms: validateSpacepokerTerms,
  termsEqual: (a, b) => equalBaseTerms(a, b) && a.unitSizeMojos === b.unitSizeMojos,
  persistence: {
    encodeExtras: (terms) => ({ spacepoker_unit_size: terms.unitSizeMojos.toString() }),
    decodeExtras(base, extras) {
      const raw = extras.spacepoker_unit_size;
      if (raw === undefined) return null;
      try {
        const unitSizeMojos = BigInt(raw);
        const terms = { gameType: 'spacepoker' as const, ...base, unitSizeMojos };
        return validateSpacepokerTerms(terms) ? terms : null;
      } catch {
        return null;
      }
    },
  },
  durableState: {
    reduce: reduceGameStateSnapshot,
    reduceEvent: reduceSpacepokerDurableState,
  },
};
