import { useState, useRef, useEffect } from 'react';
// Types
import {
  BestHandType,
  CaliforniapokerProps,
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
import { SuitName } from '../../types/californiaPoker/CardValueSuit';
import { Button } from '@mui/material';

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

  const [playerCards, setPlayerCards] = useState<CardValueSuit[]>([]);
  const [opponentCards, setOpponentCards] = useState<CardValueSuit[]>([]);

  // whenever playerHand or aiHand changes → convert into CardValueSuit[]
  useEffect(() => {
    const mappedPlayer = playerHand.map(([rank, suit], index) => ({
      rank,
      suit: suitMap[suit],
      originalIndex: index,
    }));

    const mappedOpponent = opponentHand.map(([rank, suit], index) => ({
      rank,
      suit: suitMap[suit],
      originalIndex: index,
    }));

    setPlayerCards(mappedPlayer);
    setOpponentCards(mappedOpponent);
  }, [playerHand, opponentHand]);

  // const [opponentCards, setAiHand] = useState<CardValueSuit[]>([]);
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
    setGameState(GAME_STATES.SELECTING);
    setPlayerSelected([]);
    setWinner(null);
  };

  const toggleCardSelection = (cardIndex: number) => {
    if (gameState !== GAME_STATES.SELECTING) return;

    if (playerSelected.includes(cardIndex)) {
      const newSelection = playerSelected.filter((i) => i !== cardIndex);
      setPlayerSelected(newSelection);

      // Update bitmask
      let selections = cardSelections;
      selections &= ~(1 << cardIndex); // clear bit
      setCardSelections(selections);
    } else if (playerSelected.length < 4) {
      const newSelection = [...playerSelected, cardIndex];
      setPlayerSelected(newSelection);

      // Update bitmask
      let selections = cardSelections;
      selections |= 1 << cardIndex; // set bit
      setCardSelections(selections);
    }
  };

  const aiSelectCards = () => {
    const allCombinations = getSwapCombinations();

    let bestScore = -1;
    let bestCombination = allCombinations[0];

    allCombinations.forEach((combination) => {
      const cardsToKeep = opponentCards.filter(
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
  const doHandleMakeMove = () => {
    const moveData = '80';
    handleMakeMove(moveData);
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
          card: playerCards[playerCardIndex],
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
          card: opponentCards[aiCardIndex],
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

  const makeMove = () => {
    const moveData = '80';
    handleMakeMove(moveData);
  };

  const swapCards = () => {
    if (playerSelected.length !== 4) return;
    const moveData = '80';
    handleMakeMove(moveData);
    const aiSelection = aiSelectCards();
    setGameState(GAME_STATES.SWAPPING);

    const playerSwapCards = playerSelected.map((i) => ({
      ...playerCards[i],
      originalIndex: i,
    }));
    const aiSwapCards = aiSelection.map((i: number) => ({
      ...opponentCards[i],
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
      const newPlayerHand = [...playerCards];
      const newOpponentHand = [...opponentCards];

      playerSelected.forEach((playerIndex, swapIndex) => {
        const aiIndex = aiSelection[swapIndex];
        const tempCard = newPlayerHand[playerIndex];
        newPlayerHand[playerIndex] = newOpponentHand[aiIndex];
        newOpponentHand[aiIndex] = tempCard;
      });

      setPlayerCards(newPlayerHand);
      setOpponentCards(newOpponentHand);
      setShowSwapAnimation(false);
      setMovingCards([]);
      setGameState(GAME_STATES.FINAL);

      // Determine best hands and winner
      const playerBest: BestHandType = getBestHand(newPlayerHand);
      const aiBest: BestHandType = getBestHand(newOpponentHand);

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
    <div className='bg-gray-100 p-2'>
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
                cards={opponentCards}
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

              <div className='text-center'>
                <h1 className='text-2xl font-bold text-gray-400'>
                  California Poker
                </h1>
              </div>

              <HandDisplay
                title='Your Hand'
                cards={playerCards}
                playerNumber={playerNumber}
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
                  {(() => {
                    let label = '';
                    let disabled = false;
                    let active = false;

                    if (moveNumber === 0) {
                      if (isPlayerTurn) {
                        label = 'Start Game';
                        disabled = false;
                        active = true;
                      } else {
                        label = 'Opponent Turn to Start';
                        disabled = true;
                      }
                    } else if (moveNumber === 1) {
                      if (isPlayerTurn) {
                        label =
                          playerSelected.length === 4
                            ? 'Swap Cards'
                            : `Select 4 cards (${playerSelected.length}/4)`;
                        disabled = playerSelected.length !== 4;
                        active = playerSelected.length === 4;
                      } else {
                        label = "Opponent's Move";
                        disabled = true;
                      }
                    } else if (moveNumber === 2) {
                      label = 'Waiting for Opponent to Swap...';
                      disabled = true;
                    }

                    return (
                      <button
                        onClick={doHandleMakeMove}
                        disabled={disabled}
                        className={`${BUTTON_BASE} ${
                          active && !disabled ? BUTTON_ACTIVE : BUTTON_DISABLED
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })()}
                </>
              )}
              {/* <Button
                variant='contained'
                color='secondary'
                onClick={doHandleMakeMove}
                disabled={!isPlayerTurn}
                style={{ marginRight: '8px' }}
                aria-label='make-move'
                aria-disabled={!isPlayerTurn}
              >
                Make Move
              </Button> */}
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
