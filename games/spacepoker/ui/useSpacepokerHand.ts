import { useState, useEffect, useCallback, useRef } from 'react';
import { Program } from 'clvm-lib';
import {
  gameHandState,
  requireLiveGameHandSource,
  type GameHandSource,
  type PersistedGameState,
} from '../../host';
import { useGameHost } from '../../host/ui';
import type { GameTerminalModel, SettlementOutcome } from '../../host';
import {
  spacepokerStateCodec,
  type SpacepokerDisplayMode,
  type SpacepokerHandState,
  type SpGameState,
  type SpHandEntry,
  type SpHandler as SpHandlerType,
  type SpOutcome,
  type SpTerminalState,
} from './serialize';

export type {
  SpacepokerDisplayMode,
  SpacepokerHandState,
  SpGameState,
  SpHandEntry,
  SpOutcome,
  SpTerminalState,
} from './serialize';

type LocalGameCommand =
  | { type: 'make-move'; readable: Program | null }
  | { type: 'accept-settlement' }
  | { type: 'cheat'; moverShare: bigint };

// These mirror the handler names in the Chialisp. The durable reducer advances
// this state for protocol inputs, while accepted local intents commit their
// candidate state through the live game port.
export const SpHandler = {
  CommitA: 0n,
  CommitB: 1n,
  BeginRound: 2n,
  MidRound: 3n,
  End: 4n,
  Showdown: 5n,
  Folded: 6n,
} as const;
export type SpHandler = SpHandlerType;

export function isTerminalSpacepokerHandler(handler: SpHandler): boolean {
  return handler === SpHandler.Showdown || handler === SpHandler.Folded;
}

export interface UseSpacepokerHandResult {
  gameState: SpGameState;
  playerHoleCards: [bigint, bigint] | null;
  playerBoost: boolean;
  opponentHoleCards: [bigint, bigint] | null;
  opponentBoost: boolean | null;
  communityCards: (bigint | null)[];
  pot: bigint;
  playerStack: bigint;
  opponentStack: bigint;
  betUnit: bigint;
  handHistory: SpHandEntry[];
  outcome: SpOutcome | null;
  terminalOutcome: SettlementOutcome | null;
  terminalState: SpTerminalState;
  lastRaise: bigint;
  coinTossIOpen: boolean | null;
  unitSizeMojos: bigint;
  displayMode: SpacepokerDisplayMode;
  setDisplayMode: (mode: SpacepokerDisplayMode) => void;
  formatBet: (units: bigint) => string;

  handleCheck: () => void;
  handleRaise: (units: bigint) => void;
  handleCall: () => void;
  handleFold: () => void;
  handleCheat: () => void;
}

function formatXch(mojos: bigint, xchLabel: string): string {
  const sign = mojos < 0n ? '-' : '';
  const abs = mojos < 0n ? -mojos : mojos;
  const s = abs.toString().padStart(13, '0');
  const whole = s.slice(0, -12).replace(/^0+/, '') || '0';
  const frac = s.slice(-12).replace(/0+$/, '');
  return `${sign}${frac ? `${whole}.${frac}` : whole} ${xchLabel}`;
}

export function useSpacepokerHand(
  handSource: GameHandSource,
  gameId: string,
  betSize: bigint,
  unitSizeMojos: bigint,
  terminal: GameTerminalModel,
): UseSpacepokerHandResult {
  const { currencyLabels } = useGameHost();
  const persistedState = gameHandState(handSource);
  const state = spacepokerStateCodec.decode(persistedState);
  if (!state) throw new Error('Space Poker requires initialized durable game state');
  if (unitSizeMojos <= 0n) throw new Error('Space Poker requires a positive unit size');
  if (state.unitSizeMojos !== unitSizeMojos) {
    throw new Error('Space Poker persisted unit size does not match proposal terms');
  }

  const interactive = handSource.interactionMode === 'live';
  const betUnit = state.unitSizeMojos;
  const stackSize = betSize / betUnit;
  const pot = 2n * state.halfPot + state.lastRaise;
  const playerStack = stackSize - state.halfPot - (state.iRaisedLast ? state.lastRaise : 0n);
  const opponentStack = stackSize - state.halfPot - (state.iRaisedLast ? 0n : state.lastRaise);
  const handSourceRef = useRef(handSource);
  const gameIdRef = useRef(gameId);
  handSourceRef.current = handSource;
  gameIdRef.current = gameId;

  const [terminalDisplayMode, setTerminalDisplayMode] = useState<SpacepokerDisplayMode | null>(
    null,
  );
  const displayMode = interactive ? state.displayMode : (terminalDisplayMode ?? state.displayMode);

  const currentDurableState = useCallback((): SpacepokerHandState => {
    const current = spacepokerStateCodec.decode(gameHandState(handSourceRef.current));
    if (!current) throw new Error('Space Poker requires initialized durable game state');
    return current;
  }, []);

  const commitLocalAction = useCallback(
    (update: (current: SpacepokerHandState) => SpacepokerHandState, command: LocalGameCommand) => {
      const controller = requireLiveGameHandSource(handSourceRef.current);
      const id = gameIdRef.current;
      if (!id) return;
      const next = update(currentDurableState());
      controller.dispatch(
        command.type === 'make-move'
          ? { type: 'make-move', gameId: id, readable: command.readable, state: next }
          : command.type === 'accept-settlement'
            ? { type: 'accept-settlement', gameId: id, state: next }
            : { type: 'cheat', gameId: id, moverShare: command.moverShare, state: next },
      );
    },
    [currentDurableState],
  );

  const setDisplayMode = useCallback(
    (mode: SpacepokerDisplayMode) => {
      if (handSourceRef.current.interactionMode === 'terminal') {
        setTerminalDisplayMode(mode);
        return;
      }
      const controller = requireLiveGameHandSource(handSourceRef.current);
      const current = currentDurableState();
      controller.dispatch({
        type: 'update-local-state',
        state: { ...current, displayMode: mode },
      });
    },
    [currentDurableState],
  );

  const autoFiredSnapshotRef = useRef<Readonly<PersistedGameState> | null>(null);
  useEffect(() => {
    if (!interactive || !persistedState || terminal.type !== 'none') return;
    if (state.terminalState !== 'none' || isTerminalSpacepokerHandler(state.gameState.handler))
      return;
    const { handler, myTurn, N } = state.gameState;
    if (!myTurn || !requireLiveGameHandSource(handSourceRef.current).isChannelReady()) return;

    const submitOnce = (
      update: (current: SpacepokerHandState) => SpacepokerHandState,
      command: LocalGameCommand,
    ) => {
      if (autoFiredSnapshotRef.current === persistedState) return;
      autoFiredSnapshotRef.current = persistedState;
      commitLocalAction(update, command);
    };

    if (handler === SpHandler.CommitA || handler === SpHandler.CommitB) {
      submitOnce(
        (current) => ({ ...current, gameState: { ...current.gameState, myTurn: false } }),
        {
          type: 'make-move',
          readable: null,
        },
      );
      return;
    }
    if (handler === SpHandler.BeginRound && N === 4n && state.coinTossIOpen === false) {
      submitOnce(
        (current) => ({ ...current, gameState: { ...current.gameState, myTurn: false } }),
        {
          type: 'make-move',
          readable: null,
        },
      );
      return;
    }
    if (
      (handler === SpHandler.BeginRound || handler === SpHandler.MidRound) &&
      state.lastRaise === 0n &&
      playerStack <= 0n
    ) {
      if (handler === SpHandler.BeginRound) {
        submitOnce(
          (current) => ({
            ...current,
            gameState: { handler: SpHandler.MidRound, myTurn: false, N },
            handHistory: [...current.handHistory, { player: 'you', action: 'check' }],
          }),
          { type: 'make-move', readable: Program.fromBigInt(0n) },
        );
      } else {
        submitOnce(
          (current) => ({
            ...current,
            gameState:
              N === 1n
                ? { handler: SpHandler.End, myTurn: false, N: 1n }
                : { handler: SpHandler.BeginRound, myTurn: false, N: N - 1n },
            halfPot: current.halfPot + current.lastRaise,
            lastRaise: 0n,
            handHistory: [
              ...current.handHistory,
              { player: 'you', action: 'check', endsStreet: true },
            ],
          }),
          { type: 'make-move', readable: null },
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
            handHistory: [...current.handHistory, { player: 'you', action: 'reveal' }],
            terminalState: 'revealed',
          }),
          { type: 'make-move', readable: null },
        );
      } else {
        submitOnce(
          (current) => ({
            ...current,
            gameState: { handler: SpHandler.Showdown, myTurn: false, N },
            handHistory: [...current.handHistory, { player: 'you', action: 'concede' }],
            terminalState: 'conceded-by-you',
          }),
          { type: 'accept-settlement' },
        );
      }
    }
  }, [commitLocalAction, interactive, persistedState, playerStack, state, terminal.type]);

  const handleCheck = useCallback(() => {
    commitLocalAction(
      (current) => ({
        ...current,
        gameState: { handler: SpHandler.MidRound, myTurn: false, N: current.gameState.N },
        handHistory: [...current.handHistory, { player: 'you', action: 'check' }],
      }),
      { type: 'make-move', readable: Program.fromBigInt(0n) },
    );
  }, [commitLocalAction]);

  const handleRaise = useCallback(
    (units: bigint) => {
      commitLocalAction(
        (current) => ({
          ...current,
          gameState: { handler: SpHandler.MidRound, myTurn: false, N: current.gameState.N },
          halfPot: current.halfPot + current.lastRaise,
          lastRaise: units,
          iRaisedLast: true,
          handHistory: [...current.handHistory, { player: 'you', action: 'raise', units }],
        }),
        { type: 'make-move', readable: Program.fromBigInt(units * betUnit) },
      );
    },
    [betUnit, commitLocalAction],
  );

  const handleCall = useCallback(() => {
    commitLocalAction(
      (current) => {
        const action = current.lastRaise > 0n ? 'call' : 'check';
        return {
          ...current,
          gameState:
            current.gameState.N === 1n
              ? { handler: SpHandler.End, myTurn: false, N: 1n }
              : { handler: SpHandler.BeginRound, myTurn: false, N: current.gameState.N - 1n },
          halfPot: current.halfPot + current.lastRaise,
          lastRaise: 0n,
          handHistory: [
            ...current.handHistory,
            { player: 'you', action, ...(action === 'check' ? { endsStreet: true } : {}) },
          ],
          outcome: current.gameState.N === 1n ? null : current.outcome,
        };
      },
      { type: 'make-move', readable: null },
    );
  }, [commitLocalAction]);

  const handleFold = useCallback(() => {
    commitLocalAction(
      (current) => ({
        ...current,
        gameState: { handler: SpHandler.Folded, myTurn: false, N: current.gameState.N },
        handHistory: [...current.handHistory, { player: 'you', action: 'fold' }],
        terminalState: 'folded-by-you',
      }),
      { type: 'accept-settlement' },
    );
  }, [commitLocalAction]);

  const handleCheat = useCallback(() => {
    commitLocalAction(
      (current) => ({ ...current, gameState: { ...current.gameState, myTurn: false } }),
      { type: 'cheat', moverShare: 0n },
    );
  }, [commitLocalAction]);

  const formatBet = useCallback(
    (units: bigint): string => {
      if (displayMode === 'units') return String(units);
      const mojos = units * betUnit;
      if (displayMode === 'mojos') return `${mojos.toLocaleString()} ${currencyLabels.mojos}`;
      return formatXch(mojos, currencyLabels.xch);
    },
    [betUnit, currencyLabels, displayMode],
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
    terminalOutcome: terminal.outcome,
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
    handleCheat,
  };
}
