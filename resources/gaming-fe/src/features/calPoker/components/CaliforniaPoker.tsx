import { useState, useEffect } from 'react';
// Types
import {
  BestHandType,
  CaliforniapokerProps,
  CardValueSuit,
  MovingCardData,
  SwappingCards,
} from '../../../types/californiaPoker';
// Constants
import {
  BUTTON_ACTIVE,
  BUTTON_BASE,
  GAME_STATES,
  SWAP_ANIMATION_DURATION,
} from './constants/constants';

// Utils
import { formatHandDescription, makeDescription } from './utils';
import { HandDisplay, MovingCard } from './components';
import {
  CalpokerOutcome,
  OutcomeHandType,
  cardIdToRankSuit,
  suitNames,
} from '../../../types/ChiaGaming';
import { SuitName } from '../../../types/californiaPoker/CardValueSuit';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';
import { WalletIcon } from 'lucide-react';

import GameBottomBar from './components/GameBottomBar';
import { cn } from '../../../lib/utils';
import { EndGameDialog } from './components/AnotherHandPopup';

function translateTopline(topline: string | undefined): string | null {
  if (!topline) return null;
  const res = { win: 'player', lose: 'ai' }[topline];
  return res ? res : 'tie';
}

// Main Component
const CaliforniaPoker: React.FC<CaliforniapokerProps> = ({
  moveNumber,
  isPlayerTurn,
  playerNumber,
  playerHand,
  opponentHand,
  cardSelections,
  setCardSelections,
  handleMakeMove,
  outcome,
  log,
  myWinOutcome,
  banner,
  balanceDisplay,
  stopPlaying,
}) => {
  const isPlayerAlice = playerNumber === 1;
  const [gameState, setGameState] = useState(GAME_STATES.INITIAL);
  // const [playerCards, setPlayerHand] = useState<CardValueSuit[]>([]);
  const suitMap: Record<number, SuitName> = {
    0: 'Q',
    1: '♠',
    2: '♥',
    3: '♦',
    4: '♣',
  };

  const [, playerBalance, opponentBalance] =
    balanceDisplay.match(/(\d+)\s*vs\s*(\d+)/i) || [];
  const [playerCards, setPlayerCards] = useState<CardValueSuit[]>([]);
  const [opponentCards, setOpponentCards] = useState<CardValueSuit[]>([]);
  const [rememberedOutcome, setRememberedOutcome] = useState<
    CalpokerOutcome | undefined
  >(undefined);
  const [rememberedCards, setRememberedCards] = useState<CardValueSuit[][]>([
    playerCards,
    opponentCards,
  ]);
  const [playerDisplayText, setPlayerDisplayText] = useState<string>('');
  const [opponentDisplayText, setOpponentDisplayText] = useState<string>('');

  const cvsFromCard: (cardId: number, index: number) => CardValueSuit = (
    cardId,
    index,
  ) => {
    const { rank, suit } = cardIdToRankSuit(cardId);
    return {
      rank,
      suit: suitMap[suit],
      originalIndex: index,
      cardId,
    };
  };

  // whenever playerHand or aiHand changes → convert into CardValueSuit[]
  useEffect(() => {
    const mappedPlayer = playerHand.map(cvsFromCard);
    const mappedOpponent = opponentHand.map(cvsFromCard);

    setPlayerCards(mappedPlayer);
    setOpponentCards(mappedOpponent);
    if (mappedPlayer.length && mappedOpponent.length) {
      const newRemCards = [mappedPlayer, mappedOpponent];
      console.log('setRememberedCards', newRemCards);
      setRememberedCards(newRemCards);
    }
    if (outcome) {
      setRememberedOutcome(outcome);
    }
  }, [playerHand, opponentHand, outcome]);

  useEffect(() => {
    const haveOutcome = outcome ? outcome : rememberedOutcome;
    if (
      outcome &&
      moveNumber === 0 &&
      gameState === GAME_STATES.AWAITING_SWAP
    ) {
      console.log('outcome is', JSON.stringify(outcome));
      swapCards(outcome);
    }
  }, [outcome, gameState, moveNumber, rememberedOutcome]);

  // const [opponentCards, setAiHand] = useState<CardValueSuit[]>([]);
  const [winner, setWinner] = useState<string | null>(null);
  const [playerBestHand, setPlayerBestHand] = useState<
    BestHandType | undefined
  >();
  const [aiBestHand, setAiBestHand] = useState<BestHandType | undefined>();
  const [swappingCards, setSwappingCards] = useState<SwappingCards>({
    player: [],
    ai: [],
  });
  const [showSwapAnimation, setShowSwapAnimation] = useState(false);
  const [movingCards, setMovingCards] = useState<MovingCardData[]>([]);

  const dealCards = () => {
    setGameState(GAME_STATES.SELECTING);
    setCardSelections([]);
    setWinner(null);
  };
  const [showEndDialog, setShowEndDialog] = useState(false);
  const NewGame = () => {
    console.log('starting again');
    doHandleMakeMove();
    setGameState(GAME_STATES.SELECTING);
    setRememberedCards([[], []]);
    setWinner(null);
    setRememberedOutcome(undefined);
    setMovingCards([]);
    setCardSelections([]);
    setPlayerBestHand(undefined);
    setAiBestHand(undefined);
    setShowSwapAnimation(false);
    setPlayerDisplayText('');
    setOpponentDisplayText('');
    setSwappingCards({ player: [], ai: [] });
  };

  const toggleCardSelection = (cardId: number) => {
    if (gameState !== GAME_STATES.SELECTING) return;

    if (cardSelections.includes(cardId)) {
      const newSelection = cardSelections.filter((id) => id !== cardId);
      setCardSelections(newSelection);
    } else if (cardSelections.length < 4) {
      const newSelection = [...cardSelections, cardId];
      setCardSelections(newSelection);
    }
  };

  const isDisabled =
    !isPlayerTurn ||
    (moveNumber === 0
      ? false
      : moveNumber === 1
        ? !(
            (gameState === GAME_STATES.SELECTING &&
              cardSelections.length === 4) ||
            gameState === GAME_STATES.SWAPPING
          )
        : true);

  const isActive = !isDisabled; // single source of truth
  // ---------- TEXT ----------
  let buttonText = '';

  if (moveNumber === 0) {
    // Both players can start the game
    buttonText = 'Start Game';
  } else if (moveNumber === 1) {
    if (!isPlayerTurn) {
      buttonText = "Opponent's Move";
    } else {
      buttonText =
        cardSelections.length === 4
          ? 'Swap Cards'
          : `Select 4 cards (${cardSelections.length}/4)`;
    }
  } else {
    buttonText = 'Waiting for Opponent...';
  }

  const doHandleMakeMove = () => {
    const moveData = '80';

    if (gameState === GAME_STATES.SELECTING && cardSelections.length > 0) {
      setGameState(GAME_STATES.AWAITING_SWAP);
    }

    handleMakeMove(moveData);
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

    // Prefixes for DOM selectors (myPrefix = viewer's hand in DOM)
    const myPrefix = 'player';
    const oppPrefix = 'ai';

    // Player -> Opponent animations
    playerSwapCardIds.forEach((swapCardId, i) => {
      const aiCardId = aiSwapCardIds[i];
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
          startX: myRect.left,
          startY: myRect.top,
          endX: oppRect.left,
          endY: oppRect.top,
          width: myRect.width,
          height: myRect.height,
          direction: 'playerToAi',
        });
      }
    });

    // Opponent -> Player animations
    aiSwapCardIds.forEach((swapCardId, i) => {
      const playerCardId = playerSwapCardIds[i];
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
          startX: oppRect.left,
          startY: oppRect.top,
          endX: myRect.left,
          endY: myRect.top,
          width: oppRect.width,
          height: oppRect.height,
          direction: 'aiToPlayer',
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
          startX: myRect.left,
          startY: myRect.top,
          endX: myRect.left,
          endY: myRect.top,
          width: myRect.width,
          height: myRect.height,
          direction: 'payerToAi',
        });
      }
    };

    playerCards.forEach((card, i) =>
      selfCardAnimate(myPrefix, usedPlayerCards, card, i),
    );
    opponentCards.forEach((card, i) =>
      selfCardAnimate(oppPrefix, usedAiCards, card, i),
    );

    return movingCardData;
  };

  const swapCards = (rememberedOutcome: CalpokerOutcome) => {
    const liveWinner = translateTopline(rememberedOutcome.my_win_outcome);
    console.log('swapping, outcome', liveWinner, rememberedOutcome);
    setWinner(liveWinner);
    setGameState(GAME_STATES.SWAPPING);

    const playerSelected = isPlayerAlice
      ? rememberedOutcome.alice_discards
      : rememberedOutcome.bob_discards;
    const aiSelected = isPlayerAlice
      ? rememberedOutcome.bob_discards
      : rememberedOutcome.alice_discards;

    const playerSwapCardIds: number[] = rememberedCards[0]
      .filter((card) => (aiSelected & (1 << (card.originalIndex ?? 0))) !== 0)
      .map((card) => card.cardId)
      .filter((cardId): cardId is number => cardId !== undefined);
    const aiSwapCardIds: number[] = rememberedCards[1]
      .filter(
        (card) => (playerSelected & (1 << (card.originalIndex ?? 0))) !== 0,
      )
      .map((card) => card.cardId)
      .filter((cardId): cardId is number => cardId !== undefined);

    setSwappingCards({ player: rememberedCards[0], ai: rememberedCards[1] });
    console.log('calculate moving cards', playerSwapCardIds, aiSwapCardIds);
    const movingCardData = calculateMovingCards(
      playerSwapCardIds,
      aiSwapCardIds,
      rememberedCards[0],
      rememberedCards[1],
    );
    setMovingCards(movingCardData);
    console.log('moving cards', movingCardData);
    setShowSwapAnimation(true);

    setTimeout(() => {
      // Copy current hands
      const newPlayer = [...playerCards];
      const newOpponent = [...opponentCards];

      // Apply exact card swaps based on animation index mapping
      for (let i = 0; i < playerSwapCardIds.length; i++) {
        const pCardId = playerSwapCardIds[i];
        const aiCardId = aiSwapCardIds[i];
        if (pCardId === undefined || aiCardId === undefined) {
          continue;
        }
        const pIndex = newPlayer.findIndex((c) => c.cardId === pCardId);
        const aiIndex = newOpponent.findIndex((c) => c.cardId === aiCardId);
        if (pIndex === -1 || aiIndex === -1) {
          continue;
        }

        // Player gives card to AI
        newOpponent[aiIndex] = playerCards[pIndex];

        // AI gives card to Player
        newPlayer[pIndex] = opponentCards[aiIndex];
      }

      // Update UI
      setPlayerCards(newPlayer);
      setOpponentCards(newOpponent);

      // --- Best hands ---
      const lastLog = log[0];

      // Convert hand arrays into CardValueSuit objects
      const playerBestCards: CardValueSuit[] = lastLog.myHand.map((cardId, idx) =>
        cvsFromCard(cardId, idx),
      );

      const opponentBestCards: CardValueSuit[] = lastLog.opponentHand.map((cardId, idx) =>
        cvsFromCard(cardId, idx),
      );

      setPlayerBestHand({
        cards: playerBestCards,
        rank: { name: '', score: 0, tiebreakers: [] },
      });
      setAiBestHand({
        cards: opponentBestCards,
        rank: { name: '', score: 0, tiebreakers: [] },
      });

      console.log(
        'done swapping',
        log.length - 1,
        log,
        newPlayer,
        newOpponent,
        playerBestCards,
        opponentBestCards,
      );

      setMovingCards([]);
      setShowSwapAnimation(false);
      setGameState(GAME_STATES.FINAL);
      setPlayerDisplayText(makeDescription(log[0].myHandDescription));
      setOpponentDisplayText(makeDescription(log[0].opponentHandDescription));
    }, SWAP_ANIMATION_DURATION);
  };

  useEffect(() => {
    dealCards();
  }, []);

  useEffect(() => {
    if (gameState === GAME_STATES.FINAL) {
      setShowEndDialog(true);
    }
  }, [gameState]);
  return (
    <div className='flex flex-col w-full h-full overflow-hidden text-canvas-text'>
      <div className='flex-1 relative h-full overflow-y-auto overflow-x-hidden'>
        {gameState === GAME_STATES.INITIAL && (
          <div className='text-center'>
            <button
              onClick={dealCards}
              className={`${BUTTON_BASE} ${BUTTON_ACTIVE}`}
            >
              Deal Cards
            </button>
          </div>
        )}

        {gameState !== GAME_STATES.INITIAL && (
          <div className='flex flex-col gap-4 h-full flex-1 min-h-0'>
            <Card className='flex flex-col py-0 min-h-[260px] w-full flex-1 lg:flex-[0_0_43%] border border-canvas-line shadow-md overflow-hidden'>
              {/* Make Card relative so absolute div is positioned relative to it */}
              <CardHeader className='relative p-0 w-full flex-row flex justify-center items-center'>
                <CardTitle className='w-full pl-4 py-1 text-base flex-col sm:flex-row flex items-start gap-2'>
                  {/* Opponent Title */}
                  <span className='text-base font-semibold text-alert-text'>
                    Opponent Hand
                  </span>

                  {/* Dull Hand Description */}
                  {opponentDisplayText && (
                    <span className='text-canvas-text'>
                      ({opponentDisplayText})
                    </span>
                  )}

                  {/* Winner / Lost Badge */}
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

                <div className='flex justify-end'>
                  <div className=' flex items-center border border-canvas-line rounded-tr-md rounded-bl-md px-2 py-2 shadow-sm bg-canvas-bg'>
                    <WalletIcon size='19.6px' />
                    <span className='ml-2 font-bold text-sm text-canvas-text-contrast'>
                      {opponentBalance}
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className='flex-1 h-full mt-4 flex items-center justify-center p-2'>
                  <HandDisplay
                    title=''
                    cards={
                      opponentCards.length ? opponentCards : rememberedCards[1]
                    }
                    playerNumber={playerNumber == 1 ? 2 : 1}
                    area='ai'
                    winner={winner}
                    winnerType='ai'
                    bestHand={aiBestHand}
                    swappingCards={swappingCards.ai}
                    showSwapAnimation={showSwapAnimation}
                    gameState={gameState}
                    formatHandDescription={formatHandDescription}
                    selectedCards={[]}
                  />
                </div>
              </CardContent>
            </Card>

            <Card className='flex flex-col py-0 w-full flex-1 lg:flex-[0_0_43%] border border-canvas-line shadow-md overflow-hidden'>
              <CardHeader className='relative p-0 w-full flex-row flex justify-center items-center'>
                <CardTitle className='w-full pl-4 py-1 text-base  flex-col sm:flex-row  flex items-start gap-2'>
                  {/* Player Title */}
                  <span className='font-semibold text-success-text'>
                    Your Hand
                  </span>

                  {/* Dull Hand Description */}
                  {playerDisplayText && (
                    <span className='text-canvas-text'>
                      ({playerDisplayText})
                    </span>
                  )}

                  {/* Winner / Lost Badge */}
                  {winner && !showSwapAnimation && (
                    <span
                      className={cn(
                        'px-2 py-0.5 rounded-md  text-xs font-medium',
                        winner === 'player'
                          ? 'bg-success-solid text-success-on-success'
                          : 'bg-alert-solid text-alert-on-alert',
                      )}
                    >
                      {winner === 'player' ? 'Winner' : 'Loser'}
                    </span>
                  )}
                </CardTitle>

                <div className='flex justify-end'>
                  <div className=' flex items-center border border-canvas-line rounded-tr-md rounded-bl-md px-2 py-2 shadow-sm bg-canvas-bg'>
                    <WalletIcon size='19.6px' />
                    <span className='ml-2 font-bold text-sm text-canvas-text-contrast'>
                      {playerBalance}
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className='flex-1 mt-4 h-full flex items-center justify-center p-2'>
                  <HandDisplay
                    title=''
                    cards={
                      playerCards.length ? playerCards : rememberedCards[0]
                    }
                    playerNumber={playerNumber}
                    area='player'
                    winner={winner}
                    winnerType='player'
                    bestHand={playerBestHand}
                    onCardClick={toggleCardSelection}
                    selectedCards={cardSelections}
                    swappingCards={swappingCards.player}
                    showSwapAnimation={showSwapAnimation}
                    gameState={gameState}
                    formatHandDescription={formatHandDescription}
                  />
                </div>
              </CardContent>
            </Card>

            {/* ACTION BAR */}
            <GameBottomBar
              isPlayerTurn={isPlayerTurn}
              gameState={gameState}
              buttonText={buttonText}
              moveNumber={moveNumber}
              isDisabled={isDisabled}
              NewGame={NewGame}
              doHandleMakeMove={doHandleMakeMove}
              GAME_STATES={GAME_STATES}
            />
          </div>
        )}
      </div>
      <EndGameDialog
        open={showEndDialog}
        onOpenChange={setShowEndDialog}
        onPlayAgain={() => {
          setShowEndDialog(false);
          NewGame(); // your existing restart logic
        }}
        onEndSession={stopPlaying} // same handler as your destructive button
        disableEndSession={moveNumber !== 0}
      />
      {/* Animations */}
      {movingCards.map((cardData) => (
        <MovingCard
          key={cardData.id}
          cardData={cardData}
          showAnimation={showSwapAnimation}
        />
      ))}

      <style>{`
    .animate-move {
      animation: moveCard 2s ease-in-out forwards;
    }
    @keyframes moveCard {
      from { left: var(--start-x); top: var(--start-y); }
      to { left: var(--end-x); top: var(--end-y); }
    }
  `}</style>
    </div>
  );
};

export default CaliforniaPoker;
