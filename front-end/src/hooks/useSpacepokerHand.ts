import { useState, useEffect, useCallback, useRef } from 'react';
import { Program } from 'clvm-lib';
import { Observable } from 'rxjs';
import { WasmBlobWrapper } from './WasmBlobWrapper';
import { GameplayEvent } from './useGameSession';
import { log } from '../services/log';

// These mirror the handler names in the Chialisp. The UX tracks which
// handler is currently active; every OpponentMoved advances it to the
// next state in the sequence. myTurn is implicit: an OpponentMoved
// means it's now my turn; a makeMove means it's now theirs.
export enum SpHandler {
  CommitA,    // my-turn: auto-play nil
  CommitB,    // my-turn: auto-play nil
  BeginRound, // my-turn: user opens (or auto-pong at N=4)
  MidRound,   // my-turn: user raises or calls
  End,        // my-turn: auto-play reveal/fold
  Showdown,   // terminal
  Folded,     // terminal
}

export interface SpGameState {
  handler: SpHandler;
  myTurn: boolean;
  N: number;
}

export interface SpHandEntry {
  player: 'you' | 'opponent';
  action: 'check' | 'raise' | 'call' | 'fold';
  units?: number;
}

export interface SpOutcome {
  result: number;
  playerHandCards: number[];
  playerHandEval: number[];
  opponentHandCards: number[] | null;
  opponentHandEval: number[] | null;
}

export interface UseSpacepokerHandResult {
  gameState: SpGameState;
  playerHoleCards: [number, number] | null;
  playerBoost: boolean;
  opponentHoleCards: [number, number] | null;
  opponentBoost: boolean | null;
  communityCards: (number | null)[];
  pot: number;
  playerStack: number;
  opponentStack: number;
  betUnit: number;
  handHistory: SpHandEntry[];
  outcome: SpOutcome | null;
  lastRaise: number;
  coinTossIOpen: boolean | null;

  handleCheck: () => void;
  handleRaise: (units: number) => void;
  handleCall: () => void;
  handleFold: () => void;
}

function clvmListToInts(prog: Program): number[] {
  try {
    return prog.toList().map(p => p.toInt());
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

export function useSpacepokerHand(
  _gameObject: WasmBlobWrapper,
  _gameId: string,
  _iStarted: boolean,
  gameplayEvent$: Observable<GameplayEvent>,
  betSize: bigint,
  onTurnChanged: (isMyTurn: boolean) => void,
): UseSpacepokerHandResult {
  const betUnit = Number(betSize) / 10;
  const stackSize = 10;
  const anteUnits = 1;

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
  const [gs, setGs] = useState<SpGameState>({
    handler: SpHandler.CommitA,
    myTurn: !_iStarted,
    N: 4,
  });
  const [playerHoleCards, setPlayerHoleCards] = useState<[number, number] | null>(null);
  const [playerBoost, setPlayerBoost] = useState(false);
  const [opponentHoleCards, setOpponentHoleCards] = useState<[number, number] | null>(null);
  const [opponentBoost, setOpponentBoost] = useState<boolean | null>(null);
  const [communityCards, setCommunityCards] = useState<(number | null)[]>([null, null, null, null, null]);
  const [halfPot, setHalfPot] = useState(anteUnits);
  const [lastRaise, setLastRaise] = useState(0);
  const [iRaisedLast, setIRaisedLast] = useState(false);
  const [handHistory, setHandHistory] = useState<SpHandEntry[]>([]);
  const [outcome, setOutcome] = useState<SpOutcome | null>(null);
  // Coin toss result: true = I open, false = opponent opens, null = not yet known
  const [coinTossIOpen, setCoinTossIOpen] = useState<boolean | null>(null);

  const pot = 2 * halfPot + lastRaise;
  const playerStack = stackSize - halfPot - (iRaisedLast ? lastRaise : 0);
  const opponentStack = stackSize - halfPot - (iRaisedLast ? 0 : lastRaise);

  const gsRef = useRef(gs);
  const gameObjectRef = useRef(_gameObject);
  const gameIdRef = useRef(_gameId);
  const handFinishedRef = useRef(false);
  const coinTossIOpenRef = useRef(coinTossIOpen);
  const communityCardsRef = useRef(communityCards);
  const lastRaiseRef = useRef(lastRaise);

  gsRef.current = gs;
  gameObjectRef.current = _gameObject;
  gameIdRef.current = _gameId;
  coinTossIOpenRef.current = coinTossIOpen;
  communityCardsRef.current = communityCards;
  lastRaiseRef.current = lastRaise;

  // Place community cards into the fixed 5-slot array at the right indices.
  // pos=3 → flop (slots 0-2, 3 cards), pos=2 → turn (slot 3), pos=1 → river (slot 4).
  function placeCards(pos: number, cards: number[]) {
    const startIdx = pos === 3 ? 0 : pos === 2 ? 3 : 4;
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

  // ── OpponentMoved: the opponent made a move, it's now my turn ──
  // Dispatch based on the readable tag. The tag tells us what the
  // handler computed; it's the single source of truth for what happened.
  useEffect(() => {
    const sub = gameplayEvent$.subscribe({
      next: (evt: GameplayEvent) => {
        if (handFinishedRef.current) return;

        if ('OpponentMoved' in evt) {
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
              transition({ handler: SpHandler.CommitB, myTurn: true, N: 4 });
            } else {
              transition({ handler: SpHandler.CommitB, myTurn: true, N: 4 });
            }
            return;
          }

          // "deal": their-turn handler for commitB computed our hole
          // cards and the coin toss result. Next my-turn handler is
          // begin_round. The coin toss tells us if we auto-pong or
          // wait for user input.
          if (tag === 'deal') {
            const c1 = items[1].toInt();
            const c2 = items[2].toInt();
            const boost = items[3].toInt() !== 0;
            const iOpen = items.length >= 5 ? items[4].toInt() !== 0 : true;
            setPlayerHoleCards([c1, c2]);
            setPlayerBoost(boost);
            setCoinTossIOpen(iOpen);
            transition({ handler: SpHandler.BeginRound, myTurn: true, N: 4 });
            return;
          }

          // "pong": opponent ponged the coin toss. We're now the
          // opener. The pong readable has our hole cards.
          if (tag === 'pong') {
            if (items.length >= 4) {
              setPlayerHoleCards([items[1].toInt(), items[2].toInt()]);
              setPlayerBoost(items[3].toInt() !== 0);
            }
            setCoinTossIOpen(true);
            transition({ handler: SpHandler.BeginRound, myTurn: true, N: 4 });
            return;
          }

          // "open": opponent opened a betting round. We respond in
          // mid_round. Format: ("open" raise half_pot [hole1 hole2 boost | cards...])
          if (tag === 'open') {
            const raiseAmt = Number(items[1].toBigInt());
            const raiseUnits = Math.round(raiseAmt / betUnit);
            const halfPotUnits = Math.round(Number(items[2].toBigInt()) / betUnit);

            if (items.length > 3 && cur.N === 4) {
              setPlayerHoleCards([items[3].toInt(), items[4].toInt()]);
              setPlayerBoost(items[5].toInt() !== 0);
            } else if (items.length > 3 && cur.N < 4) {
              placeCards(cur.N, items.slice(3).map(p => p.toInt()));
            }

            setHalfPot(halfPotUnits);
            setLastRaise(raiseUnits);
            setIRaisedLast(false);
            if (raiseUnits > 0) {
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
            const raiseAmt = Number(items[1].toBigInt());
            const raiseUnits = Math.round(raiseAmt / betUnit);
            const halfPotUnits = Math.round(Number(items[2].toBigInt()) / betUnit);
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
            const halfPotMojos = Number(items[1].toBigInt());
            const N = items[2].toInt();
            setHandHistory(prev => [...prev, { player: 'opponent', action: 'call' }]);

            const halfPotUnits = Math.round(halfPotMojos / betUnit);
            setHalfPot(halfPotUnits);
            setLastRaise(0);

            if (N === 1 && items.length > 3) {
              const yourCards = clvmListToInts(items[3]);
              const yourBoost = items[4].toInt() !== 0;
              const oppCards = clvmListToInts(items[5]);
              const oppBoost = items[6].toInt() !== 0;
              const yourSelected = clvmListToInts(items[7]);
              const yourEval = clvmListToInts(items[8]);
              const oppSelected = clvmListToInts(items[9]);
              const oppEval = clvmListToInts(items[10]);
              const result = items[11].toInt();

              setOpponentHoleCards([oppCards[0], oppCards[1]]);
              setOpponentBoost(oppBoost);
              setCommunityCards(yourCards.slice(2, 7));
              setOutcome({
                result,
                playerHandCards: yourSelected,
                playerHandEval: yourEval,
                opponentHandCards: oppSelected,
                opponentHandEval: oppEval,
              });
              transition({ handler: SpHandler.End, myTurn: true, N: 1 });
              return;
            }

            if (N === 1) {
              transition({ handler: SpHandler.End, myTurn: true, N: 1 });
              return;
            }

            if (items.length > 3) {
              placeCards(N - 1, items.slice(3).map(p => p.toInt()));
            }
            transition({ handler: SpHandler.BeginRound, myTurn: true, N: N - 1 });
            return;
          }

          // "end": opponent made the final reveal.
          // Format: ("end" yourSelected yourEval oppSelected oppEval result oppHole1 oppHole2 oppBoost)
          if (tag === 'end') {
            handFinishedRef.current = true;
            const yourSelected = clvmListToInts(items[1]);
            const yourEval = clvmListToInts(items[2]);
            const oppSelected = clvmListToInts(items[3]);
            const oppEval = clvmListToInts(items[4]);
            const result = items[5].toInt();
            if (items.length > 7) {
              setOpponentHoleCards([items[6].toInt(), items[7].toInt()]);
              setOpponentBoost(items[8].toInt() !== 0);
            }
            setOutcome({
              result,
              playerHandCards: yourSelected,
              playerHandEval: yourEval,
              opponentHandCards: oppSelected,
              opponentHandEval: oppEval,
            });
            transition({ handler: SpHandler.Showdown, myTurn: false, N: 0 });
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
            setPlayerHoleCards([items[1].toInt(), items[2].toInt()]);
            setPlayerBoost(items[3].toInt() !== 0);
            if (items.length >= 5) {
              setCoinTossIOpen(items[4].toInt() !== 0);
            }
          } else if (tag === 'cards' && items.length > 1) {
            const newCards = items.slice(1).map(p => p.toInt());
            const pos = newCards.length === 3 ? 3 : communityCardsRef.current[3] === null ? 2 : 1;
            placeCards(pos, newCards);
          } else if (tag === 'call' && items.length > 3) {
            const N = items[2].toInt();
            if (N > 1) {
              placeCards(N - 1, items.slice(3).map(p => p.toInt()));
            }
          }

        } else if ('_terminal' in evt) {
          if (!handFinishedRef.current) {
            handFinishedRef.current = true;
            if (gsRef.current.handler !== SpHandler.Showdown) {
              setHandHistory(prev => [...prev, { player: 'opponent', action: 'fold' }]);
              transition({ handler: SpHandler.Folded, myTurn: false, N: gsRef.current.N });
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
  // End: auto-play reveal or fold.
  useEffect(() => {
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

    if (handler === SpHandler.BeginRound && N === 4 && coinTossIOpen === false) {
      try {
        go.makeMove(gid, null);
        transition({ ...gs, myTurn: false });
      } catch {}
      return;
    }

    if (
      (handler === SpHandler.BeginRound || handler === SpHandler.MidRound) &&
      lastRaise === 0 &&
      playerStack <= 0
    ) {
      try {
        if (handler === SpHandler.BeginRound) {
          go.makeMove(gid, Program.fromInt(0));
          setHandHistory(prev => [...prev, { player: 'you', action: 'check' }]);
          transition({ handler: SpHandler.MidRound, myTurn: false, N });
        } else {
          go.makeMove(gid, null);
          setHalfPot(prev => prev + lastRaiseRef.current);
          setLastRaise(0);
          setHandHistory(prev => [...prev, { player: 'you', action: 'check' }]);
          if (N === 1) {
            transition({ handler: SpHandler.End, myTurn: false, N: 1 });
          } else {
            transition({ handler: SpHandler.BeginRound, myTurn: false, N: N - 1 });
          }
        }
      } catch {}
      return;
    }

    if (handler === SpHandler.End && outcome) {
      handFinishedRef.current = true;
      if (outcome.result >= 0) {
        try { go.makeMove(gid, null); } catch {}
      } else {
        try { go.acceptTimeout(gid); } catch {}
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
    go.makeMove(gid, Program.fromInt(0));
    setHandHistory(prev => [...prev, { player: 'you', action: 'check' }]);
    transition({ handler: SpHandler.MidRound, myTurn: false, N: cur.N });
  }, []);

  const handleRaise = useCallback((units: number) => {
    const go = gameObjectRef.current;
    const gid = gameIdRef.current;
    if (!go || !gid) return;
    const cur = gsRef.current;
    const mojoAmount = Math.round(units * betUnit);
    go.makeMove(gid, Program.fromInt(mojoAmount));
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
    go.makeMove(gid, null);
    setHalfPot(prev => prev + lastRaiseRef.current);
    setLastRaise(0);
    const action = lastRaiseRef.current > 0 ? 'call' : 'check';
    setHandHistory(prev => [...prev, { player: 'you', action }]);
    if (cur.N === 1) {
      transition({ handler: SpHandler.End, myTurn: false, N: 1 });
    } else {
      transition({ handler: SpHandler.BeginRound, myTurn: false, N: cur.N - 1 });
    }
  }, []);

  const handleFold = useCallback(() => {
    const go = gameObjectRef.current;
    const gid = gameIdRef.current;
    if (!go || !gid) return;
    const cur = gsRef.current;
    go.acceptTimeout(gid);
    setHandHistory(prev => [...prev, { player: 'you', action: 'fold' }]);
    handFinishedRef.current = true;
    transition({ handler: SpHandler.Folded, myTurn: false, N: cur.N });
  }, []);

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
    lastRaise,
    coinTossIOpen,
    handleCheck,
    handleRaise,
    handleCall,
    handleFold,
  };
}
