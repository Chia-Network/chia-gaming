import { useState, useEffect } from 'react';
// Types
import {
  BestHandType,
  CaliforniapokerProps,
  CardValueSuit,
  MovingCardData,
  SwappingCards,
} from '../../types/californiaPoker';
import { Button } from '../../components/button';
// Constants
import {
  ANIMATION_DELAY,
  GAME_STATES,
  SWAP_ANIMATION_DURATION,
} from './constants/constants';

// Utils
import {
  calculateMovingCards,
  compareRanks,
  evaluateHand,
  formatHandDescription,
  getCombinations,
} from './utils';
import { HandDisplay, MovingCard } from './components';
import { SuitName } from '../../types/californiaPoker/CardValueSuit';

import { WalletIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/src/components/ui/card';
import GameBottomBar from './components/GameBottomBar';


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

  const [, playerBalance, opponentBalance] =
    balanceDisplay.match(/(\d+)\s*vs\s*(\d+)/i) || [];
  const [playerCards, setPlayerCards] = useState<CardValueSuit[]>([]);
  const [opponentCards, setOpponentCards] = useState<CardValueSuit[]>([]);
  // const [opponentCards, setAiHand] = useState<CardValueSuit[]>([]);
  const [playerSelected, setPlayerSelected] = useState<number[]>([]);
  const [winner, setWinner] = useState<string | null>(null);
  const [playerBestHand, setPlayerBestHand] = useState<BestHandType | undefined>();
  const [opponentBestHand, setOpponentBestHand] = useState<BestHandType | undefined>();
  const [swappingCards, setSwappingCards] = useState<SwappingCards>({
    player: [],
    ai: [],
  });
  const [showSwapAnimation, setShowSwapAnimation] = useState(false);
  const [movingCards, setMovingCards] = useState<MovingCardData[]>([]);

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
    setOpponentBestHand(undefined);
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

  const swapCards = () => {
    if (!lastOutcome) return;

    const gameRoundData = lastOutcome;
    setGameState(GAME_STATES.SWAPPING);

    // Determine who is the player in JSON
    const isPlayerAlice = playerNumber === 1;

    // Map the correct hands depending on perspective
    const playerOriginal = !isPlayerAlice
      ? gameRoundData.alice_cards
      : gameRoundData.bob_cards;
    const playerFinal = !isPlayerAlice
      ? gameRoundData.alice_final_hand
      : gameRoundData.bob_final_hand;
    const opponentOriginal = !isPlayerAlice
      ? gameRoundData.bob_cards
      : gameRoundData.alice_cards;
    const opponentFinal = !isPlayerAlice
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
      const opponentBest = getBestHand(newOpponentHand);

      setPlayerBestHand(playerBest);
      setOpponentBestHand(opponentBest);

      const comparison = compareRanks(playerBest.rank, opponentBest.rank);
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
    <div className='flex flex-col w-full h-full min-h-0 text-canvas-text'>
      <div className='flex-1 h-full min-h-0 overflow-hidden'>
        {gameState === GAME_STATES.INITIAL && (
          <div className='text-center'>
            <Button onClick={dealCards} className='px-6 py-2'>
              Deal Cards
            </Button>
          </div>
        )}

        {gameState !== GAME_STATES.INITIAL && (
          <div className='flex flex-col gap-4 h-full flex-1 min-h-0'>
            {/* OPPONENT PANEL */}
            <Card className='flex flex-col py-0 min-h-[260px] w-full flex-1 lg:flex-[0_0_43%] border border-canvas-line shadow-md overflow-hidden'>
              {/* Make Card relative so absolute div is positioned relative to it */}
              <CardHeader className='relative p-0 w-full flex justify-center items-center'>
                <CardTitle className='w-full pl-4'>Opponent Hand</CardTitle>
                <div className='w-full flex justify-end'>
                  <div className=' flex items-center border border-canvas-line rounded-tr-md rounded-bl-md px-2 py-1 shadow-sm bg-canvas-bg'>
                    <WalletIcon size='19.6px' />
                    <span className='ml-2 font-bold text-sm text-canvas-text-contrast'>{playerBalance}</span>
                  </div>
                </div>

              </CardHeader>

              <CardContent className='flex flex-1 items-center justify-center p-2 min-h-0'>
                <HandDisplay
                  title=''
                  cards={opponentCards}
                  playerNumber={playerNumber == 1 ? 2 : 1}
                  area='ai'
                  winner={winner}
                  winnerType='ai'
                  bestHand={opponentBestHand}
                  swappingCards={swappingCards.ai}
                  showSwapAnimation={showSwapAnimation}
                  gameState={gameState}
                  formatHandDescription={formatHandDescription}
                  selectedCards={[]}
                />
              </CardContent>
            </Card>


            {/* PLAYER PANEL */}
            <Card className='flex flex-col py-0 w-full flex-1 lg:flex-[0_0_43%] border border-canvas-line shadow-md overflow-hidden'>
              <CardHeader className='relative p-0 w-full flex justify-center items-center'>
                <CardTitle className='w-full pl-4'>Your Hand</CardTitle>
                <div className='w-full flex justify-end'>
                  <div className=' flex items-center border border-canvas-line rounded-tr-md rounded-bl-md px-2 py-1 shadow-sm bg-canvas-bg'>
                    <WalletIcon size='19.6px' />
                    <span className='ml-2 font-bold text-sm text-canvas-text-contrast'>{playerBalance}</span>
                  </div>
                </div>

                {/* Player balance on top-left corner */}
              </CardHeader>
              <CardContent className='flex flex-1 items-center justify-center p-2 min-h-0'>
                <HandDisplay
                  title=''
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
