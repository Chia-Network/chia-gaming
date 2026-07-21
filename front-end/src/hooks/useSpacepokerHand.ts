import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Program } from 'clvm-lib';
import { Observable } from 'rxjs';
import { SessionController } from './SessionController';
import { GameplayEvent } from './useGameSession';
import { log } from '../services/log';
import { PersistedGameState } from './save';
import {
  isForfeitOutcome,
  settlementByUs,
  type SettlementOutcome,
} from '../lib/settlement';

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
export type SpHandler = typeof SpHandler[keyof typeof SpHandler];

export interface SpGameState {
  handler: SpHandler;
  myTurn: boolean;
  N: bigint;
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
  | 'revealed'
  | 'conceded-by-you'
  | 'conceded-by-opponent'
  | 'folded-by-you'
  | 'folded-by-opponent';

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
  terminalState: SpTerminalState;
  settlementOutcome: SettlementOutcome | null;
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
  terminalState?: SpTerminalState;
  settlementOutcome?: SettlementOutcome | null;
  coinTossIOpen: boolean | null;
  unitSizeMojos: bigint;
  displayMode: SpacepokerDisplayMode;
}

function clvmListToBigints(prog: Program): bigint[] {
  try {
    return prog.toList().map(p => p.toBigInt());
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function spacepokerStateFromPersisted(
  persisted: PersistedGameState | null | undefined,
): SpacepokerHandState | undefined {
  if (!persisted || persisted.gameType !== 'spacepoker') return undefined;
  if (persisted.version !== SPACEPOKER_PERSISTED_STATE_VERSION) return undefined;
  if (!persisted.state || typeof persisted.state !== 'object') return undefined;
  return persisted.state as SpacepokerHandState;
}

function persistedSpacepokerState(state: SpacepokerHandState): PersistedGameState<SpacepokerHandState> {
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
  /** Session-level settlement (live terminal or frozen remount). */
  externalSettlement: SettlementOutcome | null = null,
): UseSpacepokerHandResult {
  const fallbackUnitSizeRaw = unitSizeMojos && unitSizeMojos > 0n ? unitSizeMojos : betSize / 10n;
  const fallbackUnitSize = fallbackUnitSizeRaw > 0n ? fallbackUnitSizeRaw : 1n;
  const fallbackDisplayMode = defaultDisplayModeForUnit(fallbackUnitSize);
  const initialHandState = useMemo(
    () => spacepokerStateFromPersisted(initialPersistedState),
    [initialPersistedState],
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
  const [gs, setGs] = useState<SpGameState>(initialHandState?.gameState ?? {
    handler: SpHandler.CommitA,
    myTurn: !_iStarted,
    N: 4n,
  });
  const [playerHoleCards, setPlayerHoleCards] = useState<[bigint, bigint] | null>(initialHandState?.playerHoleCards ?? null);
  const [playerBoost, setPlayerBoost] = useState(initialHandState?.playerBoost ?? false);
  const [opponentHoleCards, setOpponentHoleCards] = useState<[bigint, bigint] | null>(initialHandState?.opponentHoleCards ?? null);
  const [opponentBoost, setOpponentBoost] = useState<boolean | null>(initialHandState?.opponentBoost ?? null);
  const [communityCards, setCommunityCards] = useState<(bigint | null)[]>(initialHandState?.communityCards ?? [null, null, null, null, null]);
  const [halfPot, setHalfPot] = useState(initialHandState?.halfPot ?? anteUnits);
  const [lastRaise, setLastRaise] = useState(initialHandState?.lastRaise ?? 0n);
  const [iRaisedLast, setIRaisedLast] = useState(initialHandState?.iRaisedLast ?? false);
  const [handHistory, setHandHistory] = useState<SpHandEntry[]>(initialHandState?.handHistory ?? []);
  const [outcome, setOutcome] = useState<SpOutcome | null>(initialHandState?.outcome ?? null);
  const [terminalState, setTerminalState] = useState<SpTerminalState>(initialHandState?.terminalState ?? 'none');
  const [settlementOutcome, setSettlementOutcome] = useState<SettlementOutcome | null>(
    initialHandState?.settlementOutcome ?? null,
  );
  // Coin toss result: true = I open, false = opponent opens, null = not yet known
  const [coinTossIOpen, setCoinTossIOpen] = useState<boolean | null>(initialHandState?.coinTossIOpen ?? null);
  const [displayMode, setDisplayMode] = useState<SpacepokerDisplayMode>(initialHandState?.displayMode ?? fallbackDisplayMode);

  const pot = 2n * halfPot + lastRaise;
  const playerStack = stackSize - halfPot - (iRaisedLast ? lastRaise : 0n);
  const opponentStack = stackSize - halfPot - (iRaisedLast ? 0n : lastRaise);

  const gsRef = useRef(gs);
  const gameObjectRef = useRef(_gameObject);
  const gameIdRef = useRef(_gameId);
  const handFinishedRef = useRef(
    initialHandState?.gameState.handler === SpHandler.Showdown
      || initialHandState?.gameState.handler === SpHandler.Folded
      || (initialHandState?.terminalState != null && initialHandState.terminalState !== 'none')
  );
  const coinTossIOpenRef = useRef(coinTossIOpen);
  const communityCardsRef = useRef(communityCards);
  const lastRaiseRef = useRef(lastRaise);
  const outcomeRef = useRef(outcome);
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

  useEffect(() => {
    if (unitSizeMojos && unitSizeMojos > 0n && !initialHandState) {
      setBetUnit(unitSizeMojos);
    }
  }, [unitSizeMojos, initialHandState]);

  useEffect(() => {
    _gameObject.setHandState(persistedSpacepokerState({
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
      settlementOutcome,
      coinTossIOpen,
      unitSizeMojos: betUnit,
      displayMode,
    }));
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
    terminalState,
    settlementOutcome,
    coinTossIOpen,
    betUnit,
    displayMode,
  ]);

  // Place community cards into the fixed 5-slot array at the right indices.
  // pos=3 → flop (slots 0-2, 3 cards), pos=2 → turn (slot 3), pos=1 → river (slot 4).
  function placeCards(pos: bigint, cards: bigint[]) {
    const startIdx = pos === 3n ? 0 : pos === 2n ? 3 : 4;
    setCommunityCards(prev => {
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

  function applySettlement(outcome: SettlementOutcome) {
    // Always keep the settlement label (Timed Out / Forfeit), even when the
    // hand already reached Folded/Showdown via optimistic play or replay.
    setSettlementOutcome(outcome);
    const cur = gsRef.current;
    if (cur.handler === SpHandler.Showdown || cur.handler === SpHandler.Folded) {
      return;
    }
    const byUs = settlementByUs(outcome);
    if (byUs === true || isForfeitOutcome(outcome)) {
      if (byUs && !cur.myTurn) {
        const snap = lastActionSnapshotRef.current;
        if (snap) {
          setHalfPot(snap.halfPot);
          setLastRaise(snap.lastRaise);
          setIRaisedLast(snap.iRaisedLast);
          setHandHistory(prev => prev.slice(0, snap.historyLength));
        }
      }
      setTerminalState('folded-by-you');
      transition({ handler: SpHandler.Folded, myTurn: false, N: cur.N });
      return;
    }
    if (byUs === false) {
      if (cur.handler === SpHandler.End) {
        recordOutcome(null);
        setOpponentHoleCards(null);
        setOpponentBoost(null);
        setHandHistory(prev => [...prev, { player: 'opponent', action: 'concede' }]);
        setTerminalState('conceded-by-opponent');
        transition({ handler: SpHandler.Showdown, myTurn: false, N: 0n });
      } else {
        setHandHistory(prev => [...prev, { player: 'opponent', action: 'fold' }]);
        setTerminalState('folded-by-opponent');
        transition({ handler: SpHandler.Folded, myTurn: false, N: cur.N });
      }
      return;
    }
    // Non-directional settles (e.g. settled_cleanly) with no showdown yet.
    setTerminalState('folded-by-you');
    transition({ handler: SpHandler.Folded, myTurn: false, N: cur.N });
  }

  // Session terminal is the durable signal that the hand is over. Do not rely
  // only on the ephemeral Settled gameplay event (can race coin-id await /
  // remount and leave the board mid-hand while the banner already shows timeout).
  useEffect(() => {
    if (externalSettlement == null) return;
    handFinishedRef.current = true;
    applySettlement(externalSettlement);
  }, [externalSettlement]);

  // ── OpponentMoved: the opponent made a move, it's now my turn ──
  // Dispatch based on the readable tag. The tag tells us what the
  // handler computed; it's the single source of truth for what happened.
  useEffect(() => {
    const sub = gameplayEvent$.subscribe({
      next: (evt: GameplayEvent) => {
        if ('Settled' in evt) {
          if (evt.Settled.gameId !== gameIdRef.current) return;
          // Apply even when already finished so timeout/forfeit labels land
          // after optimistic fold / on-chain replay reached a terminal handler.
          handFinishedRef.current = true;
          applySettlement(evt.Settled.outcome);
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
          } catch { /* nil readable from commit steps */ }

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
              placeCards(cur.N, items.slice(3).map(p => p.toBigInt()));
            }

            setHalfPot(halfPotUnits);
            setLastRaise(raiseUnits);
            setIRaisedLast(false);
            if (raiseUnits > 0n) {
              setHandHistory(prev => [...prev, { player: 'opponent', action: 'raise', units: raiseUnits }]);
            } else {
              setHandHistory(prev => [...prev, { player: 'opponent', action: 'check' }]);
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
            setHandHistory(prev => [...prev, { player: 'opponent', action: 'raise', units: raiseUnits }]);
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
            setHandHistory(prev => [...prev, {
              player: 'opponent',
              action,
              endsStreet: action === 'check',
            }]);

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
              placeCards(N - 1n, items.slice(3).map(p => p.toBigInt()));
            }
            transition({ handler: SpHandler.BeginRound, myTurn: true, N: N - 1n });
            return;
          }

          // "end": opponent made the final reveal.
          // Format: ("end" yourSelected yourEval oppSelected oppEval result oppHole1 oppHole2 oppBoost)
          if (tag === 'end') {
            handFinishedRef.current = true;
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
            setHandHistory(prev => [...prev, { player: 'opponent', action: 'reveal' }]);
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
          } catch { return; }

          const tag = clvmTag(items);

          if (tag === 'deal' && items.length >= 4) {
            setPlayerHoleCards([items[1].toBigInt(), items[2].toBigInt()]);
            setPlayerBoost(items[3].toBigInt() !== 0n);
            if (items.length >= 5) {
              setCoinTossIOpen(items[4].toBigInt() !== 0n);
            }
          } else if (tag === 'cards' && items.length > 1) {
            const newCards = items.slice(1).map(p => p.toBigInt());
            const pos = newCards.length === 3 ? 3n : communityCardsRef.current[3] === null ? 2n : 1n;
            placeCards(pos, newCards);
          } else if (tag === 'call' && items.length > 3) {
            const N = items[2].toBigInt();
            if (N > 1n) {
              placeCards(N - 1n, items.slice(3).map(p => p.toBigInt()));
            }
          }

        } else if ('GameError' in evt) {
          if (evt.GameError.gameId !== gameIdRef.current) return;
          handFinishedRef.current = true;
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
    const { handler, myTurn, N } = gs;
    if (!myTurn) return;
    const go = gameObjectRef.current;
    const gid = gameIdRef.current;
    if (!go || !gid) return;

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
          setHandHistory(prev => [...prev, { player: 'you', action: 'check' }]);
          transition({ handler: SpHandler.MidRound, myTurn: false, N });
        } else {
          go.makeMove(gid, null);
          setHalfPot(prev => prev + lastRaiseRef.current);
          setLastRaise(0n);
          setHandHistory(prev => [...prev, { player: 'you', action: 'check', endsStreet: true }]);
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
      try {
        if (action === 'reveal') {
          go.makeMove(gid, null);
          setHandHistory(prev => [...prev, { player: 'you', action: 'reveal' }]);
          setTerminalState('revealed');
        } else {
          go.acceptSettlement(gid);
          setHandHistory(prev => [...prev, { player: 'you', action: 'concede' }]);
          setTerminalState('conceded-by-you');
        }
      } catch (error) {
        handFinishedRef.current = false;
        log(`[spacepoker] failed to ${action} at showdown: ${errorMessage(error)}`);
        return;
      }
      transition({ handler: SpHandler.Showdown, myTurn: false, N });
      return;
    }
  }, [gs, outcome, coinTossIOpen, lastRaise, playerStack]);

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
    setHandHistory(prev => [...prev, { player: 'you', action: 'check' }]);
    transition({ handler: SpHandler.MidRound, myTurn: false, N: cur.N });
  }, []);

  const handleRaise = useCallback((units: bigint) => {
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
    setHalfPot(prev => prev + lastRaiseRef.current);
    setLastRaise(units);
    setIRaisedLast(true);
    setHandHistory(prev => [...prev, { player: 'you', action: 'raise', units }]);
    transition({ handler: SpHandler.MidRound, myTurn: false, N: cur.N });
  }, [betUnit]);

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
    setHalfPot(prev => prev + lastRaiseRef.current);
    setLastRaise(0n);
    const action = lastRaiseRef.current > 0n ? 'call' : 'check';
    setHandHistory(prev => [...prev, {
      player: 'you',
      action,
      endsStreet: action === 'check',
    }]);
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
    go.acceptSettlement(gid);
    setHandHistory(prev => [...prev, { player: 'you', action: 'fold' }]);
    handFinishedRef.current = true;
    setTerminalState('folded-by-you');
    transition({ handler: SpHandler.Folded, myTurn: false, N: cur.N });
  }, []);

  const formatBet = useCallback((units: bigint): string => {
    if (displayMode === 'units') return String(units);
    const mojos = units * betUnit;
    if (displayMode === 'mojos') return `${mojos.toLocaleString()} mojos`;
    return formatXch(mojos);
  }, [betUnit, displayMode]);

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
    terminalState,
    settlementOutcome,
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
