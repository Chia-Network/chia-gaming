import { useState, useEffect, useCallback, useRef } from 'react';
// Types
import {
  BestHandType,
  CaliforniapokerProps,
  CardValueSuit,
  MovingCardData,
} from '../../../types/californiaPoker';
// Constants
import {
  GAME_STATES,
  SWAP_ANIMATION_DURATION,
} from './constants/constants';

// Utils
import { formatHandDescription, makeDescription, formatCardsForLog, formatOrderedCardsForLog, orderUsedCardsForLog } from './utils';
import { HandDisplay, MovingCard } from './components';
import {
  CalpokerOutcome,
  cardIdToRankSuit,
  handValueToDescription,
} from '../../../types/ChiaGaming';
import { SuitName } from '../../../types/californiaPoker/CardValueSuit';
import { CalpokerDisplaySnapshot } from '../../../hooks/save';
import GameBottomBar from './components/GameBottomBar';
import { Button } from '../../../components/button';

function translateTopline(topline: string | undefined): string | null {
  if (!topline) return null;
  const res = { win: 'player', lose: 'ai' }[topline];
  return res ? res : 'tie';
}

// Main Component
const CaliforniaPoker: React.FC<CaliforniapokerProps> = ({
  moveNumber,
  playerNumber,
  playerHand,
  opponentHand,
  cardSelections,
  setCardSelections,
  handleMakeMove,
  outcome,
  myWinOutcome,
  onDisplayComplete,
  onGameLog,
  onSnapshotChange,
  initialSnapshot,
  myName,
  opponentName,
  onPlayAgain,
  onEndSession,
  showBetweenHandActions,
}) => {
  const [gameState, setGameState] = useState(GAME_STATES.INITIAL);
  // const [playerCards, setPlayerHand] = useState<CardValueSuit[]>([]);
  const suitMap: Record<number, SuitName> = {
    0: 'Q',
    1: '♠',
    2: '♥',
    3: '♦',
    4: '♣',
  };

  const wrapperRef = useRef<HTMLDivElement>(null);
  const [playerCards, setPlayerCards] = useState<CardValueSuit[]>([]);
  const [opponentCards, setOpponentCards] = useState<CardValueSuit[]>([]);
  const [rememberedOutcome, setRememberedOutcome] = useState<
    CalpokerOutcome | undefined
  >(undefined);
  const rememberedCardsRef = useRef<CardValueSuit[][]>([[], []]);
  const [playerDisplayText, setPlayerDisplayText] = useState<string>('');
  const [opponentDisplayText, setOpponentDisplayText] = useState<string>('');

  const cvsFromCard = (cardId: number): CardValueSuit => {
    const { rank, suit } = cardIdToRankSuit(cardId);
    return { rank, suit: suitMap[suit], cardId };
  };

  useEffect(() => {
    if (outcome) {
      setRememberedOutcome(outcome);
    }
    if (restoredFromSnapshot.current) return;
    const inAnimation =
      gameState === GAME_STATES.AWAITING_SWAP ||
      gameState === GAME_STATES.SWAPPING ||
      gameState === GAME_STATES.FINAL;
    if (!inAnimation) {
      const mappedPlayer = playerHand.map(cvsFromCard);
      const mappedOpponent = opponentHand.map(cvsFromCard);
      setPlayerCards(mappedPlayer);
      setOpponentCards(mappedOpponent);
      if (mappedPlayer.length && mappedOpponent.length) {
        rememberedCardsRef.current = [mappedPlayer, mappedOpponent];
      }
    }
  }, [playerHand, opponentHand, outcome, gameState]);

  useEffect(() => {
    const haveOutcome = outcome ? outcome : rememberedOutcome;
    if (
      haveOutcome &&
      gameState === GAME_STATES.AWAITING_SWAP
    ) {
      swapCards(haveOutcome);
    }
  }, [outcome, gameState, moveNumber, rememberedOutcome]);

  // const [opponentCards, setAiHand] = useState<CardValueSuit[]>([]);
  const [winner, setWinner] = useState<string | null>(null);
  const [playerBestHand, setPlayerBestHand] = useState<
    BestHandType | undefined
  >();
  const [aiBestHand, setAiBestHand] = useState<BestHandType | undefined>();
  const [showSwapAnimation, setShowSwapAnimation] = useState(false);
  const [newHandWaiting, setNewHandWaiting] = useState(false);
  const [movingCards, setMovingCards] = useState<MovingCardData[]>([]);
  const [playerHaloCardIds, setPlayerHaloCardIds] = useState<number[]>([]);
  const [opponentHaloCardIds, setOpponentHaloCardIds] = useState<number[]>([]);

  const dealCards = () => {
    setGameState(GAME_STATES.SELECTING);
    setCardSelections([]);
    setWinner(null);
    saveSnapshot(
      GAME_STATES.SELECTING, [], [], [], null, undefined, undefined, [], [], '', '',
    );
  };

  const toggleCardSelection = (cardId: number) => {
    if (gameState !== GAME_STATES.SELECTING) return;

    setCardSelections((prev: number[]) => {
      if (prev.includes(cardId)) {
        return prev.filter((id) => id !== cardId);
      }
      return [...prev, cardId];
    });
  };

  const handleReorder = useCallback((reordered: CardValueSuit[]) => {
    setPlayerCards(reordered);
    rememberedCardsRef.current = [reordered, rememberedCardsRef.current[1]];
  }, []);

  // Keyboard: 1-8 toggles the card at that position
  const playerCardsRef = useRef<CardValueSuit[]>(playerCards);
  playerCardsRef.current = playerCards;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (gameState !== GAME_STATES.SELECTING) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key >= '1' && e.key <= '8') {
        const index = parseInt(e.key) - 1;
        const cards = playerCardsRef.current;
        if (index < cards.length && cards[index].cardId !== undefined) {
          setCardSelections((prev: number[]) => {
            const cardId = cards[index].cardId!;
            if (prev.includes(cardId)) {
              return prev.filter((id) => id !== cardId);
            }
            return [...prev, cardId];
          });
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [gameState, setCardSelections]);

  const isDisabled =
    cardSelections.length !== 4;

  const playerHalos = gameState === GAME_STATES.SELECTING
    ? cardSelections
    : playerHaloCardIds;
  const opponentHalos = opponentHaloCardIds;

  const buttonText = cardSelections.length === 4
    ? 'Play Selected Cards'
    : `Select 4 cards (${cardSelections.length}/4)`;

  const opponentLabel = opponentName ?? 'Opponent';
  const myLabel = myName ?? 'You';
  const showFinalHeader = !!winner && !showSwapAnimation;
  const opponentResultVerb = winner === 'tie' ? 'ties' : winner === 'ai' ? 'wins' : 'loses';
  const playerResultVerb = winner === 'tie' ? 'ties' : winner === 'player' ? 'wins' : 'loses';

  const doHandleMakeMove = () => {
    if (gameState === GAME_STATES.SELECTING && cardSelections.length > 0) {
      const halos = [...cardSelections];
      setPlayerHaloCardIds(halos);
      setGameState(GAME_STATES.AWAITING_SWAP);
      saveSnapshot(
        GAME_STATES.AWAITING_SWAP, playerCards, opponentCards, cardSelections,
        null, undefined, undefined, halos, [], '', '',
      );
    }

    handleMakeMove();
  };

  //
  // playerSwapCardIds are the player cards given to the opponent.
  // aiSwapCardIds are the opponent cards given to the player.
  // playerCards and opponentCards are the local card data.
  //
  const calculateMovingCards = (
    playerSwapCardIds: number[],
    aiSwapCardIds: number[],
    playerCards: CardValueSuit[],
    opponentCards: CardValueSuit[],
  ): MovingCardData[] => {
    const movingCardData: MovingCardData[] = [];
    const usedPlayerCards = new Set<number>();
    const usedAiCards = new Set<number>();

    const wrapperRect = wrapperRef.current?.getBoundingClientRect();
    const offsetX = wrapperRect?.left ?? 0;
    const offsetY = wrapperRect?.top ?? 0;

    // Prefixes for DOM selectors (myPrefix = viewer's hand in DOM)
    const myPrefix = 'player';
    const oppPrefix = 'ai';

    const sortByDomX = (ids: number[], prefix: string) =>
      [...ids].sort((a, b) => {
        const elA = document.querySelector(`[data-card-id="${prefix}-${a}"]`);
        const elB = document.querySelector(`[data-card-id="${prefix}-${b}"]`);
        if (!elA || !elB) return 0;
        return elA.getBoundingClientRect().left - elB.getBoundingClientRect().left;
      });
    const sortedPlayerSwaps = sortByDomX(playerSwapCardIds, myPrefix);
    const sortedAiSwaps = sortByDomX(aiSwapCardIds, oppPrefix);

    // Player -> Opponent animations
    sortedPlayerSwaps.forEach((swapCardId, i) => {
      const aiCardId = sortedAiSwaps[i];
      if (aiCardId === undefined) {
        return;
      }
      usedPlayerCards.add(swapCardId);

      const mySource = document.querySelector(
        `[data-card-id="${myPrefix}-${swapCardId}"]`,
      );
      const oppTarget = document.querySelector(
        `[data-card-id="${oppPrefix}-${aiCardId}"]`,
      );

      if (mySource && oppTarget) {
        const myRect = (mySource as Element).getBoundingClientRect();
        const oppRect = (oppTarget as Element).getBoundingClientRect();

        const card = playerCards.find((c) => c.cardId === swapCardId);
        if (!card) {
          return;
        }
        movingCardData.push({
          id: `${myPrefix}-to-${oppPrefix}-${swapCardId}`,
          card,
          startX: myRect.left - offsetX,
          startY: myRect.top - offsetY,
          endX: oppRect.left - offsetX,
          endY: oppRect.top - offsetY,
          width: myRect.width,
          height: myRect.height,
          direction: 'playerToAi',
          zIndex: 0,
        });
      }
    });

    // Opponent -> Player animations
    sortedAiSwaps.forEach((swapCardId, i) => {
      const playerCardId = sortedPlayerSwaps[i];
      if (playerCardId === undefined) {
        return;
      }
      usedAiCards.add(swapCardId);

      const oppSource = document.querySelector(
        `[data-card-id="${oppPrefix}-${swapCardId}"]`,
      );
      const myTarget = document.querySelector(
        `[data-card-id="${myPrefix}-${playerCardId}"]`,
      );

      if (oppSource && myTarget) {
        const oppRect = (oppSource as Element).getBoundingClientRect();
        const myRect = (myTarget as Element).getBoundingClientRect();

        const card = opponentCards.find((c) => c.cardId === swapCardId);
        if (!card) {
          return;
        }
        movingCardData.push({
          id: `${oppPrefix}-to-${myPrefix}-${swapCardId}`,
          card,
          startX: oppRect.left - offsetX,
          startY: oppRect.top - offsetY,
          endX: myRect.left - offsetX,
          endY: myRect.top - offsetY,
          width: oppRect.width,
          height: oppRect.height,
          direction: 'aiToPlayer',
          zIndex: 0,
        });
      }
    });

    const selfCardAnimate = (
      myPrefix: string,
      usedCards: Set<number>,
      card: CardValueSuit,
      i: number,
    ) => {
      if (card.cardId === undefined) {
        return;
      }
      if (usedCards.has(card.cardId)) {
        return;
      }
      // source = dest
      const source = document.querySelector(
        `[data-card-id="${myPrefix}-${card.cardId}"]`,
      );
      if (source) {
        const myRect = (source as Element).getBoundingClientRect();
        movingCardData.push({
          id: `${myPrefix}-to-${myPrefix}-${card.cardId}`,
          card,
          startX: myRect.left - offsetX,
          startY: myRect.top - offsetY,
          endX: myRect.left - offsetX,
          endY: myRect.top - offsetY,
          width: myRect.width,
          height: myRect.height,
          direction: 'self',
          zIndex: 0,
        });
      }
    };

    playerCards.forEach((card, i) =>
      selfCardAnimate(myPrefix, usedPlayerCards, card, i),
    );
    opponentCards.forEach((card, i) =>
      selfCardAnimate(oppPrefix, usedAiCards, card, i),
    );

    // Assign z-indexes: player swap cards highest (rightmost first),
    // then opponent swap cards (rightmost first), then non-swapping cards lowest.
    const playerSwaps = movingCardData
      .filter(c => c.direction === 'playerToAi')
      .sort((a, b) => b.startX - a.startX);
    const aiSwaps = movingCardData
      .filter(c => c.direction === 'aiToPlayer')
      .sort((a, b) => b.startX - a.startX);
    let z = 100;
    for (const c of playerSwaps) { c.zIndex = z--; }
    for (const c of aiSwaps) { c.zIndex = z--; }
    for (const c of movingCardData) {
      if (c.direction === 'self') c.zIndex = 50;
    }

    return movingCardData;
  };

  const swapCards = (rememberedOutcome: CalpokerOutcome) => {
    const liveWinner = translateTopline(rememberedOutcome.my_win_outcome);
    setWinner(liveWinner);
    setGameState(GAME_STATES.SWAPPING);

    const playerOriginal = rememberedOutcome.my_cards;
    const opponentOriginal = rememberedOutcome.their_cards;
    const playerFinal = rememberedOutcome.my_final_hand;
    const opponentFinal = rememberedOutcome.their_final_hand;

    const playerFinalSet = new Set(playerFinal);
    const opponentFinalSet = new Set(opponentFinal);
    const playerDiscardIds = playerOriginal.filter(id => !playerFinalSet.has(id));
    const opponentDiscardIds = opponentOriginal.filter(id => !opponentFinalSet.has(id));

    const playerKeptIds = playerOriginal.filter(id => playerFinalSet.has(id));
    const opponentKeptIds = opponentOriginal.filter(id => opponentFinalSet.has(id));
    const resultWord = rememberedOutcome.my_win_outcome === 'win' ? 'Win'
                     : rememberedOutcome.my_win_outcome === 'lose' ? 'Lose' : 'Tie';
    const myOrdered = orderUsedCardsForLog(rememberedOutcome.my_used_cards, rememberedOutcome.my_hand_value);
    const theirOrdered = orderUsedCardsForLog(rememberedOutcome.their_used_cards, rememberedOutcome.their_hand_value);
    onGameLog([
      `${formatCardsForLog(playerKeptIds)} give ${formatCardsForLog(playerDiscardIds)}`,
      `${formatCardsForLog(opponentKeptIds)} give ${formatCardsForLog(opponentDiscardIds)}`,
      `${resultWord} ${formatOrderedCardsForLog(myOrdered)} vs ${formatOrderedCardsForLog(theirOrdered)}`,
    ]);

    setPlayerHaloCardIds(playerDiscardIds);
    setOpponentHaloCardIds(opponentDiscardIds);

    const playerSwapCardIds = playerDiscardIds;
    const aiSwapCardIds = opponentDiscardIds;

    const remembered = rememberedCardsRef.current;
    const movingCardData = calculateMovingCards(
      playerSwapCardIds,
      aiSwapCardIds,
      remembered[0],
      remembered[1],
    );
    setMovingCards(movingCardData);
    setShowSwapAnimation(true);

    setTimeout(() => {
      const playerDiscardToIncoming = new Map<number, number>();
      for (let i = 0; i < playerSwapCardIds.length; i++) {
        playerDiscardToIncoming.set(playerSwapCardIds[i], aiSwapCardIds[i]);
      }
      const opponentDiscardToIncoming = new Map<number, number>();
      for (let i = 0; i < aiSwapCardIds.length; i++) {
        opponentDiscardToIncoming.set(aiSwapCardIds[i], playerSwapCardIds[i]);
      }

      const ref = rememberedCardsRef.current;
      const newPlayer = ref[0].map(c => {
        const incoming = playerDiscardToIncoming.get(c.cardId!);
        return incoming !== undefined ? cvsFromCard(incoming) : c;
      });
      const newOpponent = ref[1].map(c => {
        const incoming = opponentDiscardToIncoming.get(c.cardId!);
        return incoming !== undefined ? cvsFromCard(incoming) : c;
      });

      setPlayerCards(newPlayer);
      setOpponentCards(newOpponent);
      rememberedCardsRef.current = [newPlayer, newOpponent];

      setPlayerHaloCardIds(aiSwapCardIds);
      setOpponentHaloCardIds(playerSwapCardIds);

      const myUsedCards = rememberedOutcome.my_used_cards;
      const oppUsedCards = rememberedOutcome.their_used_cards;
      const myHandValue = rememberedOutcome.my_hand_value;
      const oppHandValue = rememberedOutcome.their_hand_value;

      const playerBestCards: CardValueSuit[] = myUsedCards.map(cvsFromCard);
      const opponentBestCards: CardValueSuit[] = oppUsedCards.map(cvsFromCard);

      setPlayerBestHand({
        cards: playerBestCards,
        rank: { name: '', score: 0, tiebreakers: [] },
      });
      setAiBestHand({
        cards: opponentBestCards,
        rank: { name: '', score: 0, tiebreakers: [] },
      });

      setMovingCards([]);
      setShowSwapAnimation(false);
      setGameState(GAME_STATES.FINAL);
      const pText = makeDescription(handValueToDescription(myHandValue, myUsedCards));
      const oText = makeDescription(handValueToDescription(oppHandValue, oppUsedCards));
      setPlayerDisplayText(pText);
      setOpponentDisplayText(oText);
      const pBest: BestHandType = {
        cards: playerBestCards,
        rank: { name: '', score: 0, tiebreakers: [] },
      };
      const oBest: BestHandType = {
        cards: opponentBestCards,
        rank: { name: '', score: 0, tiebreakers: [] },
      };
      saveSnapshot(
        GAME_STATES.FINAL, newPlayer, newOpponent, cardSelections,
        liveWinner, pBest, oBest, aiSwapCardIds, playerSwapCardIds, pText, oText,
      );
      onDisplayComplete();
    }, SWAP_ANIMATION_DURATION);
  };

  const saveSnapshot = useCallback((
    gs: string,
    pCards: CardValueSuit[],
    oCards: CardValueSuit[],
    sel: number[],
    w: string | null,
    pBest: BestHandType | undefined,
    oBest: BestHandType | undefined,
    pHalo: number[],
    oHalo: number[],
    pText: string,
    oText: string,
  ) => {
    const snap: CalpokerDisplaySnapshot = {
      gameState: gs,
      playerCardIds: pCards.map(c => c.cardId!),
      opponentCardIds: oCards.map(c => c.cardId!),
      cardSelections: sel,
      winner: w,
      playerBestHandCardIds: pBest?.cards.map(c => c.cardId!) ?? [],
      opponentBestHandCardIds: oBest?.cards.map(c => c.cardId!) ?? [],
      playerHaloCardIds: pHalo,
      opponentHaloCardIds: oHalo,
      playerDisplayText: pText,
      opponentDisplayText: oText,
    };
    onSnapshotChange(snap);
  }, [onSnapshotChange]);

  useEffect(() => {
    if (initialSnapshot) {
      const snap = initialSnapshot;
      const pCards = snap.playerCardIds.map(cvsFromCard);
      const oCards = snap.opponentCardIds.map(cvsFromCard);
      setPlayerCards(pCards);
      setOpponentCards(oCards);
      rememberedCardsRef.current = [pCards, oCards];
      setGameState(snap.gameState);
      setWinner(snap.winner);
      setPlayerHaloCardIds(snap.playerHaloCardIds);
      setOpponentHaloCardIds(snap.opponentHaloCardIds);
      setPlayerDisplayText(snap.playerDisplayText);
      setOpponentDisplayText(snap.opponentDisplayText);
      if (snap.playerBestHandCardIds.length > 0) {
        setPlayerBestHand({
          cards: snap.playerBestHandCardIds.map(cvsFromCard),
          rank: { name: '', score: 0, tiebreakers: [] },
        });
      }
      if (snap.opponentBestHandCardIds.length > 0) {
        setAiBestHand({
          cards: snap.opponentBestHandCardIds.map(cvsFromCard),
          rank: { name: '', score: 0, tiebreakers: [] },
        });
      }
    } else {
      dealCards();
    }
  }, []);

  const restoredFromSnapshot = useRef(!!initialSnapshot);
  useEffect(() => {
    if (restoredFromSnapshot.current) return;
    if (
      moveNumber === 0 &&
      !showSwapAnimation &&
      gameState !== GAME_STATES.AWAITING_SWAP &&
      gameState !== GAME_STATES.SWAPPING &&
      gameState !== GAME_STATES.FINAL
    ) {
      setGameState(GAME_STATES.SELECTING);
      rememberedCardsRef.current = [[], []];
      setRememberedOutcome(undefined);
      setWinner(null);
      setMovingCards([]);
      setPlayerBestHand(undefined);
      setAiBestHand(undefined);
      setShowSwapAnimation(false);
      setPlayerDisplayText('');
      setOpponentDisplayText('');
      setPlayerHaloCardIds([]);
      setOpponentHaloCardIds([]);
    }
  }, [moveNumber, showSwapAnimation, gameState]);
  return (
    <div ref={wrapperRef} className='relative flex flex-col w-full text-canvas-text'>
      {gameState !== GAME_STATES.INITIAL ? (
        <div className='flex flex-col gap-2'>
          {/* Hands region */}
          <div className='flex flex-col gap-2'>
            <div className='flex flex-col py-0 w-full rounded-md'>
              <div className='w-full py-1 text-base font-semibold text-canvas-text text-center'>
                {showFinalHeader && opponentDisplayText
                  ? `${opponentLabel} ${opponentResultVerb} (${opponentDisplayText})`
                  : `${opponentLabel}'s Hand`}
              </div>
              <div className='flex items-center justify-center p-2'>
                <HandDisplay
                  title=''
                  cards={
                    opponentCards.length ? opponentCards : rememberedCardsRef.current[1]
                  }
                  playerNumber={playerNumber == 1 ? 2 : 1}
                  area='ai'
                  winner={winner}
                  winnerType='ai'
                  bestHand={aiBestHand}
                  showSwapAnimation={showSwapAnimation}
                  gameState={gameState}
                  haloCardIds={opponentHalos}
                  formatHandDescription={formatHandDescription}
                  selectedCards={[]}
                />
              </div>
            </div>

            <div className='flex flex-col py-0 w-full rounded-md'>
              <div className='w-full py-1 text-base font-semibold text-canvas-text text-center'>
                {showFinalHeader && playerDisplayText
                  ? `${myLabel} ${playerResultVerb} (${playerDisplayText})`
                  : `${myLabel}'s Hand`}
              </div>
              <div className='flex items-center justify-center p-2'>
                <HandDisplay
                  title=''
                  cards={
                    playerCards.length ? playerCards : rememberedCardsRef.current[0]
                  }
                  playerNumber={playerNumber}
                  area='player'
                  winner={winner}
                  winnerType='player'
                  bestHand={playerBestHand}
                  onCardClick={toggleCardSelection}
                  selectedCards={cardSelections}
                  showSwapAnimation={showSwapAnimation}
                  gameState={gameState}
                  haloCardIds={playerHalos}
                  onReorder={gameState === GAME_STATES.SELECTING ? handleReorder : undefined}
                  formatHandDescription={formatHandDescription}
                />
              </div>
            </div>
          </div>

          {/* Action bar at the bottom, natural height */}
          {gameState === GAME_STATES.SELECTING && moveNumber === 1 && (
            <GameBottomBar
              buttonText={buttonText}
              isDisabled={isDisabled}
              doHandleMakeMove={doHandleMakeMove}
            />
          )}
          {gameState === GAME_STATES.AWAITING_SWAP && (
            <div className='flex-shrink-0 flex p-2 items-center justify-center'>
              <div className='rounded-md bg-canvas-bg px-4 py-2 text-sm font-medium text-canvas-text shadow-md'>
                Waiting for opponent
              </div>
            </div>
          )}
          {showBetweenHandActions && gameState === GAME_STATES.FINAL && (
            <div className='flex-shrink-0 relative flex p-2 items-center justify-center'>
              <Button
                variant='destructive'
                size='sm'
                onClick={onEndSession}
                className='absolute left-2 px-4 py-2'
              >
                End Session
              </Button>
              <Button
                variant='solid'
                color='primary'
                onClick={() => { setNewHandWaiting(true); onPlayAgain?.(); }}
                disabled={newHandWaiting}
                className='px-4 py-2'
              >
                {newHandWaiting ? 'Waiting' : 'New Hand'}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className='flex flex-1 items-center justify-center'>
          <span className='text-canvas-text'>Waiting…</span>
        </div>
      )}

      {/* Animations */}
      {movingCards.map((cardData) => (
        <MovingCard
          key={cardData.id}
          cardData={cardData}
          showAnimation={showSwapAnimation}
        />
      ))}
    </div>
  );
};

export default CaliforniaPoker;