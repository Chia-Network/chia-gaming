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
  lastOutcome,
  log,
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

  useEffect(() => {
    swapCards();
  }, [lastOutcome]);
  // whenever playerHand or aiHand changes → convert into CardValueSuit[]
  useEffect(() => {
    if (playerHand.length === 0 || opponentHand.length === 0) {
      return;
    }
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
  const NewGame = () => {
    setGameState(GAME_STATES.SELECTING);
    setPlayerSelected([]);
    setWinner(null);
    setPlayerBestHand(undefined);
    setAiBestHand(undefined);
    setSwappingCards({ player: [], ai: [] });
    setShowSwapAnimation(false);
    setMovingCards([]);
    doHandleMakeMove();
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

  console.log(lastOutcome, 'lastOutcome in doHandleMakeMove');
  console.log(playerHand, 'playerHand in doHandleMakeMove');
  console.log(opponentHand, 'opponentHand in doHandleMakeMove');
  console.log(log, 'gameEnd Log');

  const doHandleMakeMove = () => {
    const moveData = '80';

    handleMakeMove(moveData);
  };
  const calculateMovingCards = (
    playerSwapIndices: number[],
    aiSwapIndices: number[],
    playerNumber: number,
    playerCards: CardValueSuit[],
    opponentCards: CardValueSuit[],
  ): MovingCardData[] => {
    const movingCardData: MovingCardData[] = [];
    const isPlayerAlice = playerNumber === 1;

    // Prefixes for DOM selectors (myPrefix = viewer's hand in DOM)
    const myPrefix = isPlayerAlice ? 'player' : 'ai';
    const oppPrefix = isPlayerAlice ? 'ai' : 'player';

    // If one side swapped more cards, handle each side independently
    // Player -> Opponent animations
    playerSwapIndices.forEach((swapIndex, i) => {
      // Choose a target ai index — prefer aligned index if exists, otherwise reuse swapIndex
      const aiIndex = aiSwapIndices[i] ?? swapIndex;

      const mySource = document.querySelector(
        `[data-card-id="${myPrefix}-${swapIndex}"]`,
      );
      const oppTarget = document.querySelector(
        `[data-card-id="${oppPrefix}-${aiIndex}"]`,
      );

      if (mySource && oppTarget) {
        const myRect = (mySource as Element).getBoundingClientRect();
        const oppRect = (oppTarget as Element).getBoundingClientRect();

        movingCardData.push({
          id: `${myPrefix}-to-${oppPrefix}-${swapIndex}`,
          card: playerCards[swapIndex],
          startX: myRect.left,
          startY: myRect.top,
          endX: oppRect.left,
          endY: oppRect.top,
          width: myRect.width,
          height: myRect.height,
          direction: isPlayerAlice ? 'playerToAi' : 'aiToPlayer',
        });
      }
    });

    // Opponent -> Player animations
    aiSwapIndices.forEach((swapIndex, i) => {
      const playerIndex = playerSwapIndices[i] ?? swapIndex;

      const oppSource = document.querySelector(
        `[data-card-id="${oppPrefix}-${swapIndex}"]`,
      );
      const myTarget = document.querySelector(
        `[data-card-id="${myPrefix}-${playerIndex}"]`,
      );

      if (oppSource && myTarget) {
        const oppRect = (oppSource as Element).getBoundingClientRect();
        const myRect = (myTarget as Element).getBoundingClientRect();

        movingCardData.push({
          id: `${oppPrefix}-to-${myPrefix}-${swapIndex}`,
          card: opponentCards[swapIndex],
          startX: oppRect.left,
          startY: oppRect.top,
          endX: myRect.left,
          endY: myRect.top,
          width: oppRect.width,
          height: oppRect.height,
          direction: isPlayerAlice ? 'aiToPlayer' : 'playerToAi',
        });
      }
    });

    return movingCardData;
  };

  const swapCards = () => {
    if (!lastOutcome) return;

    const gameRoundData = lastOutcome;
    setGameState(GAME_STATES.SWAPPING);

    // Determine who is the player in JSON
    const isPlayerAlice = playerNumber === 1;

    // Map the correct hands depending on perspective
    const playerOriginal = isPlayerAlice
      ? gameRoundData.alice_cards
      : gameRoundData.bob_cards;
    const playerFinal = isPlayerAlice
      ? gameRoundData.alice_final_hand
      : gameRoundData.bob_final_hand;
    const opponentOriginal = isPlayerAlice
      ? gameRoundData.bob_cards
      : gameRoundData.alice_cards;
    const opponentFinal = isPlayerAlice
      ? gameRoundData.bob_final_hand
      : gameRoundData.alice_final_hand;

    // Compute swap indices
    const getSwappedIndices = (original: number[][], final: number[][]) => {
      const indices: number[] = [];
      original.forEach(([rank, suit], index) => {
        const found = final.find(([r, s]) => r === rank && s === suit);
        if (!found) indices.push(index);
      });
      return indices;
    };

    const playerSwapIndices = getSwappedIndices(playerOriginal, playerFinal);
    const aiSwapIndices = getSwappedIndices(opponentOriginal, opponentFinal);

    const playerSwapCards = playerSwapIndices.map((i) => ({
      ...playerCards[i],
      originalIndex: i,
    }));
    const opponentSwapCards = aiSwapIndices.map((i) => ({
      ...opponentCards[i],
      originalIndex: i,
    }));

    setSwappingCards({ player: playerSwapCards, ai: opponentSwapCards });
    setPlayerSelected([]);

    // Delay animation for remote players to allow DOM layout to stabilize
    setTimeout(
      () => {
        requestAnimationFrame(() => {
          const playerOriginalCards = playerOriginal.map(([rank, suit]) => ({
            rank,
            suit: suitMap[suit],
          }));
          const opponentOriginalCards = opponentOriginal.map(
            ([rank, suit]) => ({
              rank,
              suit: suitMap[suit],
            }),
          );

          const movingCardData = calculateMovingCards(
            playerSwapIndices,
            aiSwapIndices,
            playerNumber,
            playerOriginalCards,
            opponentOriginalCards,
          );

          setMovingCards(movingCardData);
          requestAnimationFrame(() => setShowSwapAnimation(true));
        });
      },
      isPlayerTurn ? ANIMATION_DELAY : ANIMATION_DELAY + 500,
    );

    setTimeout(() => {
      // Apply final hands from correct perspective
      const newPlayerHand = playerFinal.map(([rank, suit]) => ({
        rank,
        suit: suitMap[suit],
      }));
      const newOpponentHand = opponentFinal.map(([rank, suit]) => ({
        rank,
        suit: suitMap[suit],
      }));

      setPlayerCards(newPlayerHand);
      setOpponentCards(newOpponentHand);
      setShowSwapAnimation(false);
      setMovingCards([]);
      setGameState(GAME_STATES.FINAL);

      const playerBest = getBestHand(newPlayerHand);
      const aiBest = getBestHand(newOpponentHand);

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
                  onClick={NewGame}
                  className={`${BUTTON_BASE} ${isPlayerTurn ? BUTTON_ACTIVE : 'opacity-60 cursor-not-allowed'}`}
                  disabled={!isPlayerTurn}
                >
                  {isPlayerTurn
                    ? 'Start New Game'
                    : 'Waiting for Opponent to Start...'}
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
