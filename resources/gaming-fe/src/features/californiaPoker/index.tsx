import { useState, useRef, useEffect } from 'react';
// Types
import {
  BestHandType,
  CardValueSuit,
  MovingCardData,
  SwappingCards,
} from '../../types/californiaPoker';

// Constants
import {
  ANIMATION_DELAY,
  BUTTON_ACTIVE,
  BUTTON_BASE,
  BUTTON_DISABLED,
  GAME_STATES,
  SWAP_ANIMATION_DURATION,
} from './constants/constants';

// Utils
import {
  compareRanks,
  createDeck,
  evaluateHand,
  formatHandDescription,
  getCombinations,
  getSwapCombinations,
  scoreKeepCombination,
  shuffleArray,
  sortHand,
} from './utils';
import { HandDisplay, MovingCard } from './components';

// Main Component
const CaliforniaPoker = () => {
  const [gameState, setGameState] = useState(GAME_STATES.INITIAL);
  const [playerHand, setPlayerHand] = useState<CardValueSuit[]>([]);
  const [aiHand, setAiHand] = useState<CardValueSuit[]>([]);
  const [playerSelected, setPlayerSelected] = useState<number[]>([]);
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
    const deck = shuffleArray(createDeck());
    const playerCards: CardValueSuit[] = sortHand(deck.slice(0, 8));
    const aiCards: CardValueSuit[] = sortHand(deck.slice(8, 16));

    setPlayerHand(playerCards);
    setAiHand(aiCards);
    setGameState(GAME_STATES.SELECTING);
    setPlayerSelected([]);
    setWinner(null);
  };

  const toggleCardSelection = (cardIndex: number) => {
    if (gameState !== GAME_STATES.SELECTING) return;

    if (playerSelected.includes(cardIndex)) {
      setPlayerSelected(playerSelected.filter((i) => i !== cardIndex));
    } else if (playerSelected.length < 4) {
      setPlayerSelected([...playerSelected, cardIndex]);
    }
  };

  const aiSelectCards = () => {
    const allCombinations = getSwapCombinations();

    let bestScore = -1;
    let bestCombination = allCombinations[0];

    allCombinations.forEach((combination) => {
      const cardsToKeep = aiHand.filter(
        (_, index) => !combination.includes(index),
      );
      const score = scoreKeepCombination(cardsToKeep);

      if (score > bestScore) {
        bestScore = score;
        bestCombination = combination;
      }
    });

    return bestCombination;
  };

  const calculateMovingCards = (
    playerSwapIndices: number[],
    aiSwapIndices: number[],
  ) => {
    const movingCardData: MovingCardData[] = [];

    playerSwapIndices.forEach((playerCardIndex, swapIndex) => {
      const aiCardIndex = aiSwapIndices[swapIndex];

      const playerSource = document.querySelector(
        `[data-card-id="player-${playerCardIndex}"]`,
      );
      const aiTarget = document.querySelector(
        `[data-card-id="ai-${aiCardIndex}"]`,
      );
      const aiSource = document.querySelector(
        `[data-card-id="ai-${aiCardIndex}"]`,
      );
      const playerTarget = document.querySelector(
        `[data-card-id="player-${playerCardIndex}"]`,
      );

      if (playerSource && aiTarget) {
        const playerRect = playerSource.getBoundingClientRect();
        const aiRect = aiTarget.getBoundingClientRect();

        movingCardData.push({
          id: `player-to-ai-${playerCardIndex}`,
          card: playerHand[playerCardIndex],
          startX: playerRect.left,
          startY: playerRect.top,
          endX: aiRect.left,
          endY: aiRect.top,
          width: playerRect.width,
          height: playerRect.height,
          direction: 'playerToAi',
        });
      }

      if (aiSource && playerTarget) {
        const aiRect = aiSource.getBoundingClientRect();
        const playerRect = playerTarget.getBoundingClientRect();

        movingCardData.push({
          id: `ai-to-player-${aiCardIndex}`,
          card: aiHand[aiCardIndex],
          startX: aiRect.left,
          startY: aiRect.top,
          endX: playerRect.left,
          endY: playerRect.top,
          width: aiRect.width,
          height: aiRect.height,
          direction: 'aiToPlayer',
        });
      }
    });

    return movingCardData;
  };

  const swapCards = () => {
    if (playerSelected.length !== 4) return;

    const aiSelection = aiSelectCards();
    setGameState(GAME_STATES.SWAPPING);

    const playerSwapCards = playerSelected.map((i) => ({
      ...playerHand[i],
      originalIndex: i,
    }));
    const aiSwapCards = aiSelection.map((i: number) => ({
      ...aiHand[i],
      originalIndex: i,
    }));

    setSwappingCards({ player: playerSwapCards, ai: aiSwapCards });

    // Clear selections immediately after starting swap
    setPlayerSelected([]);

    setTimeout(() => {
      const movingCardData = calculateMovingCards(playerSelected, aiSelection);
      setMovingCards(movingCardData);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setShowSwapAnimation(true);
        });
      });
    }, ANIMATION_DELAY);

    setTimeout(() => {
      // Perform the swap
      const newPlayerHand = [...playerHand];
      const newAiHand = [...aiHand];

      playerSelected.forEach((playerIndex, swapIndex) => {
        const aiIndex = aiSelection[swapIndex];
        const tempCard = newPlayerHand[playerIndex];
        newPlayerHand[playerIndex] = newAiHand[aiIndex];
        newAiHand[aiIndex] = tempCard;
      });

      setPlayerHand(newPlayerHand);
      setAiHand(newAiHand);
      setShowSwapAnimation(false);
      setMovingCards([]);
      setGameState(GAME_STATES.FINAL);

      // Determine best hands and winner
      const playerBest: BestHandType = getBestHand(newPlayerHand);
      const aiBest: BestHandType = getBestHand(newAiHand);

      setPlayerBestHand(playerBest);
      setAiBestHand(aiBest);

      const comparison = compareRanks(playerBest.rank, aiBest.rank);
      setWinner(comparison > 0 ? 'player' : comparison < 0 ? 'ai' : 'tie');
    }, SWAP_ANIMATION_DURATION);
  };

  function getBestHand(cards: CardValueSuit[]): BestHandType {
    const combinations = getCombinations(cards);

    let bestHand = combinations[0];
    let bestRank = evaluateHand(combinations[0]);

    combinations.forEach((hand) => {
      const rank = evaluateHand(hand);
      if (compareRanks(rank, bestRank) > 0) {
        bestHand = hand;
        bestRank = rank;
      }
    });

    return { cards: bestHand, rank: bestRank };
  }

  useEffect(() => {
    dealCards();
  }, []);

  return (
    <div className='min-h-screen bg-gray-100 p-2'>
      <div className='max-w-6xl mx-auto game-container relative'>
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
          <>
            <div className='space-y-0'>
              <HandDisplay
                title='Opponent Hand'
                cards={aiHand}
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

              <div className='text-center'>
                <h1 className='text-2xl font-bold text-gray-400'>
                  California Poker
                </h1>
              </div>

              <HandDisplay
                title='Your Hand'
                cards={playerHand}
                area='player'
                winner={winner}
                winnerType='player'
                bestHand={playerBestHand}
                onCardClick={toggleCardSelection}
                selectedCards={playerSelected}
                swappingCards={swappingCards.player}
                showSwapAnimation={showSwapAnimation}
                gameState={gameState}
                formatHandDescription={formatHandDescription}
              />
            </div>

            <div className='text-center mt-1 h-10'>
              {(gameState === GAME_STATES.SELECTING ||
                gameState === GAME_STATES.SWAPPING) && (
                <>
                  <button
                    onClick={swapCards}
                    disabled={
                      playerSelected.length !== 4 ||
                      gameState === GAME_STATES.SWAPPING
                    }
                    className={`${BUTTON_BASE} ${
                      playerSelected.length === 4 &&
                      gameState !== GAME_STATES.SWAPPING
                        ? BUTTON_ACTIVE
                        : BUTTON_DISABLED
                    }`}
                  >
                    {gameState === GAME_STATES.SWAPPING
                      ? 'Swapping...'
                      : playerSelected.length === 4
                        ? 'Swap Cards'
                        : `Select 4 cards (${playerSelected.length}/4)`}
                  </button>
                </>
              )}

              {gameState === GAME_STATES.FINAL && (
                <button
                  onClick={dealCards}
                  className={`${BUTTON_BASE} ${BUTTON_ACTIVE}`}
                >
                  New Game
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* Moving Cards */}
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
          from {
            left: var(--start-x);
            top: var(--start-y);
          }
          to {
            left: var(--end-x);
            top: var(--end-y);
          }
        }
      `}</style>
    </div>
  );
};

export default CaliforniaPoker;
