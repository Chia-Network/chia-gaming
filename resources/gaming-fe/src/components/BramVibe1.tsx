import { useState, useRef, useEffect } from 'react';

// Constants
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

// OKHSL colors: hue in degrees, saturation 100%, lightness as specified
const SUIT_COLORS = {
  '♠': 'oklch(0% 0 0)',      // Black (0% lightness, 0 chroma for true black)
  '♥': 'oklch(50% 0.3 25)',  // Red (25° hue, 50% lightness)
  '♦': 'oklch(50% 0.3 265)', // Blue (265° hue, 50% lightness)
  '♣': 'oklch(50% 0.3 155)'  // Green (155° hue, 50% lightness)
};

const HAND_RANKINGS = {
  STRAIGHT_FLUSH: { score: 8, name: 'Straight Flush' },
  FOUR_OF_A_KIND: { score: 7, name: 'Four of a Kind' },
  FULL_HOUSE: { score: 6, name: 'Full House' },
  FLUSH: { score: 5, name: 'Flush' },
  STRAIGHT: { score: 4, name: 'Straight' },
  THREE_OF_A_KIND: { score: 3, name: 'Three of a Kind' },
  TWO_PAIR: { score: 2, name: 'Two Pair' },
  ONE_PAIR: { score: 1, name: 'One Pair' },
  HIGH_CARD: { score: 0, name: 'High Card' }
};

const GAME_STATES = {
  INITIAL: 'initial',
  SELECTING: 'selecting',
  SWAPPING: 'swapping',
  FINAL: 'final'
};

const ANIMATION_DELAY = 100;
const SWAP_ANIMATION_DURATION = 2500;

// Button styling classes
const BUTTON_BASE = "px-6 py-2 font-bold rounded-lg w-64";
const BUTTON_ACTIVE = "bg-blue-600 text-white hover:bg-blue-700 cursor-pointer";
const BUTTON_DISABLED = "bg-gray-300 text-gray-500 cursor-default";

// Utility functions
const getRankValue = (rank: any) => {
  const rankValues: Record<string, number> = { 'A': 14, 'K': 13, 'Q': 12, 'J': 11, 'T': 10 };
  return rankValues[rank] || parseInt(rank);
};

function valueToDisplayName(value: number): string {
  const displayNames: Record<number, string> = { 14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack', 10: 'Ten' };
  return displayNames[value] || value.toString();
};

function shuffleArray<T>(array: T[]): T[] {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
};

type SuitName = '♠' | '♥' | '♦' | '♣';
interface CardValueSuit {
  rank: number;
  suit: SuitName;
  originalIndex?: number;
}

function sortHand(hand: CardValueSuit[]): CardValueSuit[] {
  return [...hand].sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    const suitOrder = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 };
    return suitOrder[a.suit] - suitOrder[b.suit];
  });
};

function createDeck(): CardValueSuit[] {
  const deck: Array<any> = [];
  SUITS.forEach(suit => {
    RANKS.forEach(rank => {
      deck.push({ suit, rank });
    });
  });
  return deck;
};

// Generate all possible 5-card combinations from 8 cards
function getCombinations<T>(cards: T[], size: number = 5): T[][] {
  const combinations: T[][] = [];

  // Use the same nested loop approach as the original to ensure no bias
  if (size === 5) {
    for (let i = 0; i < cards.length - 4; i++) {
      for (let j = i + 1; j < cards.length - 3; j++) {
        for (let k = j + 1; k < cards.length - 2; k++) {
          for (let l = k + 1; l < cards.length - 1; l++) {
            for (let m = l + 1; m < cards.length; m++) {
              combinations.push([cards[i], cards[j], cards[k], cards[l], cards[m]]);
            }
          }
        }
      }
    }
  }

  return combinations;
};

// Generate all 4-card swap combinations
const getSwapCombinations = (handSize = 8) => {
  const combinations: Array<any> = [];

  for (let i = 0; i < handSize - 3; i++) {
    for (let j = i + 1; j < handSize - 2; j++) {
      for (let k = j + 1; k < handSize - 1; k++) {
        for (let l = k + 1; l < handSize; l++) {
          combinations.push([i, j, k, l]);
        }
      }
    }
  }

  return combinations;
};

// Utility function to calculate balanced rows
function calculateBalancedRows(totalCards: number, containerWidth: number, cardWidth: number = 64, gap: number = 8): number[] {
  const cardsPerRow = Math.floor((containerWidth + gap) / (cardWidth + gap));

  if (cardsPerRow >= totalCards) {
    return [totalCards]; // All cards fit in one row
  }

  const rows = Math.ceil(totalCards / cardsPerRow);
  const balancedRows: Array<any> = [];

  // Distribute cards as evenly as possible
  const baseCardsPerRow = Math.floor(totalCards / rows);
  const remainder = totalCards % rows;

  for (let i = 0; i < rows; i++) {
    const cardsInThisRow = baseCardsPerRow + (i < remainder ? 1 : 0);
    balancedRows.push(cardsInThisRow);
  }

  return balancedRows;
};

interface CardContentProps {
  card: CardValueSuit;
  textSize?: string;
}

function CardContent(content: CardContentProps) {
  const { card, textSize = "text-3xl" } = content;
  return (
    <>
      <div className={textSize}>{card.rank}</div>
      <div className={`${textSize} -mt-2`}>{card.suit}</div>
    </>
  );
}

interface CardRenderProps {
  card: CardValueSuit;
  onClick: () => void;
  isSelected: boolean;
  isBeingSwapped: boolean;
  cardId: string;
  isInBestHand: boolean | undefined;
};

// Components
function Card(props: CardRenderProps) {
  const { card, isSelected, onClick, isBeingSwapped = false, cardId, isInBestHand = false } = props;

  const getCardStyles = () => {
    if (isBeingSwapped) {
      return {
        border: 'border-solid border-gray-300',
        bg: 'bg-gray-50 opacity-50',
        cursor: ''
      };
    }

    if (isInBestHand) {
      return {
        border: 'border-yellow-500',
        bg: 'bg-yellow-100',
        cursor: 'cursor-pointer'
      };
    }

    if (isSelected) {
      return {
        border: 'border-blue-500',
        bg: 'bg-blue-100',
        cursor: 'cursor-pointer'
      };
    }

    return {
      border: 'border-gray-300 hover:border-gray-400',
      bg: 'bg-white',
      cursor: 'cursor-pointer'
    };
  };

  const styles = getCardStyles();
  const colorClass = SUIT_COLORS[card.suit] || '#000000';

  return (
    <div
      data-card-id={cardId}
      className={`min-w-[3rem] w-16 h-24 border-2 rounded-lg flex flex-col items-center justify-center font-bold
        ${styles.border} ${styles.bg} ${styles.cursor}
        ${isInBestHand ? 'shadow-lg' : ''}`}
      style={{ color: colorClass }}
      onClick={onClick}
    >
      {!isBeingSwapped && <CardContent card={card} />}
    </div>
  );
};

interface MovingCardData {
  id: string;
  card: CardValueSuit;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  width: number;
  height: number;
  direction: string;
};

interface MovingCardProps {
  cardData: MovingCardData;
  showAnimation: boolean;
};

function MovingCard(props: MovingCardProps) {
  const { cardData, showAnimation } = props;
  const { card, startX, startY, endX, endY, width, height } = cardData;
  const colorHex = SUIT_COLORS[card.suit] || '#000000';

  const x = {
    width: `${width}px`,
    height: `${height}px`,
    left: startX,
    top: startY,
    color: colorHex,
    '--start-x': `${startX}px`,
    '--start-y': `${startY}px`,
    '--end-x': `${endX}px`,
    '--end-y': `${endY}px`
  };
  return (
    <div
      className={`border-2 border-gray-300 rounded-lg bg-white shadow-lg flex flex-col items-center justify-center font-bold fixed pointer-events-none z-50 ${showAnimation ? 'animate-move' : ''}`}
      style = {x}
    >
      <CardContent card={card} />
    </div>
  );
};

interface FormatHandProps {
  name: string;
  score: number;
  tiebreakers: number[];
};

interface BestHandType {
  cards: CardValueSuit[];
  rank: FormatHandProps;
}

interface HandDisplayProps {
  title: string;
  cards: CardValueSuit[];
  area: string;
  winner: string | null;
  winnerType: string;
  bestHand: BestHandType | undefined;
  onCardClick?: (n: number) => void;
  selectedCards: number[];
  swappingCards: CardValueSuit[];
  showSwapAnimation: boolean;
  gameState: string;
  formatHandDescription: (f: FormatHandProps) => string;
};

function HandDisplay(props: HandDisplayProps) {
  const {
    title,
    cards,
    area,
    winner,
    winnerType,
    bestHand,
    onCardClick,
    selectedCards,
    swappingCards,
    showSwapAnimation,
    gameState,
    formatHandDescription
  } = props;
  const [containerWidth, setContainerWidth] = useState(600);
  const [winnerIndicatorOffset, setWinnerIndicatorOffset] = useState(0);
  const containerRef = useRef<any | null>(null);

  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.offsetWidth - 16); // Subtract padding
      }
    };

    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  useEffect(() => {
    const updateWinnerPosition = () => {
      if (containerRef.current) {
        const cardElements = containerRef.current.querySelectorAll(`[data-card-id^="${area}-"]`);
        if (cardElements.length > 0) {
          const containerRect = containerRef.current.getBoundingClientRect();
          const lastCardElement = cardElements[cardElements.length - 1];
          const lastCardRect = lastCardElement.getBoundingClientRect();

          // Calculate offset to align right edge of indicator with right edge of rightmost card
          const containerCenter = containerRect.left + containerRect.width / 2;
          const cardRightEdge = lastCardRect.right;

          // We need to position the indicator so its right edge aligns with the card's right edge
          // Since the indicator starts centered, we need to account for half its width
          // Estimate indicator width (will be refined by actual measurement if needed)
          const indicatorWidth = 80; // Approximate width of "Winner!" text + padding
          const offset = cardRightEdge - containerCenter - (indicatorWidth / 2);

          setWinnerIndicatorOffset(offset);
        }
      }
    };

    // Always update position when cards change, regardless of game state
    // This ensures the position is calculated before the indicator becomes visible
    const timer = setTimeout(updateWinnerPosition, 50);
    window.addEventListener('resize', updateWinnerPosition);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', updateWinnerPosition);
    };
  }, [cards, area]); // Removed winner, winnerType, gameState dependencies

  const isWinner = winner === winnerType;
  const isTie = winner === 'tie';
  const isPlayer = area === 'player';

  // Determine what text to show
  let displayText = title;
  if (gameState === GAME_STATES.FINAL && bestHand?.cards) {
    displayText = formatHandDescription(bestHand.rank);
  }

  // Calculate balanced rows
  const rowSizes = calculateBalancedRows(cards.length, containerWidth);
  const cardRows: any[] = [];
  let cardIndex = 0;

  rowSizes.forEach(rowSize => {
    cardRows.push(cards.slice(cardIndex, cardIndex + rowSize));
    cardIndex += rowSize;
  });

  return (
    <div ref={containerRef} className="p-2 rounded-lg max-w-full mx-auto" data-area={area}>
      {!isPlayer && (
        <h3 className="text-sm font-bold mb-1 text-center text-gray-700">{displayText}</h3>
      )}

      <div className="relative">
        {gameState === GAME_STATES.FINAL && (isWinner || isTie) && (
          <div
            className={`absolute -top-5 ${isWinner ? 'bg-green-500' : 'bg-gray-500'} text-white px-4 py-2 rounded-full font-bold text-base shadow-lg z-10`}
            style={{
              left: '50%',
              transform: `translateX(calc(-50% + ${winnerIndicatorOffset}px))`
            }}
          >
            {isWinner ? 'Winner!' : 'Tie!'}
          </div>
        )}

        <div className="flex flex-col gap-2 items-center">
          {cardRows.map((row, rowIndex) => (
            <div key={`row-${rowIndex}`} className="flex gap-2 justify-center">
              {row.map((card: any, cardInRowIndex: number) => {
                const originalIndex = cards.findIndex(c => c.suit === card.suit && c.rank === card.rank);
                const isBeingSwapped = showSwapAnimation && swappingCards.some(c => c.originalIndex === originalIndex);
                const isInBestHand = gameState === GAME_STATES.FINAL && bestHand?.cards &&
                  bestHand.cards.some(bestCard =>
                    bestCard.rank === card.rank && bestCard.suit === card.suit
                  );

                return (
                  <Card
                    key={`${area}-${originalIndex}`}
                    card={card}
                    cardId={`${area}-${originalIndex}`}
                    isSelected={selectedCards.includes(originalIndex)}
                    onClick={() => onCardClick && onCardClick(originalIndex)}
                    isBeingSwapped={isBeingSwapped}
                    isInBestHand={isInBestHand}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {isPlayer && (
        <h3 className="text-sm font-bold mt-1 text-center text-gray-700">{displayText}</h3>
      )}
    </div>
  );
};

// Main game logic
function evaluateHand(hand: CardValueSuit[]) {
  const sortedHand = [...hand].sort((a, b) => b.rank - a.rank);
  const suits = sortedHand.map(card => card.suit);
  const values = sortedHand.map(card => card.rank);

  const isFlush = suits.every(suit => suit === suits[0]);

  // Check for regular straight
  let isStraight = values.every((val, i) => i === 0 || val === values[i-1] - 1);
  let straightHighCard = values[0]; // For regular straights, highest card is first

  // Check for wheel (A-2-3-4-5) - ace low straight
  if (!isStraight && values.includes(14) && values.includes(5) &&
      values.includes(4) && values.includes(3) && values.includes(2)) {
    isStraight = true;
    straightHighCard = 5; // In wheel, 5 is the high card
  }

  // Count occurrences of each value
  const valueCounts: Record<number, number> = {};
  values.forEach((val: number) => valueCounts[val] = (valueCounts[val] || 0) + 1);

  // Organize by count
  const countGroups: Record<number, number[]> = { 4: [], 3: [], 2: [], 1: [] };
  Object.entries(valueCounts).forEach(([value, count]) => {
    countGroups[count].push(parseInt(value));
  });

  // Sort each group by value
  Object.values(countGroups).forEach(group => group.sort((a, b) => b - a));

  // Determine hand ranking
  if (isStraight && isFlush) {
    return { ...HAND_RANKINGS.STRAIGHT_FLUSH, tiebreakers: [straightHighCard] };
  }

  if (countGroups[4].length > 0) {
    return {
      ...HAND_RANKINGS.FOUR_OF_A_KIND,
      tiebreakers: [...countGroups[4], ...countGroups[1]]
    };
  }

  if (countGroups[3].length > 0 && countGroups[2].length > 0) {
    return {
      ...HAND_RANKINGS.FULL_HOUSE,
      tiebreakers: [...countGroups[3], ...countGroups[2]]
    };
  }

  if (isFlush) {
    return { ...HAND_RANKINGS.FLUSH, tiebreakers: values };
  }

  if (isStraight) {
    return { ...HAND_RANKINGS.STRAIGHT, tiebreakers: [straightHighCard] };
  }

  if (countGroups[3].length > 0) {
    return {
      ...HAND_RANKINGS.THREE_OF_A_KIND,
      tiebreakers: [...countGroups[3], ...countGroups[1]]
    };
  }

  if (countGroups[2].length === 2) {
    return {
      ...HAND_RANKINGS.TWO_PAIR,
      tiebreakers: [...countGroups[2], ...countGroups[1]]
    };
  }

  if (countGroups[2].length === 1) {
    return {
      ...HAND_RANKINGS.ONE_PAIR,
      tiebreakers: [...countGroups[2], ...countGroups[1]]
    };
  }

  return { ...HAND_RANKINGS.HIGH_CARD, tiebreakers: countGroups[1] };
};

const compareRanks = (rank1: FormatHandProps, rank2: FormatHandProps) => {
  if (rank1.score !== rank2.score) {
    return rank1.score - rank2.score;
  }

  for (let i = 0; i < Math.max(rank1.tiebreakers.length, rank2.tiebreakers.length); i++) {
    const val1 = rank1.tiebreakers[i] || 0;
    const val2 = rank2.tiebreakers[i] || 0;
    if (val1 !== val2) return val1 - val2;
  }

  return 0;
};

const formatHandDescription = (rank: FormatHandProps) => {
  const { score, name, tiebreakers } = rank;

  const formatters: Record<number, () => string> = {
    8: () => `${name} - ${valueToDisplayName(tiebreakers[0])} high`,
    7: () => `${name} - ${valueToDisplayName(tiebreakers[0])}s with ${valueToDisplayName(tiebreakers[1])} kicker`,
    6: () => `${name} - ${valueToDisplayName(tiebreakers[0])}s full of ${valueToDisplayName(tiebreakers[1])}s`,
    5: () => `${name} - ${valueToDisplayName(tiebreakers[0])} high with ${tiebreakers.slice(1).map(valueToDisplayName).join(', ')} kickers`,
    4: () => `${name} - ${valueToDisplayName(tiebreakers[0])} high`,
    3: () => `${name} - ${valueToDisplayName(tiebreakers[0])}s with ${tiebreakers.slice(1).map(valueToDisplayName).join(', ')} kickers`,
    2: () => `${name} - ${valueToDisplayName(tiebreakers[0])}s and ${valueToDisplayName(tiebreakers[1])}s with ${valueToDisplayName(tiebreakers[2])} kicker`,
    1: () => `${name} - ${valueToDisplayName(tiebreakers[0])}s with ${tiebreakers.slice(1).map(valueToDisplayName).join(', ')} kickers`,
    0: () => `${name} - ${valueToDisplayName(tiebreakers[0])} high with ${tiebreakers.slice(1).map(valueToDisplayName).join(', ')} kickers`
  };

  return formatters[score]();
};

// AI Logic
const evaluateStraightPotential = (values: number[]) => {
  const uniqueValues = [...new Set(values)].sort((a, b) => b - a);

  let maxConsecutive = 1;
  let currentConsecutive = 1;

  for (let i = 1; i < uniqueValues.length; i++) {
    if (uniqueValues[i-1] - uniqueValues[i] === 1) {
      currentConsecutive++;
      maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
    } else {
      currentConsecutive = 1;
    }
  }

  // Check for wheel potential (A-2-3-4 or A-2-3-5 or A-2-4-5 or A-3-4-5 or 2-3-4-5)
  const hasAce = uniqueValues.includes(14);
  const hasTwo = uniqueValues.includes(2);
  const hasThree = uniqueValues.includes(3);
  const hasFour = uniqueValues.includes(4);
  const hasFive = uniqueValues.includes(5);

  let wheelPotential = 0;
  if (hasAce && hasTwo && hasThree && hasFour && hasFive) {
    wheelPotential = 4; // Complete wheel
  } else if (hasAce && [hasTwo, hasThree, hasFour, hasFive].filter(Boolean).length >= 3) {
    wheelPotential = 3; // 4 cards to wheel
  } else if (hasAce && [hasTwo, hasThree, hasFour, hasFive].filter(Boolean).length === 2) {
    wheelPotential = 2; // 3 cards to wheel
  }

  maxConsecutive = Math.max(maxConsecutive, wheelPotential);

  return maxConsecutive === 4 ? 300 : maxConsecutive === 3 ? 100 : maxConsecutive === 2 ? 30 : 0;
};

const scoreKeepCombination = (cards: CardValueSuit[]) => {
  const sortedCards = [...cards].sort((a, b) => b.rank - a.rank);
  const values = sortedCards.map(c => c.rank);
  const suits = sortedCards.map(c => c.suit);

  const valueCounts: Record<number, number> = {};
  values.forEach(val => valueCounts[val] = (valueCounts[val] || 0) + 1);

  const counts = Object.values(valueCounts).sort((a, b) => b - a);

  let score = 0;

  // Score based on pairs, trips, etc.
  if (counts[0] === 3) score += 1000;
  else if (counts[0] === 2) {
    score += 500;
    if (counts[1] === 2) score += 300;
  }

  // Score based on flush potential
  const suitCounts: Record<string, number> = {};
  suits.forEach((suit: string) => suitCounts[suit] = (suitCounts[suit] || 0) + 1);
  const maxSuitCount = Math.max(...Object.values(suitCounts));
  if (maxSuitCount === 4) score += 400;
  else if (maxSuitCount === 3) score += 100;

  // Score straight potential
  score += evaluateStraightPotential(values);

  // High card bonus
  score += values.reduce((sum, val, index) => sum + val * (5 - index), 0);

  return score;
};

interface SwappingCards {
  ai: CardValueSuit[];
  player: CardValueSuit[];
};

// Main Component
const CaliforniaPoker = () => {
  const [gameState, setGameState] = useState(GAME_STATES.INITIAL);
  const [playerHand, setPlayerHand] = useState<CardValueSuit[]>([]);
  const [aiHand, setAiHand] = useState<CardValueSuit[]>([]);
  const [playerSelected, setPlayerSelected] = useState<number[]>([]);
  const [winner, setWinner] = useState<string | null>(null);
  const [playerBestHand, setPlayerBestHand] = useState<BestHandType | undefined>();
  const [aiBestHand, setAiBestHand] = useState<BestHandType | undefined>();
  const [swappingCards, setSwappingCards] = useState<SwappingCards>({ player: [], ai: [] });
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
      setPlayerSelected(playerSelected.filter(i => i !== cardIndex));
    } else if (playerSelected.length < 4) {
      setPlayerSelected([...playerSelected, cardIndex]);
    }
  };

  const aiSelectCards = () => {
    const allCombinations = getSwapCombinations();

    let bestScore = -1;
    let bestCombination = allCombinations[0];

    allCombinations.forEach(combination => {
      const cardsToKeep = aiHand.filter((_, index) => !combination.includes(index));
      const score = scoreKeepCombination(cardsToKeep);

      if (score > bestScore) {
        bestScore = score;
        bestCombination = combination;
      }
    });

    return bestCombination;
  };

  const calculateMovingCards = (playerSwapIndices: number[], aiSwapIndices: number[]) => {
    const movingCardData: MovingCardData[] = [];

    playerSwapIndices.forEach((playerCardIndex, swapIndex) => {
      const aiCardIndex = aiSwapIndices[swapIndex];

      const playerSource = document.querySelector(`[data-card-id="player-${playerCardIndex}"]`);
      const aiTarget = document.querySelector(`[data-card-id="ai-${aiCardIndex}"]`);
      const aiSource = document.querySelector(`[data-card-id="ai-${aiCardIndex}"]`);
      const playerTarget = document.querySelector(`[data-card-id="player-${playerCardIndex}"]`);

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
          direction: 'playerToAi'
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
          direction: 'aiToPlayer'
        });
      }
    });

    return movingCardData;
  };

  const swapCards = () => {
    if (playerSelected.length !== 4) return;

    const aiSelection = aiSelectCards();
    setGameState(GAME_STATES.SWAPPING);

    const playerSwapCards = playerSelected.map(i => ({ ...playerHand[i], originalIndex: i }));
    const aiSwapCards = aiSelection.map((i: number) => ({ ...aiHand[i], originalIndex: i }));

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

    combinations.forEach(hand => {
      const rank = evaluateHand(hand);
      if (compareRanks(rank, bestRank) > 0) {
        bestHand = hand;
        bestRank = rank;
      }
    });

    return { cards: bestHand, rank: bestRank };
  };

  useEffect(() => {
    dealCards();
  }, []);

  return (
    <div className="min-h-screen bg-gray-100 p-2">
      <div className="max-w-6xl mx-auto game-container relative">
        {gameState === GAME_STATES.INITIAL && (
          <div className="text-center">
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
            <div className="space-y-0">
              <HandDisplay
                title="Opponent Hand"
                cards={aiHand}
                area="ai"
                winner={winner}
                winnerType="ai"
                bestHand={aiBestHand}
                swappingCards={swappingCards.ai}
                showSwapAnimation={showSwapAnimation}
                gameState={gameState}
                formatHandDescription={formatHandDescription}
                selectedCards={[]}
              />

              <div className="text-center">
                <h1 className="text-2xl font-bold text-gray-400">California Poker</h1>
              </div>

              <HandDisplay
                title="Your Hand"
                cards={playerHand}
                area="player"
                winner={winner}
                winnerType="player"
                bestHand={playerBestHand}
                onCardClick={toggleCardSelection}
                selectedCards={playerSelected}
                swappingCards={swappingCards.player}
                showSwapAnimation={showSwapAnimation}
                gameState={gameState}
                formatHandDescription={formatHandDescription}
              />
            </div>

            <div className="text-center mt-1 h-10">
              {(gameState === GAME_STATES.SELECTING || gameState === GAME_STATES.SWAPPING) && (
                <>
                  <button
                    onClick={swapCards}
                    disabled={playerSelected.length !== 4 || gameState === GAME_STATES.SWAPPING}
                    className={`${BUTTON_BASE} ${
                      playerSelected.length === 4 && gameState !== GAME_STATES.SWAPPING
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
