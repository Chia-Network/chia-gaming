import { useState, useEffect, useCallback, useRef } from 'react';
import { Program } from 'clvm-lib';
import { Observable } from 'rxjs';
import {
  CalpokerOutcome,
  handValueToDescription,
} from '../types/ChiaGaming';
import { makeDescription } from '../features/calPoker/components/utils/MakeDescription';
import { WasmBlobWrapper } from './WasmBlobWrapper';

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
  isPlayerTurn: boolean;
  outcome: CalpokerOutcome | undefined;
  handleMakeMove: () => void;
  handleCheat: () => void;
}

export function useCalpokerHand(
  gameObject: WasmBlobWrapper,
  gameId: string,
  iStarted: boolean,
  gameplayEvent$: Observable<any>,
  onOutcome: (outcome: CalpokerOutcome) => void,
  onTurnChanged: (isMyTurn: boolean) => void,
  appendGameLog: (line: string) => void,
): UseCalpokerHandResult {
  const [playerHand, setPlayerHand] = useState<number[]>([]);
  const [opponentHand, setOpponentHand] = useState<number[]>([]);
  const [cardSelections, setOurCardSelections] = useState<number[]>([]);
  const [moveNumber, setMoveNumber] = useState<number>(0);
  const [isPlayerTurn, setMyTurn] = useState<boolean>(!iStarted);
  const [outcome, setOutcome] = useState<CalpokerOutcome | undefined>(undefined);

  const playerHandRef = useRef<number[]>([]);
  const opponentHandRef = useRef<number[]>([]);
  const cardSelectionsRef = useRef<number[]>([]);
  const moveNumberRef = useRef<number>(0);
  const gameObjectRef = useRef(gameObject);
  const gameIdRef = useRef(gameId);
  const handFinishedRef = useRef(false);

  playerHandRef.current = playerHand;
  opponentHandRef.current = opponentHand;
  cardSelectionsRef.current = cardSelections;
  moveNumberRef.current = moveNumber;
  gameObjectRef.current = gameObject;
  gameIdRef.current = gameId;

  useEffect(() => {
    const subscription = gameplayEvent$.subscribe({
      next: (evt: any) => {
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

            const iAmAlice = !iStarted;
            const myValue = iAmAlice ? newOutcome.alice_hand_value : newOutcome.bob_hand_value;
            const myCards = iAmAlice ? newOutcome.alice_used_cards : newOutcome.bob_used_cards;
            const theirValue = iAmAlice ? newOutcome.bob_hand_value : newOutcome.alice_hand_value;
            const theirCards = iAmAlice ? newOutcome.bob_used_cards : newOutcome.alice_used_cards;
            const myDesc = makeDescription(handValueToDescription(myValue, myCards));
            const theirDesc = makeDescription(handValueToDescription(theirValue, theirCards));
            const resultWord = newOutcome.my_win_outcome === 'win' ? 'You won' : newOutcome.my_win_outcome === 'lose' ? 'You lost' : 'Tied';
            appendGameLog(`${resultWord} — You: ${myDesc} vs Opponent: ${theirDesc}`);

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
        }
      },
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [gameplayEvent$, iStarted, onOutcome, onTurnChanged, appendGameLog]);

  const handleMakeMove = useCallback(() => {
    const go = gameObjectRef.current;
    if (!go || !go.isChannelReady()) return;
    const gid = gameIdRef.current;
    if (!gid) return;

    const currentMove = moveNumberRef.current;

    if (currentMove === 0) {
      go.makeMove(gid, null);
      const newMoveNum = currentMove + 1;
      setMoveNumber(newMoveNum);
      moveNumberRef.current = newMoveNum;
      setMyTurn(false);
      onTurnChanged(false);
    } else if (currentMove === 1) {
      if (cardSelectionsRef.current.length !== 4) return;
      const cards = cardSelectionsRef.current;
      go.makeMove(gid, Program.fromList(cards.map(c => Program.fromInt(c))));
      const newMoveNum = currentMove + 1;
      setMoveNumber(newMoveNum);
      moveNumberRef.current = newMoveNum;
      setMyTurn(false);
      onTurnChanged(false);
    } else if (currentMove === 2) {
      go.makeMove(gid, null);
      const newMoveNum = currentMove + 1;
      setMoveNumber(newMoveNum);
      moveNumberRef.current = newMoveNum;
      setMyTurn(false);
      onTurnChanged(false);
    }
  }, [onTurnChanged]);

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
    isPlayerTurn,
    outcome,
    handleMakeMove,
    handleCheat,
  };
}
