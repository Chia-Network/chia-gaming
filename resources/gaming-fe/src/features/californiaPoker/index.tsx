import { useState, useEffect } from 'react';
// Types
import {
  BestHandType,
  CaliforniapokerProps,
  CardValueSuit,
  MovingCardData,
  SwappingCards,
} from '../../types/californiaPoker';
import { Button, } from '../../components/button';
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
import { CalpokerOutcome } from '../../types/ChiaGaming';
import { SuitName } from '../../types/californiaPoker/CardValueSuit';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { WalletIcon } from 'lucide-react';
import { makeDescription } from './utils/MakeDescription';


function translateTopline(topline: string | undefined): string | null {
  if (!topline) return null;
  const res = { 'win': 'player', 'lose': 'ai' }[topline];
  return res ? res : 'tie';
}
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
  outcome,
  log,
  myWinOutcome,
  banner,
  balanceDisplay,
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
  const [rememberedOutcome, setRememberedOutcome] = useState<CalpokerOutcome | undefined>(undefined);
  const [rememberedCards, setRememberedCards] = useState<CardValueSuit[][]>([playerCards, opponentCards]);
  const [rememberedCardSelections, setRememberedCardSelections] = useState(0);
  const [playerDisplayText, setPlayerDisplayText] = useState<string>('');
  const [opponentDisplayText, setOpponentDisplayText] = useState<string>('');
  const cvsFromCard: (card: number[], index: number) => CardValueSuit = ([rank, suit], index) => ({
    rank,
    suit: suitMap[suit],
    originalIndex: index,
  });

  // whenever playerHand or aiHand changes → convert into CardValueSuit[]
  useEffect(() => {
    const mappedPlayer = playerHand.map(cvsFromCard);
    const mappedOpponent = opponentHand.map(cvsFromCard);

    setPlayerCards(mappedPlayer);
    setOpponentCards(mappedOpponent);
    if (mappedPlayer.length && mappedOpponent.length) {
      const newRemCards = [
        mappedPlayer,
        mappedOpponent
      ];
      console.log('setRememberedCards', newRemCards);
      setRememberedCards(newRemCards);
    }
    if (outcome) {
      setRememberedOutcome(outcome);
    }
  }, [playerHand, opponentHand, outcome]);

  useEffect(() => {
    const haveOutcome = outcome ? outcome : rememberedOutcome;
    if (outcome && moveNumber === 0 && gameState === GAME_STATES.AWAITING_SWAP) {
      console.log('outcome is', JSON.stringify(outcome));
      swapCards(outcome);
    }
  }, [outcome, gameState, moveNumber, rememberedOutcome]);

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
    console.log('starting again');
    doHandleMakeMove();
    setGameState(GAME_STATES.SELECTING);
    setRememberedCards([[], []]);
    setWinner(null);
    setRememberedOutcome(undefined);
    setMovingCards([]);
    setCardSelections(0);
    setPlayerSelected([]);
    setPlayerBestHand(undefined);
    setAiBestHand(undefined);
    setShowSwapAnimation(false);
    setSwappingCards({ player: [], ai: [] });
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
      setRememberedCardSelections(selections);
    } else if (playerSelected.length < 4) {
      const newSelection = [...playerSelected, cardIndex];
      setPlayerSelected(newSelection);

      // Update bitmask
      let selections = cardSelections;
      selections |= 1 << cardIndex; // set bit
      setCardSelections(selections);
      setRememberedCardSelections(selections);
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

    if (gameState === GAME_STATES.SELECTING && playerSelected.length > 0) {
      setGameState(GAME_STATES.AWAITING_SWAP);
    }

    handleMakeMove(moveData);
  };

  //
  // playerSwapIndices are the sources of the swapped cards from the player and targets of the opponent.
  // aiSwapIndices are the sources of the swapped cards from the opponent and targets of the player.
  // playerCards and opponentCards are the local card data.
  //
  const calculateMovingCards = (
    playerSwapIndices: number[],
    aiSwapIndices: number[],
    playerCards: CardValueSuit[],
    opponentCards: CardValueSuit[],
  ): MovingCardData[] => {
    const movingCardData: MovingCardData[] = [];
    let usedPlayerCards: number = 0;
    let usedAiCards: number = 0;

    // Prefixes for DOM selectors (myPrefix = viewer's hand in DOM)
    const myPrefix = 'player';
    const oppPrefix = 'ai';

    // Player -> Opponent animations
    playerSwapIndices.forEach((swapIndex, i) => {
      // Choose a target ai index — prefer aligned index if exists, otherwise reuse swapIndex
      const aiIndex = aiSwapIndices[i];
      usedPlayerCards |= (1 << swapIndex);

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
          direction: 'playerToAi'
        });
      }
    });

    // Opponent -> Player animations
    aiSwapIndices.forEach((swapIndex, i) => {
      const playerIndex = playerSwapIndices[i];
      usedAiCards |= (1 << swapIndex);

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
          direction: 'aiToPlayer'
        });
      }
    });

    const selfCardAnimate = (myPrefix: string, usedMask: number, card: CardValueSuit, i: number) => {
      if (usedMask & (1 << i)) {
        return;
      }
      // source = dest
      const source = document.querySelector(
        `[data-card-id="${myPrefix}-${i}"]`,
      );
      if (source) {
        const myRect = (source as Element).getBoundingClientRect();
        movingCardData.push({
          id: `${myPrefix}-to-${myPrefix}-${i}`,
          card,
          startX: myRect.left,
          startY: myRect.top,
          endX: myRect.left,
          endY: myRect.top,
          width: myRect.width,
          height: myRect.height,
          direction: 'payerToAi'
        });
      }
    };

    playerCards.forEach((card, i) => selfCardAnimate(myPrefix, usedPlayerCards, card, i));
    opponentCards.forEach((card, i) => selfCardAnimate(oppPrefix, usedAiCards, card, i));

    return movingCardData;
  };



  const swapCards = (rememberedOutcome: CalpokerOutcome) => {
    const liveWinner = translateTopline(rememberedOutcome.my_win_outcome);
    console.log('swapping, outcome', liveWinner, rememberedOutcome);
    setWinner(liveWinner);
    setGameState(GAME_STATES.SWAPPING);

    const playerSelected = isPlayerAlice ? rememberedOutcome.alice_discards : rememberedOutcome.bob_discards;
    const aiSelected = isPlayerAlice ? rememberedOutcome.bob_discards : rememberedOutcome.alice_discards;

    // Find the targets to which we'll swap cards, namely the opponent discards.
    const playerSwapIndices: number[] = [];
    const aiSwapIndices: number[] = [];
    for (let i = 0; i < 8; i++) {
      if (aiSelected & (1 << i)) {
        playerSwapIndices.push(i);
      }
      if (playerSelected & (1 << i)) {
        aiSwapIndices.push(i);
      }
    }

    setSwappingCards({ player: rememberedCards[0], ai: rememberedCards[1] });
    console.log('calculate moving cards', playerSwapIndices, aiSwapIndices);
    const movingCardData = calculateMovingCards(
      playerSwapIndices,
      aiSwapIndices,
      rememberedCards[0],
      rememberedCards[1]
    );
    setMovingCards(movingCardData);
    console.log('moving cards', movingCardData);
    setShowSwapAnimation(true);

    setTimeout(() => {
      // Copy current hands
      const newPlayer = [...playerCards];
      const newOpponent = [...opponentCards];

      // Apply exact card swaps based on animation index mapping
      for (let i = 0; i < playerSwapIndices.length; i++) {
        const pIndex = playerSwapIndices[i];
        const aiIndex = aiSwapIndices[i];

        // Player gives card to AI
        newOpponent[aiIndex] = playerCards[pIndex];

        // AI gives card to Player
        newPlayer[pIndex] = opponentCards[aiIndex];
      }

      // Update UI
      setPlayerCards(newPlayer);
      setOpponentCards(newOpponent);
      setPlayerSelected([]);

      // --- Best hands ---
      const lastLog = log[0];

      // Convert hand arrays into CardValueSuit objects
      const playerBestCards: CardValueSuit[] = lastLog.myHand.map(
        ([rank, suit], idx) => ({
          rank,
          suit: suitMap[suit],
          originalIndex: idx,
        })
      );

      const opponentBestCards: CardValueSuit[] = lastLog.opponentHand.map(
        ([rank, suit], idx) => ({
          rank,
          suit: suitMap[suit],
          originalIndex: idx,
        })
      );

      setPlayerBestHand({ cards: playerBestCards, rank: { name: '', score: 0, tiebreakers: [] } });
      setAiBestHand({ cards: opponentBestCards, rank: { name: '', score: 0, tiebreakers: [] } });


      console.log('done swapping', log.length - 1, log, newPlayer, newOpponent, playerBestCards, opponentBestCards);

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
              <CardHeader className='relative p-0 w-full flex justify-center items-center'>
                <CardTitle className="w-full pl-4 flex items-center gap-2">

                  {/* Opponent Title */}
                  <span className="font-semibold text-alert-text">
                    Opponent Hand
                  </span>

                  {/* Dull Hand Description */}
                  {opponentDisplayText && (
                    <span className="text-canvas-text">
                      ({opponentDisplayText})
                    </span>
                  )}

                  {/* Winner / Lost Badge */}
                  {winner && !showSwapAnimation && (
                    <span
                      className={`px-2 py-0.5 rounded-md text-xs font-medium ${
                        winner === "ai"
                          ? "bg-success-solid text-success-on-success"
                          : "bg-alert-solid text-alert-on-alert"
                      }`}
                    >
                      {winner === "ai" ? "Winner" : "Loser"}
                    </span>
                  )}

                </CardTitle>


                <div className='w-full flex justify-end'>
                  <div className=' flex items-center border border-canvas-line rounded-tr-md rounded-bl-md px-2 py-1 shadow-sm bg-canvas-bg'>
                    <WalletIcon size='19.6px' />
                    <span className='ml-2 font-bold text-sm text-canvas-text-contrast'>{playerBalance}</span>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className='flex-1 h-full mt-4 flex items-center justify-center p-2'>
                  <HandDisplay
                    title=''
                    cards={opponentCards.length ? opponentCards : rememberedCards[1]}
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
              <CardHeader className='relative p-0 w-full flex justify-center items-center'>
                <CardTitle className="w-full pl-4 flex items-center gap-2">

                  {/* Player Title */}
                  <span className="font-semibold text-success-text">
                    Your Hand
                  </span>

                  {/* Dull Hand Description */}
                  {playerDisplayText && (
                    <span className="text-canvas-text">
                      ({playerDisplayText})
                    </span>
                  )}

                  {/* Winner / Lost Badge */}
                  {winner && !showSwapAnimation && (
                    <span
                    className={`px-2 py-0.5 rounded-md text-xs font-medium ${
                      winner === "player"
                        ? "bg-success-solid text-success-on-success"
                        : "bg-alert-solid text-alert-on-alert"
                    }`}
                    >
                      {winner === "player" ? "Winner" : "Loser"}
                    </span>
                  )}

                </CardTitle>


                <div className='w-full flex justify-end'>
                  <div className=' flex items-center border border-canvas-line rounded-tr-md rounded-bl-md px-2 py-1 shadow-sm bg-canvas-bg'>
                    <WalletIcon size='19.6px' />
                    <span className='ml-2 font-bold text-sm text-canvas-text-contrast'>{playerBalance}</span>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className='flex-1 mt-4 h-full flex items-center justify-center p-2'>
                  <HandDisplay
                    title=''
                    cards={playerCards.length ? playerCards : rememberedCards[0]}
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
              </CardContent>
            </Card>


            {/* ACTION BAR */}
            <div className='h-[10%] flex pt-4 lg:pt-0'>
              <div className='flex flex-1 rounded-xl overflow-hidden border border-canvas-line shadow-md bg-canvas-bg'>
                {/* Left banner */}
                <div className='flex flex-1 items-center justify-center'>
                  <span
                    className={`font-bold text-xl ${isPlayerTurn ? 'text-success-text' : 'text-alert-text'
                      }`}
                  >
                    {isPlayerTurn ? 'Your Turn' : "Opponent's turn"}
                  </span>
                </div>

                {/* Button */}
                <div className='flex flex-1 p-0.5 items-center justify-center bg-transparent'>
                  {gameState === GAME_STATES.FINAL ? (
                    <Button
                      variant={'solid'}
                      color={'primary'}
                      onClick={NewGame}
                      disabled={!isPlayerTurn}
                      fullWidth
                      className='h-full'
                    >
                      {isPlayerTurn ? 'Start New Game' : 'Opponent to Start...'}
                    </Button>
                  ) : (
                    <Button
                      variant={'solid'}
                      color={'primary'}
                      onClick={doHandleMakeMove}
                      disabled={isDisabled}
                      fullWidth
                      className='h-full'
                    >
                      {buttonText}
                    </Button>
                  )}
                </div>

                {/* Move number */}
                <div className='flex flex-1 items-center justify-center'>
                  <span className='font-bold text-xl text-canvas-solid'>
                    Move {moveNumber}
                  </span>
                </div>
              </div>
            </div>
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
