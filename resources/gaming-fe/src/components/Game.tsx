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
import HandDisplay from "./HandDisplay";
import GameEndPlayer from "./GameEndPlayer";
import GameLog from "./GameLog";
import WaitingScreen from "./WaitingScreen";
import MovingCard from "./MovingCard";
import { useWasmBlob } from "../hooks/useWasmBlob";
import { getGameSelection } from '../util';
import { CardData, SwappingCard, MovingCardData, PlayerSwappingCardLists, ExplodedPostGameCard, triggerSwapAnimation, card_color, suitSymbols, formatRank } from "../types/ChiaGaming";

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
  const [swappingCards, setSwappingCards] = useState<PlayerSwappingCardLists>({ final: false, player: [], ai: [] });
  const [receivedOutcome, setReceivedOutcome] = useState(false);

  const setStateFromMessage = useCallback((evt: any) => {
    setState(evt.data);
  }, []);

  useEffect(function () {
    window.addEventListener("message", setStateFromMessage);

    return function () {
      window.removeEventListener("message", setStateFromMessage);
    };
  });

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
  const iAmAlice = playerNumber === 2;
  if (outcome && !swappingCards.final) {
    console.error('about to process outcome and compute swapping cards', outcome);
    const myCardsWithColors = playerHand.map((c, i) => {
      return {
        index: i,
        card: c,
        originallyMine: true,
        color: card_color(outcome, iAmAlice, c)
      };
    });
    const theirCardsWithColors = opponentHand.map((c, i) => {
      return {
        index: i,
        card: c,
        originallyMine: false,
        color: card_color(outcome, !iAmAlice, c)
      };
    });
    const useSwappingCards: PlayerSwappingCardLists = { final: true, player: [], ai: [] };
    function processCard({ index, originallyMine, card, color }: ExplodedPostGameCard) {
      if (originallyMine && color.startsWith('their')) {
        useSwappingCards.player.push({
          originalIndex: index,
          id: `player-${index}`,
          rank: formatRank(card),
          suit: suitSymbols[card[1]],
          value: (card[1] - 1) + (4 * card[1]),
        });
      }
      if (!originallyMine && color.startsWith('my')) {
        useSwappingCards.ai.push({
          originalIndex: index,
          id: `ai-${index}`,
          rank: formatRank(card),
          suit: suitSymbols[card[1]],
          value: (card[1] - 1) + (4 * card[1]),
        });
      }
    }
    myCardsWithColors.forEach(processCard);
    theirCardsWithColors.forEach(processCard);
    console.error('processed swapping cards', useSwappingCards);
    setSwappingCards(useSwappingCards);
  }

  let myWinOutcome = outcome?.my_win_outcome;
  let colors = {
    'win': 'green',
    'lose': 'red',
    'tie': '#ccc',
    'success': '#363',
    'warning': '#633',
  };
  let color: 'success' | 'warning' | 'win' | 'lose' | 'tie' = myWinOutcome ? myWinOutcome : isPlayerTurn ? "success" : "warning";
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

  if (outcome && !receivedOutcome && swappingCards.final) {
    setReceivedOutcome(true);

    // Swap animation function
    triggerSwapAnimation({
      moveNumber,
      playerHand,
      opponentHand,
      cardSelections,
      gameState,
      setGameState,
      showSwapAnimation,
      setShowSwapAnimation,
      movingCards,
      setMovingCards,
      swappingCards,
    });
  }

  if (outcome) {
    return (
    <>
      <Box
        p={2}
        style={{
          background: '#f3f4f6',
          minHeight: '100vh',
        }}
      >
        <Box
          style={{
            maxWidth: '1200px',
            margin: '0 auto',
            padding: '16px',
            position: 'relative',
          }}
        >
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
          <div style={{ marginBottom: '8px' }}>
            <div style={{ textAlign: 'center', fontSize: '16px', fontWeight: 'bold', marginBottom: '8px' }}>
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
            gap={0}
            width="100%"
          >
            <HandDisplay
              title="Opponent Hand"
              cards={opponentHand}
              area="ai"
              isPlayer={false}
              swappingCards={swappingCards.ai}
              showSwapAnimation={showSwapAnimation}
              gameState="final"
              winner={myWinOutcome}
              winnerType={myWinOutcome === 'lose' ? 'ai' : myWinOutcome === 'win' ? 'player' : undefined}
            />
            
            <Typography variant="h4" align="center" style={{
              margin: '8px 0',
              color: '#9ca3af',
              fontWeight: 'bold',
              fontSize: '1.5rem'
            }}>
              California Poker
            </Typography>
            
            <HandDisplay
              title="Your Hand"
              cards={playerHand}
              area="player"
              isPlayer={true}
              swappingCards={swappingCards.player}
              showSwapAnimation={showSwapAnimation}
              gameState="final"
              winner={myWinOutcome}
              winnerType={myWinOutcome === 'win' ? 'player' : myWinOutcome === 'lose' ? 'ai' : undefined}
            />
          </Box>
          <Box flex={1} display="flex" flexDirection="column">
          </Box>
        </Box>
      </Box>
      {/* Moving Cards rendered outside main container */}
      {showSwapAnimation && (
        <>
          {movingCards.map((cardData, index) => (
            <MovingCard key={`moving-${index}`} cardData={cardData} />
          ))}
        </>
      )}
    </>
    );
  }

  return (
    <>
      <Box
        p={2}
        style={{
          background: '#f3f4f6',
          minHeight: '100vh',
        }}
      >
        <Box
          style={{
            maxWidth: '1200px',
            margin: '0 auto',
            padding: '16px',
            position: 'relative',
          }}
        >
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
          <div style={{ marginBottom: '8px' }}>
            <div style={{ textAlign: 'center', fontSize: '16px', fontWeight: 'bold', marginBottom: '8px' }}>
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
            gap={0}
            width="100%"
          >
            <HandDisplay
              title="Opponent Hand"
              cards={opponentHand}
              area="ai"
              isPlayer={false}
              swappingCards={swappingCards.ai}
              showSwapAnimation={showSwapAnimation}
              gameState={gameState}
            />
            
            <Typography variant="h4" align="center" style={{
              margin: '8px 0',
              color: '#9ca3af',
              fontWeight: 'bold',
              fontSize: '1.5rem'
            }}>
              California Poker
            </Typography>
            
            <HandDisplay
              title="Your Hand"
              cards={playerHand}
              area="player"
              isPlayer={true}
              onCardClick={(index) => {
                if (gameState !== 'playing' || moveNumber !== 1) return;
                const currentSelections = cardSelections;
                let newSelections;
                if (currentSelections & (1 << index)) {
                  newSelections = currentSelections & ~(1 << index);
                } else {
                  newSelections = currentSelections | (1 << index);
                }
                setCardSelections(newSelections);
              }}
              selectedCards={(() => {
                const selected = [];
                for (let i = 0; i < 8; i++) {
                  if (cardSelections & (1 << i)) {
                    selected.push(i);
                  }
                }
                return selected;
              })()}
              swappingCards={swappingCards.player}
              showSwapAnimation={showSwapAnimation}
              gameState={gameState}
            />
            
            <Box mt={1} textAlign="center">
              {moveNumber === 1 && (
                <div style={{ marginBottom: '8px', fontSize: '14px', fontWeight: 'bold' }}>
                  Select 4 cards to KEEP ({(() => {
                    let count = 0;
                    for (let i = 0; i < 8; i++) {
                      if (cardSelections & (1 << i)) count++;
                    }
                    return count;
                  })()}/4 selected)
                </div>
              )}
              <Button
                aria-label="make-move"
                onClick={() => handleMakeMove("80")}
                disabled={!isPlayerTurn || (moveNumber === 1 && (() => {
                  let count = 0;
                  for (let i = 0; i < 8; i++) {
                    if (cardSelections & (1 << i)) count++;
                  }
                  return count !== 4;
                })())}
                style={{
                  background: isPlayerTurn && (moveNumber !== 1 || (() => {
                    let count = 0;
                    for (let i = 0; i < 8; i++) {
                      if (cardSelections & (1 << i)) count++;
                    }
                    return count === 4;
                  })()) ? '#2563eb' : '#d1d5db',
                  color: isPlayerTurn && (moveNumber !== 1 || (() => {
                    let count = 0;
                    for (let i = 0; i < 8; i++) {
                      if (cardSelections & (1 << i)) count++;
                    }
                    return count === 4;
                  })()) ? '#ffffff' : '#6b7280',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '8px 24px',
                  fontSize: '16px',
                  fontWeight: 'bold',
                  cursor: isPlayerTurn && (moveNumber !== 1 || (() => {
                    let count = 0;
                    for (let i = 0; i < 8; i++) {
                      if (cardSelections & (1 << i)) count++;
                    }
                    return count === 4;
                  })()) ? 'pointer' : 'default',
                  minWidth: '256px',
                }}
              >
                {moveNumber === 1 ? 'Swap Cards' : 'Make Move'}
              </Button>
            </Box>
          </Box>
          <Typography style={{ marginTop: '16px', fontSize: '14px', color: '#666' }}>
            {moveDescription}
          </Typography>
          <GameLog log={[]} />
        </Box>
      </Box>
      {/* Moving Cards rendered outside main container */}
      {showSwapAnimation && (
        <>
          {movingCards.map((cardData, index) => (
            <MovingCard key={`moving-${index}`} cardData={cardData} />
          ))}
        </>
      )}
    </>
  );
};

export default Game;
