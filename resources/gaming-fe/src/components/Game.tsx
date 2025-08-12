import React, { cloneElement, useState, useEffect, useCallback } from "react";
import {
  Box,
  Button,
  ButtonGroup,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Typography,
} from "@mui/material";
import useGameSocket from "../hooks/useGameSocket";
import PlayerSection from "./PlayerSection";
import OpponentSection from "./OpponentSection";
import GameEndPlayer from "./GameEndPlayer";
import GameLog from "./GameLog";
import WaitingScreen from "./WaitingScreen";
import MovingCard from "./MovingCard";
import { useWasmBlob } from "../hooks/useWasmBlob";
import { getGameSelection } from '../util';

interface CardData {
  rank: string;
  suit: string;
  value: number;
}

interface SwappingCard extends CardData {
  originalIndex: number;
  id: string;
}

interface MovingCardData {
  card: CardData & { id: string };
  startPosition: { x: number; y: number };
  endPosition: { x: number; y: number };
  direction: string;
}

const Game: React.FC = () => {
  const gameSelection = getGameSelection();
  const {
    error,
    gameConnectionState,
    setState,
    isPlayerTurn,
    iStarted,
    moveNumber,
    handleMakeMove,
    playerHand,
    opponentHand,
    playerNumber,
    cardSelections,
    setCardSelections,
    outcome,
    stopPlaying
  } = useWasmBlob();

  // Add swap animation state
  const [gameState, setGameState] = useState<'playing' | 'swapping' | 'final'>('playing');
  const [showSwapAnimation, setShowSwapAnimation] = useState(false);
  const [movingCards, setMovingCards] = useState<MovingCardData[]>([]);
  const [swappingCards, setSwappingCards] = useState<{ player: SwappingCard[], ai: SwappingCard[] }>({ player: [], ai: [] });

  const setStateFromMessage = useCallback((evt: any) => {
    setState(evt.data);
  }, []);

  useEffect(function () {
    window.addEventListener("message", setStateFromMessage);

    return function () {
      window.removeEventListener("message", setStateFromMessage);
    };
  });

  // Function to convert card value array to display format
  const formatCard = (cardValue: number[]): CardData => {
    const suitSymbols = ['♠', '♥', '♦', '♠', '♣'];
    const rank = cardValue.slice(0, -1);
    const suitIndex = cardValue.slice(-1)[0] as number;
    const suit = suitSymbols[suitIndex] || suitSymbols[0];
    
    const formatRank = (rankArr: number[]): string => {
      if (rankArr.length === 0) return '';
      const rankValue = rankArr[0];
      if (rankValue === 10) return '10';
      if (rankValue === 11) return 'J';
      if (rankValue === 12) return 'Q';
      if (rankValue === 13) return 'K';
      if (rankValue === 14) return 'A';
      return rankValue.toString();
    };

    return {
      rank: formatRank(rank),
      suit: suit,
      value: rank[0] || 0
    };
  };

  // Swap animation function
  const triggerSwapAnimation = useCallback(() => {
    if (moveNumber !== 1) return; // Only trigger on card selection move
    
    setGameState('swapping');
    
    // Get selected cards indices (cards to KEEP)
    const playerSelected = [];
    for (let i = 0; i < 8; i++) {
      if (cardSelections & (1 << i)) {
        playerSelected.push(i);
      }
    }

    // Cards to swap are the ones NOT selected
    const playerSwapIndices: number[] = [];
    const aiSwapIndices: number[] = [];
    for (let i = 0; i < Math.min(playerHand.length, opponentHand.length); i++) {
      if (!playerSelected.includes(i)) {
        playerSwapIndices.push(i);
        aiSwapIndices.push(i); // AI swaps corresponding positions
      }
    }

    const playerSwapCards = playerSwapIndices.map(i => ({ 
      ...formatCard(playerHand[i]), 
      originalIndex: i,
      id: `player-${i}` 
    }));
    const aiSwapCards = aiSwapIndices.map(i => ({ 
      ...formatCard(opponentHand[i]), 
      originalIndex: i,
      id: `ai-${i}` 
    }));

    setSwappingCards({ player: playerSwapCards, ai: aiSwapCards });

    // Start animation after brief delay to ensure DOM is ready
    setTimeout(() => {
      const movingCardData: MovingCardData[] = [];
      
      // Calculate positions for each swapping card
      playerSwapIndices.forEach((playerCardIndex, swapIndex) => {
        const aiCardIndex = aiSwapIndices[swapIndex];
        
        const playerSource = document.querySelector(`[data-card-id="player-${playerCardIndex}"]`);
        const aiTarget = document.querySelector(`[data-card-id="ai-${aiCardIndex}"]`);
        const aiSource = document.querySelector(`[data-card-id="ai-${aiCardIndex}"]`);
        const playerTarget = document.querySelector(`[data-card-id="player-${playerCardIndex}"]`);
        
        if (playerSource && aiTarget) {
          const playerRect = playerSource.getBoundingClientRect();
          const aiRect = aiTarget.getBoundingClientRect();
          
          // Player card moving to AI position
          movingCardData.push({
            card: { 
              ...formatCard(playerHand[playerCardIndex]), 
              id: `player-${playerCardIndex}` 
            },
            startPosition: {
              x: playerRect.left + playerRect.width / 2,
              y: playerRect.top + playerRect.height / 2
            },
            endPosition: {
              x: aiRect.left + aiRect.width / 2,
              y: aiRect.top + aiRect.height / 2
            },
            direction: 'playerToAi'
          });
        }
        
        if (aiSource && playerTarget) {
          const aiRect = aiSource.getBoundingClientRect();
          const playerRect = playerTarget.getBoundingClientRect();
          
          // AI card moving to player position
          movingCardData.push({
            card: { 
              ...formatCard(opponentHand[aiCardIndex]), 
              id: `ai-${aiCardIndex}` 
            },
            startPosition: {
              x: aiRect.left + aiRect.width / 2,
              y: aiRect.top + aiRect.height / 2
            },
            endPosition: {
              x: playerRect.left + playerRect.width / 2,
              y: playerRect.top + playerRect.height / 2
            },
            direction: 'aiToPlayer'
          });
        }
      });
      
      setMovingCards(movingCardData);
      setShowSwapAnimation(true);
    }, 100);

    // Clean up animation and proceed with game after 2.5 seconds
    setTimeout(() => {
      setShowSwapAnimation(false);
      setMovingCards([]);
      setGameState('final');
      
      // Proceed with the actual move
      handleMakeMove("80");
    }, 2500);
  }, [cardSelections, playerHand, opponentHand, moveNumber, handleMakeMove]);

  // All early returns need to be after all useEffect, etc.
  if (error) {
    return (<div>{error}</div>);
  }

  if (gameConnectionState.stateIdentifier === 'starting') {
    return <WaitingScreen stateName={gameConnectionState.stateIdentifier} messages={gameConnectionState.stateDetail}  />;
  }

  if (gameConnectionState.stateIdentifier === 'shutdown') {
    return (
      <Box p={4}>
          <Typography variant="h4" align="center">
              {`Cal Poker - shutdown succeeded`}
          </Typography>
      </Box>
    );
  }

  console.log('game outcome', outcome);
  let myWinOutcome = outcome?.my_win_outcome;
  let colors = {
    'win': 'green',
    'lose': 'red',
    'tie': '#ccc',
    'success': '#363',
    'warning': '#633',
  };
  let color: 'success' | 'warning' | 'win' | 'lose' | 'tie' = myWinOutcome ? myWinOutcome : isPlayerTurn ? "success" : "warning";
  const iAmAlice = playerNumber === 2;
  const myHandValue = iAmAlice ? outcome?.alice_hand_value : outcome?.bob_hand_value;
  let banner = isPlayerTurn ? "Your turn" : "Opponent's turn";
  if (myWinOutcome === 'win') {
    banner = `You win ${myHandValue}`;
  } else if (myWinOutcome === 'lose') {
    banner = `You lose ${myHandValue}`;
  } else if (myWinOutcome === 'tie') {
    banner = `Game tied ${myHandValue}`;
  }
  const moveDescription = [
    "Commit to random number",
    "Choose 4 cards to discard",
    "Finish game"
  ][moveNumber];

  if (outcome) {
    return (
      <div id='total'>
        <div id='overlay'> </div>
        <Box p={4}>
          <Typography variant="h4" align="center">
          {`Cal Poker - move ${moveNumber}`}
          </Typography>
          <br />
          <Typography
            variant="h6"
            align="center"
            color={colors[color]}
          >
            {banner}
          </Typography>
          <br />
          <Box
            display="flex"
            flexDirection={{ xs: "column", md: "row" }}
            alignItems="stretch"
            gap={2}
            mb={4}
          >
            <Box flex={1} display="flex" flexDirection="column">
              <GameEndPlayer
                iStarted={iStarted}
                playerNumber={iStarted ? 1 : 2}
                outcome={outcome}
              />
            </Box>
            <Box flex={1} display="flex" flexDirection="column">
                <GameEndPlayer
                    iStarted={iStarted}
                    playerNumber={iStarted ? 2 : 1}
                    outcome={outcome}
                />
            </Box>
          </Box>
        </Box>
      </div>
    );
  }

  return (
    <Box 
      p={4} 
      style={{
        background: '#dcfce7',
        minHeight: '100vh',
      }}
    >
      <Box
        style={{
          maxWidth: '1200px',
          margin: '0 auto',
          padding: '16px',
        }}
      >
        <Typography variant="h4" align="center" style={{ 
          marginBottom: '24px', 
          color: '#166534',
          fontWeight: 'bold',
          fontSize: '2.5rem'
        }}>
        California Poker
        </Typography>
        <Button 
          aria-label="stop-playing" 
          onClick={stopPlaying} 
          disabled={moveNumber !== 0}
          style={{
            marginBottom: '16px',
            background: moveNumber === 0 ? '#1976d2' : '#b0bec5',
            color: '#fff',
            border: 'none',
            borderRadius: '5px',
            padding: '8px 16px',
          }}
        >
          Stop
        </Button>
        <Typography
          variant="h6"
          align="center"
          style={{ 
            color: colors[color],
            marginBottom: '16px',
          }}
        >
          {banner}
        </Typography>
        <div style={{ marginBottom: '32px' }}>
          <div style={{ textAlign: 'center', fontSize: '20px', fontWeight: 'bold', marginBottom: '16px' }}>
            {gameState === 'playing' && moveNumber === 1 && 'Select 4 cards to KEEP and swap the rest'}
            {gameState === 'swapping' && 'Cards are swapping...'}
            {gameState === 'final' && 'Final Results'}
            {moveNumber === 0 && 'Commit to random number'}
            {moveNumber === 2 && 'Finish game'}
          </div>
        </div>

        <Box
          display="flex"
          flexDirection="column"
          alignItems="center"
          gap={2}
          width="100%"
        >
          <OpponentSection
              playerNumber={(playerNumber == 1) ? 2 : 1}
              opponentHand={opponentHand}
              swappingCards={swappingCards}
              showSwapAnimation={showSwapAnimation}
          />
          
          {showSwapAnimation && (
            <>
              {movingCards.map((cardData, index) => (
                <MovingCard key={`moving-${index}`} cardData={cardData} />
              ))}
            </>
          )}
          
          <PlayerSection
            playerNumber={playerNumber}
            playerHand={playerHand}
            isPlayerTurn={isPlayerTurn}
            moveNumber={moveNumber}
            handleMakeMove={triggerSwapAnimation}
            cardSelections={cardSelections}
            setCardSelections={setCardSelections}
            swappingCards={swappingCards}
            showSwapAnimation={showSwapAnimation}
          />
        </Box>
        <Typography style={{ marginTop: '16px', fontSize: '14px', color: '#666' }}>
          {moveDescription}
        </Typography>
        <GameLog log={[]} />
      </Box>
    </Box>
  );
};

export default Game;
