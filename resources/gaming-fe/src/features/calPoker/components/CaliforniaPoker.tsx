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
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';

import GameBottomBar from './components/GameBottomBar';
import { cn } from '../../../lib/utils';

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
  const [movingCards, setMovingCards] = useState<MovingCardData[]>([]);
  const [playerHaloCardIds, setPlayerHaloCardIds] = useState<number[]>([]);
  const [opponentHaloCardIds, setOpponentHaloCardIds] = useState<number[]>([]);

  const dealCards = () => {
    setGameState(GAME_STATES.SELECTING);
    setCardSelections([]);
    setWinner(null);
  };

  const toggleCardSelection = (cardId: number) => {
    if (gameState !== GAME_STATES.SELECTING) return;

    setCardSelections((prev: number[]) => {
      if (prev.includes(cardId)) {
        return prev.filter((id) => id !== cardId);
      } else if (prev.length < 4) {
        return [...prev, cardId];
      }
      return prev;
    });
  };

  const handleReorder = useCallback((reordered: CardValueSuit[]) => {
    setPlayerCards(reordered);
    rememberedCardsRef.current = [reordered, rememberedCardsRef.current[1]];
  }, []);

  const isDisabled =
    moveNumber !== 1 ||
    !(gameState === GAME_STATES.SELECTING && cardSelections.length === 4);

  const showAnimationPhase =
    gameState === GAME_STATES.SWAPPING || gameState === GAME_STATES.FINAL;

  const playerHalos = gameState === GAME_STATES.SELECTING
    ? cardSelections
    : playerHaloCardIds;
  const opponentHalos = opponentHaloCardIds;

  const buttonText = showAnimationPhase
    ? '\u00A0'
    : moveNumber !== 1 || gameState !== GAME_STATES.SELECTING
      ? 'Waiting…'
      : cardSelections.length === 4
        ? 'Play Selected Cards'
        : `Select 4 cards (${cardSelections.length}/4)`;

  const doHandleMakeMove = () => {
    if (gameState === GAME_STATES.SELECTING && cardSelections.length > 0) {
      setPlayerHaloCardIds([...cardSelections]);
      setGameState(GAME_STATES.AWAITING_SWAP);
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
      setPlayerDisplayText(makeDescription(handValueToDescription(myHandValue, myUsedCards)));
      setOpponentDisplayText(makeDescription(handValueToDescription(oppHandValue, oppUsedCards)));
      onDisplayComplete();
    }, SWAP_ANIMATION_DURATION);
  };

  useEffect(() => {
    dealCards();
  }, []);

  useEffect(() => {
    // Reset when moveNumber goes to 0 and no animation is in progress.
    // With key-based remounting, this mostly fires on initial mount.
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
            <Card className='flex flex-col py-0 w-full border border-canvas-line shadow-md'>
              <CardHeader className='flex-shrink-0 p-0 w-full flex-row flex justify-center items-center'>
                <CardTitle className='w-full pl-4 py-1 text-base flex-col sm:flex-row flex items-start gap-2'>
                  <span className='text-base font-semibold text-alert-text'>
                    Opponent Hand
                  </span>
                  {opponentDisplayText && (
                    <span className='text-canvas-text'>
                      ({opponentDisplayText})
                    </span>
                  )}
                  {winner && !showSwapAnimation && (
                    <span
                      className={cn(
                        'px-2 py-0.5 rounded-md text-xs font-medium',
                        winner === 'ai'
                          ? 'bg-success-solid text-success-on-success'
                          : 'bg-alert-solid text-alert-on-alert',
                      )}
                    >
                      {winner === 'ai' ? 'Winner' : 'Loser'}
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className='flex items-center justify-center p-2'>
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
              </CardContent>
            </Card>

            <Card className='flex flex-col py-0 w-full border border-canvas-line shadow-md'>
              <CardHeader className='flex-shrink-0 p-0 w-full flex-row flex justify-center items-center'>
                <CardTitle className='w-full pl-4 py-1 text-base flex-col sm:flex-row flex items-start gap-2'>
                  <span className='font-semibold text-success-text'>
                    Your Hand
                  </span>
                  {playerDisplayText && (
                    <span className='text-canvas-text'>
                      ({playerDisplayText})
                    </span>
                  )}
                  {winner && !showSwapAnimation && (
                    <span
                      className={cn(
                        'px-2 py-0.5 rounded-md text-xs font-medium',
                        winner === 'player'
                          ? 'bg-success-solid text-success-on-success'
                          : 'bg-alert-solid text-alert-on-alert',
                      )}
                    >
                      {winner === 'player' ? 'Winner' : 'Loser'}
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className='flex items-center justify-center p-2'>
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
              </CardContent>
            </Card>
          </div>

          {/* Action bar at the bottom, natural height */}
          <GameBottomBar
            buttonText={buttonText}
            isDisabled={isDisabled}
            doHandleMakeMove={doHandleMakeMove}
          />
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