import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Program } from 'clvm-lib';
import { Observable } from 'rxjs';
import { SessionController } from '../../hooks/SessionController';
import { GameplayEvent } from '../../hooks/useGameSession';
import { PersistedGameState } from '../../hooks/save';
import { type SettlementOutcome } from '../../lib/settlement';

const SPACEPOKER_PERSISTED_STATE_VERSION = 1n;
const SPACEPOKER_XCH_DISPLAY_THRESHOLD_MOJOS = 1_000_000n;

export type SpacepokerDisplayMode = 'xch' | 'mojos' | 'units';

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
export type SpHandler = (typeof SpHandler)[keyof typeof SpHandler];

export function isTerminalSpacepokerHandler(handler: SpHandler): boolean {
  return handler === SpHandler.Showdown || handler === SpHandler.Folded;
}

export interface SpGameState {
  handler: SpHandler;
  myTurn: boolean;
  N: bigint;
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

export interface SpHandEntry {
  player: 'you' | 'opponent';
  // 'reveal' is the final showdown reveal — the phantom end-of-hand move where
  // the second player to act opens their cards (done when they win or chop).
  // 'fold' is a betting-round fold. 'concede' is a showdown concede (the second
  // player declines to reveal because they would lose).
  action: 'check' | 'raise' | 'call' | 'fold' | 'concede' | 'reveal';
  units?: bigint;
  endsStreet?: boolean;
}

export interface SpOutcome {
  result: bigint;
  playerHandCards: bigint[];
  playerHandEval: bigint[];
  opponentHandCards: bigint[] | null;
  opponentHandEval: bigint[] | null;
}

export type SpTerminalState =
  | 'none'
  | 'settled'
  | 'revealed'
  | 'conceded-by-you'
  | 'conceded-by-opponent'
  | 'folded-by-you'
  | 'folded-by-opponent';

export interface PendingSpacepokerTerminalAction {
  action: 'fold' | 'concede' | 'reveal';
  submission: 'make-move' | 'accept-settlement';
  previousTerminalState: SpTerminalState;
  previousGameState: SpGameState;
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
  settlementOutcome: SettlementOutcome | null;
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
}

export interface SpacepokerHandState {
  gameState: SpGameState;
  playerHoleCards: [bigint, bigint] | null;
  playerBoost: boolean;
  opponentHoleCards: [bigint, bigint] | null;
  opponentBoost: boolean | null;
  communityCards: (bigint | null)[];
  halfPot: bigint;
  lastRaise: bigint;
  iRaisedLast: boolean;
  handHistory: SpHandEntry[];
  outcome: SpOutcome | null;
  settlementOutcome?: SettlementOutcome | null;
  terminalState?: SpTerminalState;
  terminalRecovery?: 'concede' | 'reveal' | null;
  coinTossIOpen: boolean | null;
  unitSizeMojos: bigint;
  displayMode: SpacepokerDisplayMode;
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

function clvmListToBigints(prog: Program): bigint[] {
  try {
    return prog.toList().map((p) => p.toBigInt());
  } catch {
    return [];
  }
}

function clvmTag(items: Program[]): string | null {
  if (items.length === 0) return null;
  const atom = items[0].atom;
  if (!atom) return null;
  return new TextDecoder().decode(atom);
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
  return `${sign}${frac ? `${whole}.${frac}` : whole} XCH`;
}

export function rollbackOptimisticTerminalHistory(
  history: SpHandEntry[],
  action: 'fold' | 'concede' | 'reveal',
): SpHandEntry[] {
  const last = history[history.length - 1];
  return last?.player === 'you' && last.action === action ? history.slice(0, -1) : history;
}

function spacepokerStateFromPersisted(
  persisted: PersistedGameState | null | undefined,
  _iStarted: boolean,
  _fallbackUnitSize: bigint,
): SpacepokerHandState | undefined {
  if (!persisted || persisted.gameType !== 'spacepoker') return undefined;
  if (persisted.version !== SPACEPOKER_PERSISTED_STATE_VERSION) return undefined;
  if (!persisted.state || typeof persisted.state !== 'object') return undefined;
  return persisted.state as SpacepokerHandState;
}

function persistedSpacepokerState(
  state: SpacepokerHandState,
): PersistedGameState<SpacepokerHandState> {
  return {
    gameType: 'spacepoker',
    version: SPACEPOKER_PERSISTED_STATE_VERSION,
    state,
  };
}

export function useSpacepokerHand(
  _gameObject: SessionController,
  _gameId: string,
  _iStarted: boolean,
  gameplayEvent$: Observable<GameplayEvent>,
  betSize: bigint,
  unitSizeMojos: bigint | undefined,
  onTurnChanged: (isMyTurn: boolean) => void,
  initialPersistedState?: PersistedGameState,
): UseSpacepokerHandResult {
  const fallbackUnitSizeRaw = unitSizeMojos && unitSizeMojos > 0n ? unitSizeMojos : betSize / 10n;
  const fallbackUnitSize = fallbackUnitSizeRaw > 0n ? fallbackUnitSizeRaw : 1n;
  const fallbackDisplayMode = defaultDisplayModeForUnit(fallbackUnitSize);
  const initialHandState = useMemo(
    () => spacepokerStateFromPersisted(initialPersistedState, _iStarted, fallbackUnitSize),
    [initialPersistedState, _iStarted, fallbackUnitSize],
  );
  const [betUnit, setBetUnit] = useState(initialHandState?.unitSizeMojos ?? fallbackUnitSize);
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
  const [gs, setGs] = useState<SpGameState>(
    initialHandState?.gameState ?? {
      handler: SpHandler.CommitA,
      myTurn: !_iStarted,
      N: 4n,
    },
  );
  const [playerHoleCards, setPlayerHoleCards] = useState<[bigint, bigint] | null>(
    initialHandState?.playerHoleCards ?? null,
  );
  const [playerBoost, setPlayerBoost] = useState(initialHandState?.playerBoost ?? false);
  const [opponentHoleCards, setOpponentHoleCards] = useState<[bigint, bigint] | null>(
    initialHandState?.opponentHoleCards ?? null,
  );
  const [opponentBoost, setOpponentBoost] = useState<boolean | null>(
    initialHandState?.opponentBoost ?? null,
  );
  const [communityCards, setCommunityCards] = useState<(bigint | null)[]>(
    initialHandState?.communityCards ?? [null, null, null, null, null],
  );
  const [halfPot, setHalfPot] = useState(initialHandState?.halfPot ?? anteUnits);
  const [lastRaise, setLastRaise] = useState(initialHandState?.lastRaise ?? 0n);
  const [iRaisedLast, setIRaisedLast] = useState(initialHandState?.iRaisedLast ?? false);
  const [handHistory, setHandHistory] = useState<SpHandEntry[]>(
    initialHandState?.handHistory ?? [],
  );
  const [outcome, setOutcome] = useState<SpOutcome | null>(initialHandState?.outcome ?? null);
  const [settlementOutcome, setSettlementOutcome] = useState<SettlementOutcome | null>(
    initialHandState?.settlementOutcome ?? null,
  );
  const [terminalState, setTerminalState] = useState<SpTerminalState>(
    initialHandState?.terminalState ?? 'none',
  );
  const [terminalRecovery, setTerminalRecovery] = useState<'concede' | 'reveal' | null>(
    initialHandState?.terminalRecovery ?? null,
  );
  // Coin toss result: true = I open, false = opponent opens, null = not yet known
  const [coinTossIOpen, setCoinTossIOpen] = useState<boolean | null>(
    initialHandState?.coinTossIOpen ?? null,
  );
  const [displayMode, setDisplayMode] = useState<SpacepokerDisplayMode>(
    initialHandState?.displayMode ?? fallbackDisplayMode,
  );

  const pot = 2n * halfPot + lastRaise;
  const playerStack = stackSize - halfPot - (iRaisedLast ? lastRaise : 0n);
  const opponentStack = stackSize - halfPot - (iRaisedLast ? 0n : lastRaise);

  const gsRef = useRef(gs);
  const gameObjectRef = useRef(_gameObject);
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
  const pendingTerminalActionRef = useRef<PendingSpacepokerTerminalAction | null>(null);
  const terminalClosureRef = useRef(false);
  const halfPotRef = useRef(halfPot);
  const iRaisedLastRef = useRef(iRaisedLast);
  const handHistoryRef = useRef(handHistory);
  const lastActionSnapshotRef = useRef<{
    halfPot: bigint;
    lastRaise: bigint;
    iRaisedLast: boolean;
    historyLength: number;
  } | null>(null);

  gsRef.current = gs;
  gameObjectRef.current = _gameObject;
  gameIdRef.current = _gameId;
  coinTossIOpenRef.current = coinTossIOpen;
  communityCardsRef.current = communityCards;
  lastRaiseRef.current = lastRaise;
  halfPotRef.current = halfPot;
  iRaisedLastRef.current = iRaisedLast;
  handHistoryRef.current = handHistory;
  terminalStateRef.current = terminalState;

  useEffect(() => {
    if (unitSizeMojos && unitSizeMojos > 0n && !initialHandState) {
      setBetUnit(unitSizeMojos);
    }
  }, [unitSizeMojos, initialHandState]);

  useEffect(() => {
    _gameObject.setHandState(
      persistedSpacepokerState({
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
        settlementOutcome,
        terminalState,
        terminalRecovery,
        coinTossIOpen,
        unitSizeMojos: betUnit,
        displayMode,
      }),
    );
  }, [
    _gameObject,
    gs,
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
    settlementOutcome,
    terminalState,
    terminalRecovery,
    coinTossIOpen,
    betUnit,
    displayMode,
  ]);

  // Place community cards into the fixed 5-slot array at the right indices.
  // pos=3 → flop (slots 0-2, 3 cards), pos=2 → turn (slot 3), pos=1 → river (slot 4).
  function placeCards(pos: bigint, cards: bigint[]) {
    const startIdx = pos === 3n ? 0 : pos === 2n ? 3 : 4;
    setCommunityCards((prev) => {
      const next = [...prev];
      for (let i = 0; i < cards.length; i++) {
        next[startIdx + i] = cards[i];
      }
      return next;
    });
  }

  function transition(next: SpGameState) {
    gsRef.current = next;
    setGs(next);
    onTurnChanged(next.myTurn);
  }

  function recordOutcome(next: SpOutcome | null) {
    outcomeRef.current = next;
    setOutcome(next);
  }

  function unitsFromMojos(mojos: bigint): bigint {
    if (betUnit === 0n) return 0n;
    return mojos / betUnit;
  }

  function terminalStateFor(
    player: 'you' | 'opponent',
    action: 'fold' | 'concede',
  ): SpTerminalState {
    if (action === 'fold') return player === 'you' ? 'folded-by-you' : 'folded-by-opponent';
    return player === 'you' ? 'conceded-by-you' : 'conceded-by-opponent';
  }

  function terminalGameStateFor(action: 'fold' | 'concede', current: SpGameState): SpGameState {
    return action === 'fold'
      ? { handler: SpHandler.Folded, myTurn: false, N: current.N }
      : { handler: SpHandler.Showdown, myTurn: false, N: 0n };
  }

  function rollbackPendingTerminalAction(submission: 'make-move' | 'accept-settlement'): boolean {
    const pending = pendingTerminalActionRef.current;
    if (!pendingTerminalActionMatchesFailure(pending, submission)) return false;
    pendingTerminalActionRef.current = null;
    terminalClosureRef.current = false;
    handFinishedRef.current = false;
    setTerminalRecovery(pending.action === 'fold' ? null : pending.action);
    terminalActionByUsRef.current = null;
    setHandHistory((prev) => rollbackOptimisticTerminalHistory(prev, pending.action));
    setTerminalState(pending.previousTerminalState);
    transition(pending.previousGameState);
    return true;
  }

  function clearShowdownData() {
    recordOutcome(null);
  }

  function replaceWithGenericTerminalClosure(
    outcome: SettlementOutcome | null,
    current: SpGameState,
  ) {
    const pending = pendingTerminalActionRef.current;
    pendingTerminalActionRef.current = null;
    terminalClosureRef.current = true;
    terminalActionByUsRef.current = null;
    terminalActionByOpponentRef.current = null;
    handFinishedRef.current = true;
    setTerminalRecovery(null);
    setSettlementOutcome(outcome);
    if (pending) {
      setHandHistory((prev) => rollbackOptimisticTerminalHistory(prev, pending.action));
    }
    clearShowdownData();
    setTerminalState('settled');
    transition({ handler: SpHandler.Folded, myTurn: false, N: current.N });
  }

  function applySettlement(outcome: SettlementOutcome) {
    const cur = gsRef.current;
    setSettlementOutcome(outcome);
    const pending = pendingTerminalActionRef.current;
    if (pending) {
      pendingTerminalActionRef.current = null;
      if (retainsRevealedTerminalPresentation(pending, terminalStateRef.current, outcome)) {
        handFinishedRef.current = true;
        setTerminalRecovery(null);
        return;
      }
      if (outcome === 'accept_settlement' || outcome === 'we_accepted') {
        handFinishedRef.current = true;
        setTerminalRecovery(null);
        return;
      }
      terminalActionByUsRef.current = null;
      replaceWithGenericTerminalClosure(outcome, cur);
      return;
    }

    if (
      retainsRevealedTerminalPresentation(null, terminalStateRef.current, outcome) ||
      retainsVoluntaryTerminalPresentation(terminalStateRef.current, outcome)
    ) {
      handFinishedRef.current = true;
      setTerminalRecovery(null);
      return;
    }

    const voluntaryAction = voluntarySpacepokerSettlementAction(outcome, cur);
    handFinishedRef.current = true;
    if (voluntaryAction) {
      if (voluntaryAction.player === 'opponent') {
        if (terminalActionByOpponentRef.current == null) {
          terminalActionByOpponentRef.current = voluntaryAction.action;
          setHandHistory((prev) => [
            ...prev,
            { player: 'opponent', action: voluntaryAction.action },
          ]);
        }
      } else {
        terminalActionByUsRef.current = voluntaryAction.action;
        setHandHistory((prev) => [...prev, { player: 'you', action: voluntaryAction.action }]);
      }
      setTerminalState(terminalStateFor(voluntaryAction.player, voluntaryAction.action));
      transition(terminalGameStateFor(voluntaryAction.action, cur));
      return;
    }

    // Timeout, clean, slash, and unknown terminal outcomes retain the canonical
    // GameSettled presentation rather than being shown as a poker action.
    replaceWithGenericTerminalClosure(outcome, cur);
  }

  // ── OpponentMoved: the opponent made a move, it's now my turn ──
  // Dispatch based on the readable tag. The tag tells us what the
  // handler computed; it's the single source of truth for what happened.
  useEffect(() => {
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
          const readable = evt.OpponentMoved.readable;
          let items: Program[] = [];
          try {
            const prog = Program.deserialize(Uint8Array.from(readable));
            items = prog.toList();
          } catch {
            /* nil readable from commit steps */
          }

          const tag = clvmTag(items);
          const cur = gsRef.current;

          // nil readable: opponent committed (commitA or commitB).
          if (!tag) {
            if (cur.handler === SpHandler.CommitA) {
              transition({ handler: SpHandler.CommitB, myTurn: true, N: 4n });
            } else {
              transition({ handler: SpHandler.CommitB, myTurn: true, N: 4n });
            }
            return;
          }

          // "deal": their-turn handler for commitB computed our hole
          // cards and the coin toss result. Next my-turn handler is
          // begin_round. The coin toss tells us if we auto-pong or
          // wait for user input.
          if (tag === 'deal') {
            const c1 = items[1].toBigInt();
            const c2 = items[2].toBigInt();
            const boost = items[3].toBigInt() !== 0n;
            const iOpen = items.length >= 5 ? items[4].toBigInt() !== 0n : true;
            setPlayerHoleCards([c1, c2]);
            setPlayerBoost(boost);
            setCoinTossIOpen(iOpen);
            transition({ handler: SpHandler.BeginRound, myTurn: true, N: 4n });
            return;
          }

          // "pong": opponent ponged the coin toss. We're now the
          // opener. The pong readable has our hole cards.
          if (tag === 'pong') {
            if (items.length >= 4) {
              setPlayerHoleCards([items[1].toBigInt(), items[2].toBigInt()]);
              setPlayerBoost(items[3].toBigInt() !== 0n);
            }
            setCoinTossIOpen(true);
            transition({ handler: SpHandler.BeginRound, myTurn: true, N: 4n });
            return;
          }

          // "open": opponent opened a betting round. We respond in
          // mid_round. Format: ("open" raise half_pot [hole1 hole2 boost | cards...])
          if (tag === 'open') {
            const raiseUnits = unitsFromMojos(items[1].toBigInt());
            const halfPotUnits = unitsFromMojos(items[2].toBigInt());

            if (items.length > 3 && cur.N === 4n) {
              setPlayerHoleCards([items[3].toBigInt(), items[4].toBigInt()]);
              setPlayerBoost(items[5].toBigInt() !== 0n);
            } else if (items.length > 3 && cur.N < 4n) {
              placeCards(
                cur.N,
                items.slice(3).map((p) => p.toBigInt()),
              );
            }

            setHalfPot(halfPotUnits);
            setLastRaise(raiseUnits);
            setIRaisedLast(false);
            if (raiseUnits > 0n) {
              setHandHistory((prev) => [
                ...prev,
                { player: 'opponent', action: 'raise', units: raiseUnits },
              ]);
            } else {
              setHandHistory((prev) => [...prev, { player: 'opponent', action: 'check' }]);
            }
            transition({ handler: SpHandler.MidRound, myTurn: true, N: cur.N });
            return;
          }

          // "raise": opponent raised in mid_round.
          // Format: ("raise" new_raise half_pot)
          if (tag === 'raise') {
            const raiseUnits = unitsFromMojos(items[1].toBigInt());
            const halfPotUnits = unitsFromMojos(items[2].toBigInt());
            setHalfPot(halfPotUnits);
            setLastRaise(raiseUnits);
            setIRaisedLast(false);
            setHandHistory((prev) => [
              ...prev,
              { player: 'opponent', action: 'raise', units: raiseUnits },
            ]);
            transition({ handler: SpHandler.MidRound, myTurn: true, N: cur.N });
            return;
          }

          // "call": opponent called. The readable carries the half_pot
          // and current N. If N=1 and full hand data is present, we
          // have showdown info.
          if (tag === 'call') {
            const halfPotMojos = items[1].toBigInt();
            const N = items[2].toBigInt();
            const action = lastRaiseRef.current > 0n ? 'call' : 'check';
            setHandHistory((prev) => [
              ...prev,
              {
                player: 'opponent',
                action,
                endsStreet: action === 'check',
              },
            ]);

            const halfPotUnits = unitsFromMojos(halfPotMojos);
            setHalfPot(halfPotUnits);
            setLastRaise(0n);

            if (N === 1n && items.length >= 12) {
              const yourCards = clvmListToBigints(items[3]);
              const yourBoost = items[4].toBigInt() !== 0n;
              const oppCards = clvmListToBigints(items[5]);
              const oppBoost = items[6].toBigInt() !== 0n;
              const yourSelected = clvmListToBigints(items[7]);
              const yourEval = clvmListToBigints(items[8]);
              const oppSelected = clvmListToBigints(items[9]);
              const oppEval = clvmListToBigints(items[10]);
              const result = items[11].toBigInt();

              setOpponentHoleCards([oppCards[0], oppCards[1]]);
              setOpponentBoost(oppBoost);
              setCommunityCards(yourCards.slice(2, 7));
              recordOutcome({
                result,
                playerHandCards: yourSelected,
                playerHandEval: yourEval,
                opponentHandCards: oppSelected,
                opponentHandEval: oppEval,
              });
              transition({ handler: SpHandler.End, myTurn: true, N: 1n });
              return;
            }

            if (N === 1n) {
              recordOutcome(null);
              transition({ handler: SpHandler.End, myTurn: true, N: 1n });
              return;
            }

            if (items.length > 3) {
              placeCards(
                N - 1n,
                items.slice(3).map((p) => p.toBigInt()),
              );
            }
            transition({ handler: SpHandler.BeginRound, myTurn: true, N: N - 1n });
            return;
          }

          // "end": opponent made the final reveal.
          // Format: ("end" yourSelected yourEval oppSelected oppEval result oppHole1 oppHole2 oppBoost)
          if (tag === 'end') {
            pendingTerminalActionRef.current = null;
            handFinishedRef.current = true;
            setTerminalRecovery((recovery) => terminalRecoveryAfterOpponentMove(recovery, true));
            const yourSelected = clvmListToBigints(items[1]);
            const yourEval = clvmListToBigints(items[2]);
            const oppSelected = clvmListToBigints(items[3]);
            const oppEval = clvmListToBigints(items[4]);
            const result = items[5].toBigInt();
            if (items.length > 7) {
              setOpponentHoleCards([items[6].toBigInt(), items[7].toBigInt()]);
              setOpponentBoost(items[8].toBigInt() !== 0n);
            }
            recordOutcome({
              result,
              playerHandCards: yourSelected,
              playerHandEval: yourEval,
              opponentHandCards: oppSelected,
              opponentHandEval: oppEval,
            });
            terminalActionByOpponentRef.current = 'reveal';
            setHandHistory((prev) => [...prev, { player: 'opponent', action: 'reveal' }]);
            setTerminalState('revealed');
            transition({ handler: SpHandler.Showdown, myTurn: false, N: 0n });
            return;
          }
        } else if ('GameMessage' in evt) {
          // Messages are advisory — display data only, no state change.
          let items: Program[] = [];
          try {
            const prog = Program.deserialize(Uint8Array.from(evt.GameMessage.readable));
            items = prog.toList();
          } catch {
            return;
          }

          const tag = clvmTag(items);

          if (tag === 'deal' && items.length >= 4) {
            setPlayerHoleCards([items[1].toBigInt(), items[2].toBigInt()]);
            setPlayerBoost(items[3].toBigInt() !== 0n);
            if (items.length >= 5) {
              setCoinTossIOpen(items[4].toBigInt() !== 0n);
            }
          } else if (tag === 'cards' && items.length > 1) {
            const newCards = items.slice(1).map((p) => p.toBigInt());
            const pos =
              newCards.length === 3 ? 3n : communityCardsRef.current[3] === null ? 2n : 1n;
            placeCards(pos, newCards);
          } else if (tag === 'call' && items.length > 3) {
            const N = items[2].toBigInt();
            if (N > 1n) {
              placeCards(
                N - 1n,
                items.slice(3).map((p) => p.toBigInt()),
              );
            }
          }
        }
      },
    });

    return () => sub.unsubscribe();
  }, [gameplayEvent$, betUnit, onTurnChanged, stackSize]);

  // ── Auto-play: moves that don't need user input ──
  // CommitA, CommitB: always auto-play nil.
  // BeginRound N=4 when coin toss says opponent opens: auto-play nil (pong).
  // BeginRound/MidRound all-in checks: auto-play only when there is no
  // outstanding raise and we have no remaining raise capacity.
  // End: auto-play reveal or game-level accept.
  useEffect(() => {
    if (handFinishedRef.current) return;
    if (!terminalAutoSubmissionAllowed(terminalRecovery)) return;
    const { handler, myTurn, N } = gs;
    if (!myTurn) return;
    const go = gameObjectRef.current;
    const gid = gameIdRef.current;
    if (!go || !gid) return;
    if (!go.isChannelReady()) return;

    if (handler === SpHandler.CommitA || handler === SpHandler.CommitB) {
      try {
        go.makeMove(gid, null);
        transition({ ...gs, myTurn: false });
      } catch {}
      return;
    }

    if (handler === SpHandler.BeginRound && N === 4n && coinTossIOpen === false) {
      try {
        go.makeMove(gid, null);
        transition({ ...gs, myTurn: false });
      } catch {}
      return;
    }

    if (
      (handler === SpHandler.BeginRound || handler === SpHandler.MidRound) &&
      lastRaise === 0n &&
      playerStack <= 0n
    ) {
      try {
        if (handler === SpHandler.BeginRound) {
          go.makeMove(gid, Program.fromBigInt(0n));
          setHandHistory((prev) => [...prev, { player: 'you', action: 'check' }]);
          transition({ handler: SpHandler.MidRound, myTurn: false, N });
        } else {
          go.makeMove(gid, null);
          setHalfPot((prev) => prev + lastRaiseRef.current);
          setLastRaise(0n);
          setHandHistory((prev) => [...prev, { player: 'you', action: 'check', endsStreet: true }]);
          if (N === 1n) {
            transition({ handler: SpHandler.End, myTurn: false, N: 1n });
          } else {
            transition({ handler: SpHandler.BeginRound, myTurn: false, N: N - 1n });
          }
        }
      } catch {}
      return;
    }

    if (handler === SpHandler.End) {
      const currentOutcome = outcomeRef.current;
      if (!currentOutcome) return;
      handFinishedRef.current = true;
      const action = currentOutcome.result >= 0n ? 'reveal' : 'accept';
      const optimisticHistoryAction = action === 'reveal' ? 'reveal' : 'concede';
      const previousTerminalState = terminalState;
      const pending: NonNullable<typeof pendingTerminalActionRef.current> = {
        action: optimisticHistoryAction,
        submission: action === 'reveal' ? 'make-move' : 'accept-settlement',
        previousTerminalState,
        previousGameState: gs,
      };
      pendingTerminalActionRef.current = pending;
      try {
        if (action === 'reveal') {
          terminalActionByUsRef.current = 'reveal';
          setHandHistory((prev) => [...prev, { player: 'you', action: optimisticHistoryAction }]);
          setTerminalState('revealed');
          go.makeMove(gid, null);
        } else {
          terminalActionByUsRef.current = 'concede';
          setHandHistory((prev) => [...prev, { player: 'you', action: optimisticHistoryAction }]);
          setTerminalState('conceded-by-you');
          go.acceptSettlement(gid);
        }
      } catch {
        rollbackPendingTerminalAction(pending.submission);
        return;
      }
      if (pendingTerminalActionRef.current !== pending) return;
      transition({ handler: SpHandler.Showdown, myTurn: false, N });
      return;
    }
  }, [gs, outcome, coinTossIOpen, lastRaise, playerStack, terminalState, terminalRecovery]);

  const retryTerminalAction = useCallback(() => {
    if (terminalRecovery != null) setTerminalRecovery(null);
  }, [terminalRecovery]);

  const handleCheck = useCallback(() => {
    const go = gameObjectRef.current;
    const gid = gameIdRef.current;
    if (!go || !gid) return;
    const cur = gsRef.current;
    lastActionSnapshotRef.current = {
      halfPot: halfPotRef.current,
      lastRaise: lastRaiseRef.current,
      iRaisedLast: iRaisedLastRef.current,
      historyLength: handHistoryRef.current.length,
    };
    go.makeMove(gid, Program.fromBigInt(0n));
    setHandHistory((prev) => [...prev, { player: 'you', action: 'check' }]);
    transition({ handler: SpHandler.MidRound, myTurn: false, N: cur.N });
  }, []);

  const handleRaise = useCallback(
    (units: bigint) => {
      const go = gameObjectRef.current;
      const gid = gameIdRef.current;
      if (!go || !gid) return;
      const cur = gsRef.current;
      lastActionSnapshotRef.current = {
        halfPot: halfPotRef.current,
        lastRaise: lastRaiseRef.current,
        iRaisedLast: iRaisedLastRef.current,
        historyLength: handHistoryRef.current.length,
      };
      const mojoAmount = units * betUnit;
      go.makeMove(gid, Program.fromBigInt(mojoAmount));
      setHalfPot((prev) => prev + lastRaiseRef.current);
      setLastRaise(units);
      setIRaisedLast(true);
      setHandHistory((prev) => [...prev, { player: 'you', action: 'raise', units }]);
      transition({ handler: SpHandler.MidRound, myTurn: false, N: cur.N });
    },
    [betUnit],
  );

  const handleCall = useCallback(() => {
    const go = gameObjectRef.current;
    const gid = gameIdRef.current;
    if (!go || !gid) return;
    const cur = gsRef.current;
    lastActionSnapshotRef.current = {
      halfPot: halfPotRef.current,
      lastRaise: lastRaiseRef.current,
      iRaisedLast: iRaisedLastRef.current,
      historyLength: handHistoryRef.current.length,
    };
    go.makeMove(gid, null);
    setHalfPot((prev) => prev + lastRaiseRef.current);
    setLastRaise(0n);
    const action = lastRaiseRef.current > 0n ? 'call' : 'check';
    setHandHistory((prev) => [
      ...prev,
      {
        player: 'you',
        action,
        endsStreet: action === 'check',
      },
    ]);
    if (cur.N === 1n) {
      recordOutcome(null);
      transition({ handler: SpHandler.End, myTurn: false, N: 1n });
    } else {
      transition({ handler: SpHandler.BeginRound, myTurn: false, N: cur.N - 1n });
    }
  }, []);

  const handleFold = useCallback(() => {
    const go = gameObjectRef.current;
    const gid = gameIdRef.current;
    if (!go || !gid) return;
    const cur = gsRef.current;
    // "Fold" is a UX betting action. Protocol-wise this accepts the current
    // settlement; Space Poker has no fold move in its handlers or validators.
    handFinishedRef.current = true;
    const previousTerminalState = terminalState;
    terminalActionByUsRef.current = 'fold';
    const pending: NonNullable<typeof pendingTerminalActionRef.current> = {
      action: 'fold',
      submission: 'accept-settlement',
      previousTerminalState,
      previousGameState: cur,
    };
    pendingTerminalActionRef.current = pending;
    setHandHistory((prev) => [...prev, { player: 'you', action: 'fold' }]);
    setTerminalState('folded-by-you');
    go.acceptSettlement(gid);
    if (pendingTerminalActionRef.current !== pending) return;
    transition({ handler: SpHandler.Folded, myTurn: false, N: cur.N });
  }, [terminalState]);

  const formatBet = useCallback(
    (units: bigint): string => {
      if (displayMode === 'units') return String(units);
      const mojos = units * betUnit;
      if (displayMode === 'mojos') return `${mojos.toLocaleString()} mojos`;
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
    settlementOutcome,
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
  };
}
