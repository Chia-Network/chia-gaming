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
  GameColors,
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
import {
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  Typography,
} from '@mui/material';
import { Wallet } from '@mui/icons-material';
import { WalletIcon } from 'lucide-react';

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
  myWinOutcome,
  banner,
  balanceDisplay,
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

  const color: 'success' | 'warning' | 'win' | 'lose' | 'tie' = myWinOutcome
    ? myWinOutcome
    : isPlayerTurn
      ? 'success'
      : 'warning';
  const [, playerBalance, opponentBalance] =
    balanceDisplay.match(/(\d+)\s*vs\s*(\d+)/i) || [];
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

  const isDisabled =
    !isPlayerTurn ||
    (moveNumber === 0
      ? false
      : moveNumber === 1
        ? !(
            (gameState === GAME_STATES.SELECTING &&
              playerSelected.length === 4) ||
            gameState === GAME_STATES.SWAPPING
          )
        : true);

  const isActive = !isDisabled; // single source of truth

  const bgColor = isActive ? '#3b4a63' : '#cccccc';
  const textColor = isActive ? 'white' : '#999999';
  const shadow = isActive ? '0 6px 12px rgba(59,74,99,0.35)' : 'none';
  const cursor = isActive ? 'pointer' : 'not-allowed';
  const opacity = isActive ? 1 : 0.6;

  // ---------- TEXT ----------
  let buttonText = '';
  if (moveNumber === 0) {
    buttonText = isPlayerTurn ? 'Start Game' : 'Opponent Turn to Start';
  } else if (moveNumber === 1) {
    if (!isPlayerTurn) {
      buttonText = "Opponent's Move";
    } else {
      buttonText =
        playerSelected.length === 4
          ? 'Swap Cards'
          : `Select 4 cards (${playerSelected.length}/4)`;
    }
  } else {
    buttonText = 'Waiting for Opponent...';
  }

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
    <div className='flex flex-col w-full h-full overflow-hidden'>
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
          <div className='h-full flex flex-col overflow-y-auto'>
            <div className='flex-1'>
              <div className='text-center relative h-[45%] mb-4 border border-gray-200 bg-white shadow rounded-lg'>
                {/* small top-right badge like in your screenshot */}
                <div className='w-full relative'>
                  <div className='absolute left-1/2 top-5 transform -translate-x-1/2 lg:pb-0 pb-4'>
                    <h3 className='text-[16px] font-bold text-center text-gray-700'>
                      Opponent hand
                    </h3>
                  </div>
                  <div className='flex justify-end'>
                    <div
                      style={{
                        border: '1px solid #DDDDDD',
                        borderRadius: '0px 6px 0px 6px',
                        padding: '6px',
                        background: 'white',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                        display: 'flex',
                        alignItems: 'center',
                      }}
                    >
                      <WalletIcon size={'19.6px'} color='#444444' />
                      <Typography
                        component='span'
                        sx={{
                          ml: 0.5,
                          fontWeight: 700,
                          fontSize: '12px',
                          color: '#444444',
                        }}
                      >
                        {opponentBalance}
                      </Typography>
                    </div>
                  </div>
                </div>
                <div className='flex-1 h-full flex items-center justify-center p-2'>
                  <HandDisplay
                    title={''}
                    cards={opponentCards}
                    playerNumber={playerNumber == 1 ? 2 : 1}
                    area={'ai'}
                    winner={winner}
                    winnerType={'ai'}
                    bestHand={aiBestHand}
                    swappingCards={swappingCards.ai}
                    showSwapAnimation={showSwapAnimation}
                    gameState={gameState}
                    formatHandDescription={formatHandDescription}
                    selectedCards={[]}
                  />
                </div>
              </div>

              <div className='text-center relative h-[45%] bg-white border border-gray-200 shadow rounded-lg'>
                <div className='w-full relative'>
                  <div className='absolute left-1/2 top-5 transform -translate-x-1/2 lg:pb-0 pb-4'>
                    <h3 className='text-[16px] font-bold text-center text-gray-700'>
                      Your hand
                    </h3>
                  </div>
                  <div className='flex justify-end'>
                    <div
                      style={{
                        border: '1px solid #DDDDDD',
                        borderRadius: '0px 6px 0px 6px',
                        padding: '6px',
                        background: 'white',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                        display: 'flex',
                        alignItems: 'center',
                      }}
                    >
                      <WalletIcon size={'19.6px'} color='#444444' />
                      <Typography
                        component='span'
                        sx={{
                          ml: 0.5,
                          fontWeight: 700,
                          fontSize: '12px',
                          color: '#444444',
                        }}
                      >
                        {playerBalance}
                      </Typography>
                    </div>
                  </div>
                </div>

                <div className='flex-1 h-full flex items-center justify-center p-2'>
                  <HandDisplay
                    title={''}
                    cards={playerCards}
                    playerNumber={playerNumber}
                    area={'player'}
                    winner={winner}
                    winnerType={'player'}
                    bestHand={playerBestHand}
                    onCardClick={toggleCardSelection}
                    selectedCards={playerSelected}
                    swappingCards={swappingCards.player}
                    showSwapAnimation={showSwapAnimation}
                    gameState={gameState}
                    formatHandDescription={formatHandDescription}
                  />
                </div>
              </div>
            </div>

            <div className='h-[10%] flex p-0 lg:pt-0 pt-4'>
              <Card
                elevation={3}
                sx={{
                  display: 'flex',
                  flex: 1,
                  borderRadius: '12px',
                  overflow: 'hidden',
                  alignItems: 'stretch',
                  border: '1px solid #DDDDDD',
                  boxShadow: '0 4px 10px rgba(0,0,0,0.06)',
                }}
              >
                {/* Left banner */}
                <Box
                  sx={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'white',
                  }}
                >
                  <Typography
                    sx={{
                      color: isPlayerTurn ? '#0f9d58' : '#DF0025',
                      fontWeight: 700,
                      fontSize: '18px',
                    }}
                  >
                    {isPlayerTurn ? 'Your Turn' : "Opponent's turn"}
                  </Typography>
                </Box>

                {/* Middle full-height button with 2px padding */}
                <Box
                  sx={{
                    flex: 1,
                    p: '2px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'transparent',
                  }}
                >
                  {gameState === GAME_STATES.FINAL ? (
                    <button
                      onClick={NewGame}
                      disabled={!isPlayerTurn}
                      className={`w-full h-full rounded-md text-white font-semibold uppercase ${isPlayerTurn ? BUTTON_ACTIVE : BUTTON_DISABLED}`}
                      style={{
                        background: isPlayerTurn ? '#E5FE75' : '#cccccc',
                        color: isPlayerTurn ? '#000' : '#999999',
                        border: '1px solid rgba(0,0,0,0.15)',
                        padding: '0.6rem 1.2rem',
                        boxShadow: isPlayerTurn
                          ? '0 6px 12px rgba(15,157,88,0.35)'
                          : 'none',
                        cursor: isPlayerTurn ? 'pointer' : 'not-allowed',
                        opacity: isPlayerTurn ? 1 : 0.6,
                      }}
                    >
                      {isPlayerTurn ? 'Start New Game' : 'Opponent to Start...'}
                    </button>
                  ) : (
                    <button
                      onClick={doHandleMakeMove}
                      disabled={isDisabled}
                      className='w-full h-full rounded-md font-semibold uppercase'
                      style={{
                        background: bgColor,
                        color: textColor,
                        border: '1px solid rgba(0,0,0,0.15)',
                        padding: '0.6rem 1.2rem',
                        boxShadow: shadow,
                        cursor: cursor,
                        opacity: opacity,
                        transition: 'all 0.2s ease',
                      }}
                    >
                      {buttonText}
                    </button>
                  )}
                </Box>

                {/* Right move display */}
                <Box
                  sx={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'white',
                  }}
                >
                  <Typography sx={{ fontWeight: 700, fontSize: '20px' }}>
                    Move {moveNumber}
                  </Typography>
                </Box>
              </Card>
            </div>
          </div>
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
