import { useState, useEffect, useCallback, useRef } from 'react';
import { Program } from 'clvm-lib';
import { Observable } from 'rxjs';
import {
  CalpokerOutcome,
} from '../types/ChiaGaming';
import { WasmBlobWrapper } from './WasmBlobWrapper';
import { CalpokerHandState } from './save';
import { GameplayEvent } from './useGameSession';

function parseCards(readableBytes: number[], iStarted: boolean): { playerHand: number[], opponentHand: number[] } {
  const program = Program.deserialize(Uint8Array.from(readableBytes));
  const card_lists = program.toList().map(l => l.toList().map(v => v.toInt()));
  if (iStarted) {
    return { playerHand: card_lists[1], opponentHand: card_lists[0] };
  } else {
    return { playerHand: card_lists[0], opponentHand: card_lists[1] };
  }
}

function selectedCardsToBitfield(selectedCards: number[], hand: number[]): number {
  let bitfield = 0;
  hand.forEach((cardId, index) => {
    if (selectedCards.includes(cardId)) {
      bitfield |= 1 << index;
    }
  });
  return bitfield;
}

export interface UseCalpokerHandResult {
  playerHand: number[];
  opponentHand: number[];
  cardSelections: number[];
  setCardSelections: (s: number[] | ((prev: number[]) => number[])) => void;
  moveNumber: number;
  outcome: CalpokerOutcome | undefined;
  handleMakeMove: () => void;
  handleCheat: () => void;
}

export function useCalpokerHand(
  gameObject: WasmBlobWrapper,
  gameId: string,
  iStarted: boolean,
  gameplayEvent$: Observable<GameplayEvent>,
  onOutcome: (outcome: CalpokerOutcome) => void,
  onTurnChanged: (isMyTurn: boolean) => void,
  initialHandState?: CalpokerHandState,
): UseCalpokerHandResult {
  const [playerHand, setPlayerHand] = useState<number[]>(initialHandState?.playerHand ?? []);
  const [opponentHand, setOpponentHand] = useState<number[]>(initialHandState?.opponentHand ?? []);
  const [cardSelections, setOurCardSelections] = useState<number[]>([]);
  const [moveNumber, setMoveNumber] = useState<number>(initialHandState?.moveNumber ?? 0);
  const [isPlayerTurn, setMyTurn] = useState<boolean>(initialHandState?.isPlayerTurn ?? !iStarted);
  const [outcome, setOutcome] = useState<CalpokerOutcome | undefined>(undefined);

  const playerHandRef = useRef<number[]>(initialHandState?.playerHand ?? []);
  const opponentHandRef = useRef<number[]>(initialHandState?.opponentHand ?? []);
  const cardSelectionsRef = useRef<number[]>([]);
  const moveNumberRef = useRef<number>(initialHandState?.moveNumber ?? 0);
  const gameObjectRef = useRef(gameObject);
  const gameIdRef = useRef(gameId);
  const handFinishedRef = useRef(false);
  const pendingPlayRef = useRef(false);
  const isPlayerTurnRef = useRef(initialHandState?.isPlayerTurn ?? !iStarted);
  const restoredRef = useRef(!!initialHandState);

  playerHandRef.current = playerHand;
  opponentHandRef.current = opponentHand;
  cardSelectionsRef.current = cardSelections;
  moveNumberRef.current = moveNumber;
  gameObjectRef.current = gameObject;
  gameIdRef.current = gameId;
  isPlayerTurnRef.current = isPlayerTurn;

  useEffect(() => {
    const subscription = gameplayEvent$.subscribe({
      next: (evt: GameplayEvent) => {
        if (handFinishedRef.current) return;

        if ('OpponentMoved' in evt) {
          const currentMove = moveNumberRef.current;
          setMyTurn(true);
          onTurnChanged(true);

          if (currentMove === 1 && !iStarted) {
            try {
              const cards = parseCards(evt.OpponentMoved.readable, iStarted);
              setPlayerHand(cards.playerHand);
              setOpponentHand(cards.opponentHand);
              playerHandRef.current = cards.playerHand;
              opponentHandRef.current = cards.opponentHand;
            } catch (e) {
              console.error('parseCards from OpponentMoved failed:', e);
            }
          } else if (currentMove >= 2) {
            handFinishedRef.current = true;
            gameObjectRef.current?.setHandState(null);
            const myDiscardsBitfield = selectedCardsToBitfield(
              cardSelectionsRef.current,
              playerHandRef.current,
            );
            const newOutcome = new CalpokerOutcome(
              iStarted,
              myDiscardsBitfield,
              iStarted ? opponentHandRef.current : playerHandRef.current,
              iStarted ? playerHandRef.current : opponentHandRef.current,
              evt.OpponentMoved.readable,
            );
            setOutcome(newOutcome);

            if (!iStarted && currentMove === 2) {
              try {
                gameObjectRef.current?.makeMove(gameIdRef.current, null);
              } catch (e) {
                console.error('makeMove (final reveal) failed:', e);
              }
            }

            onOutcome(newOutcome);
          }
        } else if ('GameMessage' in evt) {
          try {
            const cards = parseCards(evt.GameMessage.readable, iStarted);
            setPlayerHand(cards.playerHand);
            setOpponentHand(cards.opponentHand);
            playerHandRef.current = cards.playerHand;
            opponentHandRef.current = cards.opponentHand;
          } catch (e) {
            console.error('parseCards failed:', e, 'readable:', evt.GameMessage.readable);
          }
        } else if ('_terminal' in evt) {
          handFinishedRef.current = true;
          gameObjectRef.current?.setHandState(null);
        }
      },
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [gameplayEvent$, iStarted, onOutcome, onTurnChanged]);

  const submitMove1 = useCallback(() => {
    const go = gameObjectRef.current;
    if (!go || !go.isChannelReady()) return;
    const gid = gameIdRef.current;
    if (!gid) return;
    if (cardSelectionsRef.current.length !== 4) return;
    const cards = cardSelectionsRef.current;
    go.makeMove(gid, Program.fromList(cards.map(c => Program.fromInt(c))));
    setMoveNumber(2);
    moveNumberRef.current = 2;
    setMyTurn(false);
    onTurnChanged(false);
    pendingPlayRef.current = false;
  }, [onTurnChanged]);

  const handleMakeMove = useCallback(() => {
    const go = gameObjectRef.current;
    if (!go || !go.isChannelReady()) return;
    const gid = gameIdRef.current;
    if (!gid) return;

    const currentMove = moveNumberRef.current;

    if (currentMove === 0) {
      go.makeMove(gid, null);
      setMoveNumber(1);
      moveNumberRef.current = 1;
      setMyTurn(false);
      onTurnChanged(false);
    } else if (currentMove === 1) {
      if (cardSelectionsRef.current.length !== 4) return;
      if (isPlayerTurnRef.current) {
        submitMove1();
      } else {
        pendingPlayRef.current = true;
      }
    } else if (currentMove === 2) {
      go.makeMove(gid, null);
      setMoveNumber(3);
      moveNumberRef.current = 3;
      setMyTurn(false);
      onTurnChanged(false);
    }
  }, [onTurnChanged, submitMove1]);

  // Autofire moves 0 and 2; auto-submit queued move 1
  useEffect(() => {
    if (restoredRef.current) { restoredRef.current = false; return; }
    if (!isPlayerTurn) return;
    const m = moveNumberRef.current;
    if (m === 0 || m === 2) {
      handleMakeMove();
    } else if (m === 1 && pendingPlayRef.current) {
      submitMove1();
    }
  }, [isPlayerTurn, moveNumber, handleMakeMove, submitMove1]);

  useEffect(() => {
    if (playerHand.length > 0) {
      gameObject.setHandState({ playerHand, opponentHand, moveNumber, isPlayerTurn });
    }
  }, [playerHand, opponentHand, moveNumber, isPlayerTurn, gameObject]);

  const handleCheat = useCallback(() => {
    const go = gameObjectRef.current;
    const gid = gameIdRef.current;
    if (!go || !gid) return;
    go.cheat(gid, 0);
  }, []);

  const setCardSelections = useCallback((selectionsOrFn: number[] | ((prev: number[]) => number[])) => {
    if (typeof selectionsOrFn === 'function') {
      setOurCardSelections(prev => {
        const next = selectionsOrFn(prev);
        cardSelectionsRef.current = next;
        return next;
      });
    } else {
      setOurCardSelections(selectionsOrFn);
      cardSelectionsRef.current = selectionsOrFn;
    }
  }, []);

  return {
    playerHand,
    opponentHand,
    cardSelections,
    setCardSelections,
    moveNumber,
    outcome,
    handleMakeMove,
    handleCheat,
  };
}
