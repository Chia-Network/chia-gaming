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
  const [swappingCards, setSwappingCards] = useState<PlayerSwappingCardLists>({
    final: false,
    originalMyCards: [],
    originalTheirCards: [],
    player: [],
    ai: []
  });
  const [receivedOutcome, setReceivedOutcome] = useState(false);

  const setStateFromMessage = useCallback((evt: any) => {
    setState(evt.data);
  }, []);

  const repeatAnimation = useCallback(() => {
    setReceivedOutcome(false);
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
    const useSwappingCards: PlayerSwappingCardLists = {
      final: true,
      player: [],
      ai: [],
      originalMyCards: [...playerHand],
      originalTheirCards: [...opponentHand],
    };
    function findTargetIndex(targetList: any[], want: string, idx: number) {
      for (var i = 0; i < targetList.length; i++) {
        const t = targetList[i];
        if (t.color.startsWith(want)) {
          if (idx == 0) {
            return i;
          }
          idx--;
        }
      }

      return 0;
    }
    function processCard({ index, originallyMine, card, color }: ExplodedPostGameCard, idx: number) {
      if (originallyMine && color.startsWith('their')) {
        useSwappingCards.player.push({
          originalIndex: index,
          targetIndex: findTargetIndex(myCardsWithColors, 'my', index),
          id: `player-${index}`,
          rank: formatRank(card),
          suit: suitSymbols[card[1]],
          value: (card[1] - 1) + (4 * card[1]),
        });
      }
      if (!originallyMine && color.startsWith('my')) {
        useSwappingCards.ai.push({
          originalIndex: index,
          targetIndex: findTargetIndex(theirCardsWithColors, 'their', index),
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
        <Button aria-label="repeat-anim" onClick={repeatAnimation}>Repeat Animation</Button>
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
            {moveNumber === 0 && 'Commit to random number'}
            {gameState === 'playing' && moveNumber === 1 && 'Select 4 cards to KEEP and swap the rest'}
            {gameState === 'playing' && moveNumber === 2 && 'Finish game'}
            {gameState === 'swapping' && 'Cards are swapping...'}
            {gameState === 'final' && 'Final Results'}
          </div>
        </div>

        <Box
          display="flex"
          flexDirection="column"
          alignItems="center"
          gap={2}
          width="100%"
        >
          <GameEndPlayer
            iStarted={iStarted}
            playerNumber={iStarted ? 2 : 1}
            outcome={outcome}
            showSwapAnimation={showSwapAnimation}
            swappingCards={swappingCards}
            cardSelections={cardSelections}
          />
          {showSwapAnimation && (
            <>
              {movingCards.map((cardData, index) => (
                <MovingCard key={`moving-${index}`} cardData={cardData} />
              ))}
            </>
          )}
          <GameEndPlayer
            iStarted={iStarted}
            playerNumber={iStarted ? 1 : 2}
            outcome={outcome}
            showSwapAnimation={showSwapAnimation}
            swappingCards={swappingCards}
            cardSelections={cardSelections}
          />
        </Box>
        <Box flex={1} display="flex" flexDirection="column">
        </Box>
      </Box>
    </Box>
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
          <PlayerSection
            playerNumber={playerNumber}
            playerHand={playerHand}
            isPlayerTurn={isPlayerTurn}
            moveNumber={moveNumber}
            handleMakeMove={handleMakeMove}
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
