import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Program } from 'clvm-lib';
import { Observable } from 'rxjs';
import { GameplayEvent } from '../../hooks/useGameSession';
import { requireLiveGameHandSource, type GameHandSource } from '../../lib/gameMount';
import { getCurrencyLabels } from '../../constants/currency';
import type { PersistedGameState } from '../../lib/session/gameStateCodec';
import type { GameTerminalModel } from '../../lib/session/types';
import type { StateUpdate } from '../../lib/gameAdapter';
import type { LocalGameCommand } from '../../lib/session/sessionMachineTypes';
import { type SettlementOutcome } from '../../lib/settlement';
import { reduceSpacepokerFeatureState, reduceSpacepokerSettlementState } from './adapter';
import {
  spacepokerStateCodec,
  type SpacepokerDisplayMode,
  type SpacepokerHandState,
  type PendingSpacepokerTerminalAction,
  type SpGameState,
  type SpHandEntry,
  type SpHandler as SpHandlerType,
  type SpOutcome,
  type SpTerminalState,
} from './stateCodec';

export type {
  SpacepokerDisplayMode,
  SpacepokerHandState,
  PendingSpacepokerTerminalAction,
  SpGameState,
  SpHandEntry,
  SpOutcome,
  SpTerminalState,
} from './stateCodec';
const SPACEPOKER_XCH_DISPLAY_THRESHOLD_MOJOS = 1_000_000n;

// These mirror the handler names in the Chialisp. The UX tracks which
// handler is currently active; every OpponentMoved advances it to the
// next state in the sequence. myTurn is implicit: an OpponentMoved
// means it's now my turn; a makeMove means it's now theirs.
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

export function opponentTerminalAction(state: SpGameState): 'fold' | 'concede' | null {
  if (state.handler === SpHandler.MidRound && !state.myTurn) return 'fold';
  // We are waiting for the opponent's final move. If settlement arrives
  // without an `end` readable, they chose the no-reveal (flag) action.
  if (state.handler === SpHandler.End && !state.myTurn) return 'concede';
  return null;
}

export function voluntarySpacepokerSettlementAction(
  outcome: SettlementOutcome,
  state: SpGameState,
): { player: 'you' | 'opponent'; action: 'fold' | 'concede' } | null {
  if (outcome !== 'accept_settlement' && outcome !== 'we_accepted') return null;
  const action =
    state.handler === SpHandler.MidRound
      ? 'fold'
      : state.handler === SpHandler.End
        ? 'concede'
        : null;
  if (!action) return null;
  return {
    player: outcome === 'we_accepted' || state.myTurn ? 'you' : 'opponent',
    action,
  };
}

export function pendingTerminalActionMatchesFailure(
  pending: PendingSpacepokerTerminalAction | null,
  submission: 'make-move' | 'accept-settlement' | undefined,
): pending is PendingSpacepokerTerminalAction {
  return pending != null && pending.submission === submission;
}

export function retainsRevealedTerminalPresentation(
  pending: PendingSpacepokerTerminalAction | null,
  terminalState: SpTerminalState,
  outcome: SettlementOutcome,
): boolean {
  const voluntaryAcknowledgement = outcome === 'accept_settlement' || outcome === 'we_accepted';
  return voluntaryAcknowledgement && (pending?.action === 'reveal' || terminalState === 'revealed');
}

export function retainsVoluntaryTerminalPresentation(
  terminalState: SpTerminalState,
  outcome: SettlementOutcome,
): boolean {
  const voluntaryAcknowledgement = outcome === 'accept_settlement' || outcome === 'we_accepted';
  return (
    voluntaryAcknowledgement &&
    (terminalState === 'folded-by-you' ||
      terminalState === 'folded-by-opponent' ||
      terminalState === 'conceded-by-you' ||
      terminalState === 'conceded-by-opponent')
  );
}

export function terminalAutoSubmissionAllowed(
  recovery: 'fold' | 'concede' | 'reveal' | null,
): boolean {
  return recovery == null;
}

export function terminalRecoveryAfterOpponentMove(
  recovery: 'concede' | 'reveal' | null,
  completesTerminalAction: boolean,
): 'concede' | 'reveal' | null {
  return completesTerminalAction ? null : recovery;
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
  terminalRecovery: 'concede' | 'reveal' | null;
  retryTerminalAction: () => void;
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

export function acceptedSettlementFromOpponent(handler: SpHandler): {
  action: 'fold' | 'concede';
  terminalState: SpTerminalState;
  nextHandler: SpHandler;
} {
  if (handler === SpHandler.End) {
    return {
      action: 'concede',
      terminalState: 'conceded-by-opponent',
      nextHandler: SpHandler.Showdown,
    };
  }
  return {
    action: 'fold',
    terminalState: 'folded-by-opponent',
    nextHandler: SpHandler.Folded,
  };
}

function defaultDisplayModeForUnit(unitSizeMojos: bigint): SpacepokerDisplayMode {
  return unitSizeMojos > SPACEPOKER_XCH_DISPLAY_THRESHOLD_MOJOS ? 'xch' : 'mojos';
}

function formatXch(mojos: bigint): string {
  const sign = mojos < 0n ? '-' : '';
  const abs = mojos < 0n ? -mojos : mojos;
  const s = abs.toString().padStart(13, '0');
  const whole = s.slice(0, -12).replace(/^0+/, '') || '0';
  const frac = s.slice(-12).replace(/0+$/, '');
  return `${sign}${frac ? `${whole}.${frac}` : whole} ${getCurrencyLabels().xch}`;
}

export function rollbackOptimisticTerminalHistory(
  history: SpHandEntry[],
  action: 'fold' | 'concede' | 'reveal',
): SpHandEntry[] {
  const last = history[history.length - 1];
  return last?.player === 'you' && last.action === action ? history.slice(0, -1) : history;
}

export function reconcilePendingTerminalHistory(
  history: SpHandEntry[],
  action: 'fold' | 'concede' | 'reveal' | null,
  outcome: SettlementOutcome,
): SpHandEntry[] {
  if (action === null) return history;
  const confirmed =
    outcome === 'accept_settlement' ||
    outcome === 'we_accepted' ||
    (action === 'reveal' && outcome === 'settled_cleanly');
  if (confirmed) return history;
  if (action === 'reveal') {
    const last = history[history.length - 1];
    if (last?.player === 'you' && last.action === 'reveal') {
      return [...history.slice(0, -1), { player: 'you', action: 'failed' }];
    }
  }
  return rollbackOptimisticTerminalHistory(history, action);
}

function spacepokerStateFromPersisted(
  persisted: Readonly<PersistedGameState> | null | undefined,
): SpacepokerHandState | undefined {
  return spacepokerStateCodec.decode(persisted) ?? undefined;
}

export function useSpacepokerHand(
  handSource: GameHandSource,
  _gameId: string,
  _iStarted: boolean,
  gameplayEvent$: Observable<GameplayEvent>,
  betSize: bigint,
  unitSizeMojos: bigint,
  onTurnChanged: (isMyTurn: boolean) => void,
  terminal: GameTerminalModel,
  initialPersistedState?: Readonly<PersistedGameState>,
): UseSpacepokerHandResult {
  const interactive = handSource.interactionMode === 'live';
  if (unitSizeMojos <= 0n) {
    throw new Error('Space Poker requires a positive unit size');
  }
  const fallbackDisplayMode = defaultDisplayModeForUnit(unitSizeMojos);
  const [initialHandState] = useState(() => spacepokerStateFromPersisted(initialPersistedState));
  if (initialHandState && initialHandState.unitSizeMojos !== unitSizeMojos) {
    throw new Error('Space Poker persisted unit size does not match proposal terms');
  }
  const [betUnit] = useState(initialHandState?.unitSizeMojos ?? unitSizeMojos);
  const stackSize = betUnit > 0n ? betSize / betUnit : 0n;
  const anteUnits = 1n;

  // The game always starts with CommitA as the first my-turn handler
  // for whoever goes first. The protocol tells us via the first
  // OpponentMoved whether we go first or second — we don't need to
  // remember iStarted. Start with myTurn=false and let the first event
  // (either OpponentMoved giving us the turn, or the auto-play effect
  // for commitA) sort it out.
  //
  // Actually: the protocol fires the first my-turn handler immediately
  // after proposal acceptance, before any OpponentMoved arrives. So
  // the auto-play effect for CommitA needs to fire. We set myTurn
  // based on iStarted just for the initial commitA, but after that the
  // state is driven entirely by events.
  const [gs, setGsRaw] = useState<SpGameState>(
    initialHandState?.gameState ?? {
      handler: SpHandler.CommitA,
      myTurn: !_iStarted,
      N: 4n,
    },
  );
  const [playerHoleCards, setPlayerHoleCardsRaw] = useState<[bigint, bigint] | null>(
    initialHandState?.playerHoleCards ?? null,
  );
  const [playerBoost, setPlayerBoostRaw] = useState(initialHandState?.playerBoost ?? false);
  const [opponentHoleCards, setOpponentHoleCardsRaw] = useState<[bigint, bigint] | null>(
    initialHandState?.opponentHoleCards ?? null,
  );
  const [opponentBoost, setOpponentBoostRaw] = useState<boolean | null>(
    initialHandState?.opponentBoost ?? null,
  );
  const [communityCards, setCommunityCardsRaw] = useState<(bigint | null)[]>(
    initialHandState?.communityCards ?? [null, null, null, null, null],
  );
  const [halfPot, setHalfPotRaw] = useState(initialHandState?.halfPot ?? anteUnits);
  const [lastRaise, setLastRaiseRaw] = useState(initialHandState?.lastRaise ?? 0n);
  const [iRaisedLast, setIRaisedLastRaw] = useState(initialHandState?.iRaisedLast ?? false);
  const [handHistory, setHandHistoryRaw] = useState<SpHandEntry[]>(
    initialHandState?.handHistory ?? [],
  );
  const [outcome, setOutcomeRaw] = useState<SpOutcome | null>(initialHandState?.outcome ?? null);
  const [terminalState, setTerminalStateRaw] = useState<SpTerminalState>(
    initialHandState?.terminalState ?? 'none',
  );
  const [terminalRecovery, setTerminalRecoveryRaw] = useState<'concede' | 'reveal' | null>(
    initialHandState?.terminalRecovery ?? null,
  );
  // Coin toss result: true = I open, false = opponent opens, null = not yet known
  const [coinTossIOpen, setCoinTossIOpenRaw] = useState<boolean | null>(
    initialHandState?.coinTossIOpen ?? null,
  );
  const [displayMode, setDisplayModeRaw] = useState<SpacepokerDisplayMode>(
    initialHandState?.displayMode ?? fallbackDisplayMode,
  );

  const pot = 2n * halfPot + lastRaise;
  const playerStack = stackSize - halfPot - (iRaisedLast ? lastRaise : 0n);
  const opponentStack = stackSize - halfPot - (iRaisedLast ? 0n : lastRaise);

  const gsRef = useRef(gs);
  const handSourceRef = useRef(handSource);
  const gameIdRef = useRef(_gameId);
  const handFinishedRef = useRef(
    initialHandState?.gameState.handler === SpHandler.Showdown ||
      initialHandState?.gameState.handler === SpHandler.Folded ||
      (initialHandState?.terminalState != null && initialHandState.terminalState !== 'none'),
  );
  const coinTossIOpenRef = useRef(coinTossIOpen);
  const communityCardsRef = useRef(communityCards);
  const lastRaiseRef = useRef(lastRaise);
  const outcomeRef = useRef(outcome);
  const terminalStateRef = useRef(terminalState);
  const terminalActionByUsRef = useRef<'fold' | 'concede' | 'reveal' | null>(null);
  const terminalActionByOpponentRef = useRef<'fold' | 'concede' | 'reveal' | null>(null);
  const terminalClosureRef = useRef(false);
  const halfPotRef = useRef(halfPot);
  const iRaisedLastRef = useRef(iRaisedLast);
  const handHistoryRef = useRef(handHistory);
  const stateRef = useRef<SpacepokerHandState>(
    initialHandState ?? {
      gameState: gs,
      playerHoleCards,
      playerBoost,
      opponentHoleCards,
      opponentBoost,
      communityCards,
      halfPot,
      lastRaise,
      iRaisedLast,
      handHistory,
      outcome,
      terminalState,
      terminalRecovery,
      pendingTerminalAction: null,
      coinTossIOpen,
      unitSizeMojos: betUnit,
      displayMode,
    },
  );

  gsRef.current = gs;
  handSourceRef.current = handSource;
  gameIdRef.current = _gameId;
  coinTossIOpenRef.current = coinTossIOpen;
  communityCardsRef.current = communityCards;
  lastRaiseRef.current = lastRaise;
  halfPotRef.current = halfPot;
  iRaisedLastRef.current = iRaisedLast;
  handHistoryRef.current = handHistory;
  terminalStateRef.current = terminalState;

  const projectState = useCallback((next: SpacepokerHandState) => {
    stateRef.current = next;
    gsRef.current = next.gameState;
    coinTossIOpenRef.current = next.coinTossIOpen;
    communityCardsRef.current = next.communityCards;
    lastRaiseRef.current = next.lastRaise;
    halfPotRef.current = next.halfPot;
    iRaisedLastRef.current = next.iRaisedLast;
    handHistoryRef.current = next.handHistory;
    outcomeRef.current = next.outcome;
    terminalStateRef.current = next.terminalState ?? 'none';
    setGsRaw(next.gameState);
    setPlayerHoleCardsRaw(next.playerHoleCards);
    setPlayerBoostRaw(next.playerBoost);
    setOpponentHoleCardsRaw(next.opponentHoleCards);
    setOpponentBoostRaw(next.opponentBoost);
    setCommunityCardsRaw(next.communityCards);
    setHalfPotRaw(next.halfPot);
    setLastRaiseRaw(next.lastRaise);
    setIRaisedLastRaw(next.iRaisedLast);
    setHandHistoryRaw(next.handHistory);
    setOutcomeRaw(next.outcome);
    setTerminalStateRaw(next.terminalState ?? 'none');
    setTerminalRecoveryRaw(next.terminalRecovery ?? null);
    setCoinTossIOpenRaw(next.coinTossIOpen);
    setDisplayModeRaw(next.displayMode);
  }, []);

  const commitState = useCallback(
    (update: (current: SpacepokerHandState) => SpacepokerHandState): boolean => {
      const controller = requireLiveGameHandSource(handSourceRef.current);
      const next = update(stateRef.current);
      if (!controller.transitionFeatureState('spacepoker', gameIdRef.current, next)) {
        return false;
      }
      projectState(next);
      return true;
    },
    [projectState],
  );
  const setters = useMemo(() => {
    const propertySetter =
      <K extends keyof SpacepokerHandState>(key: K) =>
      (update: StateUpdate<SpacepokerHandState[K]>) =>
        commitState((current) => ({
          ...current,
          [key]:
            typeof update === 'function'
              ? (update as (value: SpacepokerHandState[K]) => SpacepokerHandState[K])(current[key])
              : update,
        }));
    return {
      setTerminalRecovery: propertySetter('terminalRecovery'),
    };
  }, [commitState]);
  const { setTerminalRecovery } = setters;
  const setDisplayMode = useCallback(
    (update: StateUpdate<SpacepokerDisplayMode>) => {
      if (handSourceRef.current.interactionMode === 'live') {
        return commitState((current) => ({
          ...current,
          displayMode:
            typeof update === 'function'
              ? (update as (value: SpacepokerDisplayMode) => SpacepokerDisplayMode)(
                  current.displayMode,
                )
              : update,
        }));
      }
      const current = stateRef.current;
      const next =
        typeof update === 'function'
          ? (update as (value: SpacepokerDisplayMode) => SpacepokerDisplayMode)(current.displayMode)
          : update;
      stateRef.current = { ...current, displayMode: next };
      setDisplayModeRaw(next);
      return true;
    },
    [commitState],
  );

  const commitActionState = useCallback(
    (update: (current: SpacepokerHandState) => SpacepokerHandState): boolean => {
      const controller = requireLiveGameHandSource(handSourceRef.current);
      const next = update(stateRef.current);
      if (
        !controller.transitionFeatureStateWithLocalTurn(
          'spacepoker',
          gameIdRef.current,
          next,
          next.gameState.myTurn,
        )
      ) {
        return false;
      }
      projectState(next);
      return true;
    },
    [projectState],
  );

  const commitLocalAction = useCallback(
    (
      update: (current: SpacepokerHandState) => SpacepokerHandState,
      command: LocalGameCommand,
    ): SpacepokerHandState | null => {
      const controller = requireLiveGameHandSource(handSourceRef.current);
      const next = update(stateRef.current);
      controller.commitLocalGameAction({
        gameType: 'spacepoker',
        id: gameIdRef.current,
        state: next,
        command,
      });
      projectState(next);
      return next;
    },
    [projectState],
  );

  const rollbackPendingTerminalAction = useCallback(
    (submission: 'make-move' | 'accept-settlement'): boolean => {
      const pending = stateRef.current.pendingTerminalAction;
      if (!pendingTerminalActionMatchesFailure(pending, submission)) return false;
      const committed = commitActionState((current) => ({
        ...current,
        gameState: pending.previousGameState,
        handHistory: rollbackOptimisticTerminalHistory(current.handHistory, pending.action),
        terminalState: pending.previousTerminalState,
        terminalRecovery: pending.action === 'fold' ? null : pending.action,
        pendingTerminalAction: null,
      }));
      if (!committed) return false;
      terminalClosureRef.current = false;
      handFinishedRef.current = false;
      terminalActionByUsRef.current = null;
      return true;
    },
    [commitActionState],
  );

  const replaceWithGenericTerminalClosure = useCallback(
    (_outcome: SettlementOutcome | null, current: SpGameState) => {
      const pending = stateRef.current.pendingTerminalAction;
      terminalClosureRef.current = true;
      terminalActionByUsRef.current = null;
      terminalActionByOpponentRef.current = null;
      handFinishedRef.current = true;
      const state = stateRef.current;
      projectState({
        ...state,
        gameState: { handler: SpHandler.Folded, myTurn: false, N: current.N },
        handHistory: pending
          ? rollbackOptimisticTerminalHistory(state.handHistory, pending.action)
          : state.handHistory,
        pendingTerminalAction: null,
        outcome: null,
        terminalState: 'settled',
        terminalRecovery: null,
      });
      onTurnChanged(false);
    },
    [onTurnChanged, projectState],
  );

  const applySettlement = useCallback(
    (outcome: SettlementOutcome) => {
      const pending = stateRef.current.pendingTerminalAction;
      handFinishedRef.current = true;
      terminalClosureRef.current = true;
      terminalActionByUsRef.current = null;
      terminalActionByOpponentRef.current = null;
      const current = {
        ...stateRef.current,
        handHistory: reconcilePendingTerminalHistory(
          stateRef.current.handHistory,
          pending?.action ?? null,
          outcome,
        ),
      };
      const next = reduceSpacepokerSettlementState(current, outcome);
      outcomeRef.current = next.outcome;
      projectState(next);
      onTurnChanged(false);
    },
    [onTurnChanged, projectState],
  );

  // ── OpponentMoved: the opponent made a move, it's now my turn ──
  // Dispatch based on the readable tag. The tag tells us what the
  // handler computed; it's the single source of truth for what happened.
  useEffect(() => {
    if (!interactive) return;
    const sub = gameplayEvent$.subscribe({
      next: (evt: GameplayEvent) => {
        if (terminalClosureRef.current) return;
        if ('Settled' in evt) {
          if (evt.Settled.gameId !== gameIdRef.current) return;
          applySettlement(evt.Settled.outcome);
          return;
        }
        if ('MoveRejected' in evt) {
          if (evt.MoveRejected.gameId !== gameIdRef.current) return;
          rollbackPendingTerminalAction('make-move');
          return;
        }
        if ('GameError' in evt) {
          if (evt.GameError.gameId !== gameIdRef.current) return;
          if (
            evt.GameError.source === 'action' &&
            evt.GameError.action &&
            rollbackPendingTerminalAction(evt.GameError.action)
          ) {
            return;
          }
          if (evt.GameError.source === 'terminal') {
            replaceWithGenericTerminalClosure(null, gsRef.current);
          }
          return;
        }
        if (handFinishedRef.current) return;

        if ('OpponentMoved' in evt) {
          if (evt.OpponentMoved.gameId && evt.OpponentMoved.gameId !== gameIdRef.current) return;
          const next = {
            ...reduceSpacepokerFeatureState(stateRef.current, {
              type: 'opponent-moved',
              readable: Uint8Array.from(evt.OpponentMoved.readable),
            }),
            pendingTerminalAction: null,
          };
          if (next.gameState.handler === SpHandler.Showdown) {
            handFinishedRef.current = true;
            terminalActionByOpponentRef.current = 'reveal';
          }
          outcomeRef.current = next.outcome;
          projectState(next);
          onTurnChanged(next.gameState.myTurn);
        } else if ('GameMessage' in evt) {
          if (evt.GameMessage.gameId && evt.GameMessage.gameId !== gameIdRef.current) return;
          projectState(
            reduceSpacepokerFeatureState(stateRef.current, {
              type: 'game-message',
              readable: Uint8Array.from(evt.GameMessage.readable),
            }),
          );
        }
      },
    });

    return () => sub.unsubscribe();
  }, [
    gameplayEvent$,
    interactive,
    onTurnChanged,
    applySettlement,
    projectState,
    replaceWithGenericTerminalClosure,
    rollbackPendingTerminalAction,
  ]);

  // ── Auto-play: moves that don't need user input ──
  // CommitA, CommitB: always auto-play nil.
  // BeginRound N=4 when coin toss says opponent opens: auto-play nil (pong).
  // BeginRound/MidRound all-in checks: auto-play only when there is no
  // outstanding raise and we have no remaining raise capacity.
  // End: auto-play reveal or game-level accept.
  useEffect(() => {
    if (!interactive) return;
    if (handFinishedRef.current) return;
    if (!terminalAutoSubmissionAllowed(terminalRecovery)) return;
    const { handler, myTurn, N } = gs;
    if (!myTurn) return;
    const controller = requireLiveGameHandSource(handSourceRef.current);
    const gid = gameIdRef.current;
    if (!gid) return;
    if (!controller.isChannelReady()) return;

    if (handler === SpHandler.CommitA || handler === SpHandler.CommitB) {
      commitLocalAction((current) => ({ ...current, gameState: { ...gs, myTurn: false } }), {
        type: 'make-move',
        readable: null,
      });
      return;
    }

    if (handler === SpHandler.BeginRound && N === 4n && coinTossIOpen === false) {
      commitLocalAction((current) => ({ ...current, gameState: { ...gs, myTurn: false } }), {
        type: 'make-move',
        readable: null,
      });
      return;
    }

    if (
      (handler === SpHandler.BeginRound || handler === SpHandler.MidRound) &&
      lastRaise === 0n &&
      playerStack <= 0n
    ) {
      if (handler === SpHandler.BeginRound) {
        commitLocalAction(
          (current) => ({
            ...current,
            gameState: { handler: SpHandler.MidRound, myTurn: false, N },
            handHistory: [...current.handHistory, { player: 'you', action: 'check' }],
          }),
          { type: 'make-move', readable: Program.fromBigInt(0n) },
        );
      } else {
        const next =
          N === 1n
            ? { handler: SpHandler.End, myTurn: false, N: 1n }
            : { handler: SpHandler.BeginRound, myTurn: false, N: N - 1n };
        commitLocalAction(
          (current) => ({
            ...current,
            gameState: next,
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

    if (handler === SpHandler.End) {
      const currentOutcome = outcomeRef.current;
      if (!currentOutcome) return;
      const action = currentOutcome.result >= 0n ? 'reveal' : 'accept';
      const optimisticHistoryAction = action === 'reveal' ? 'reveal' : 'concede';
      const previousTerminalState = terminalState;
      const pending: PendingSpacepokerTerminalAction = {
        action: optimisticHistoryAction,
        submission: action === 'reveal' ? 'make-move' : 'accept-settlement',
        previousTerminalState,
        previousGameState: gs,
      };
      if (action === 'reveal') {
        const committed = commitLocalAction(
          (current) => ({
            ...current,
            gameState: { handler: SpHandler.Showdown, myTurn: false, N },
            handHistory: [...current.handHistory, { player: 'you', action: 'reveal' }],
            terminalState: 'revealed',
            pendingTerminalAction: pending,
          }),
          { type: 'make-move', readable: null },
        );
        if (!committed) return;
        terminalActionByUsRef.current = 'reveal';
      } else {
        const committed = commitLocalAction(
          (current) => ({
            ...current,
            gameState: { handler: SpHandler.Showdown, myTurn: false, N },
            handHistory: [...current.handHistory, { player: 'you', action: 'concede' }],
            terminalState: 'conceded-by-you',
            pendingTerminalAction: pending,
          }),
          { type: 'accept-settlement' },
        );
        if (!committed) return;
        terminalActionByUsRef.current = 'concede';
      }
      handFinishedRef.current = true;
      return;
    }
  }, [
    gs,
    interactive,
    outcome,
    coinTossIOpen,
    lastRaise,
    playerStack,
    terminalState,
    terminalRecovery,
    commitLocalAction,
  ]);

  const retryTerminalAction = useCallback(() => {
    if (terminalRecovery != null) setTerminalRecovery(null);
  }, [setTerminalRecovery, terminalRecovery]);

  const handleCheck = useCallback(() => {
    requireLiveGameHandSource(handSourceRef.current);
    const gid = gameIdRef.current;
    if (!gid) return;
    commitLocalAction(
      (state) => ({
        ...state,
        gameState: { handler: SpHandler.MidRound, myTurn: false, N: state.gameState.N },
        handHistory: [...state.handHistory, { player: 'you', action: 'check' }],
      }),
      { type: 'make-move', readable: Program.fromBigInt(0n) },
    );
  }, [commitLocalAction]);

  const handleRaise = useCallback(
    (units: bigint) => {
      requireLiveGameHandSource(handSourceRef.current);
      const gid = gameIdRef.current;
      if (!gid) return;
      const mojoAmount = units * betUnit;
      commitLocalAction(
        (state) => ({
          ...state,
          gameState: { handler: SpHandler.MidRound, myTurn: false, N: state.gameState.N },
          halfPot: state.halfPot + state.lastRaise,
          lastRaise: units,
          iRaisedLast: true,
          handHistory: [...state.handHistory, { player: 'you', action: 'raise', units }],
        }),
        { type: 'make-move', readable: Program.fromBigInt(mojoAmount) },
      );
    },
    [betUnit, commitLocalAction],
  );

  const handleCall = useCallback(() => {
    requireLiveGameHandSource(handSourceRef.current);
    const gid = gameIdRef.current;
    if (!gid) return;
    const current = stateRef.current;
    const next =
      current.gameState.N === 1n
        ? { handler: SpHandler.End, myTurn: false, N: 1n }
        : {
            handler: SpHandler.BeginRound,
            myTurn: false,
            N: current.gameState.N - 1n,
          };
    const action = current.lastRaise > 0n ? 'call' : 'check';
    commitLocalAction(
      (state) => ({
        ...state,
        gameState: next,
        halfPot: state.halfPot + state.lastRaise,
        lastRaise: 0n,
        handHistory: [
          ...state.handHistory,
          {
            player: 'you',
            action,
            ...(action === 'check' ? { endsStreet: true } : {}),
          },
        ],
        outcome: current.gameState.N === 1n ? null : state.outcome,
      }),
      { type: 'make-move', readable: null },
    );
  }, [commitLocalAction]);

  const handleFold = useCallback(() => {
    requireLiveGameHandSource(handSourceRef.current);
    const gid = gameIdRef.current;
    if (!gid) return;
    const current = stateRef.current;
    // "Fold" is a UX betting action. Protocol-wise this accepts the current
    // settlement; Space Poker has no fold move in its handlers or validators.
    const previousTerminalState = terminalState;
    const pending: PendingSpacepokerTerminalAction = {
      action: 'fold',
      submission: 'accept-settlement',
      previousTerminalState,
      previousGameState: current.gameState,
    };
    const committed = commitLocalAction(
      (state) => ({
        ...state,
        gameState: {
          handler: SpHandler.Folded,
          myTurn: false,
          N: state.gameState.N,
        },
        handHistory: [...state.handHistory, { player: 'you', action: 'fold' }],
        terminalState: 'folded-by-you',
        pendingTerminalAction: pending,
      }),
      { type: 'accept-settlement' },
    );
    if (!committed) return;
    handFinishedRef.current = true;
    terminalActionByUsRef.current = 'fold';
  }, [commitLocalAction, terminalState]);

  const handleCheat = useCallback(() => {
    requireLiveGameHandSource(handSourceRef.current);
    const gid = gameIdRef.current;
    if (!gid) return;
    commitLocalAction(
      (state) => ({
        ...state,
        gameState: { ...state.gameState, myTurn: false },
      }),
      { type: 'cheat', moverShare: 0n },
    );
  }, [commitLocalAction]);

  const formatBet = useCallback(
    (units: bigint): string => {
      if (displayMode === 'units') return String(units);
      const mojos = units * betUnit;
      if (displayMode === 'mojos') return `${mojos.toLocaleString()} ${getCurrencyLabels().mojos}`;
      return formatXch(mojos);
    },
    [betUnit, displayMode],
  );

  return {
    gameState: gs,
    playerHoleCards,
    playerBoost,
    opponentHoleCards,
    opponentBoost,
    communityCards,
    pot,
    playerStack,
    opponentStack,
    betUnit,
    handHistory,
    outcome,
    terminalOutcome: terminal.outcome,
    terminalState,
    terminalRecovery,
    retryTerminalAction,
    lastRaise,
    coinTossIOpen,
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
