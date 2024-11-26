// App.tsx
import React, { useState } from 'react';
import {
  Box,
  Button,
  TextField,
  Typography,
  CircularProgress,
  Grid,
  Paper,
} from '@mui/material';

const App: React.FC = () => {
  type GameState = 'idle' | 'searching' | 'playing';

  const [gameState, setGameState] = useState<GameState>('idle');
  const [wagerAmount, setWagerAmount] = useState<string>('');
  const [log, setLog] = useState<string[]>([]);
  const [playerHand, setPlayerHand] = useState<string[]>([]);
  const [opponentHand, setOpponentHand] = useState<string[]>([]);
  const [playerCoins, setPlayerCoins] = useState<number>(100);
  const [opponentCoins, setOpponentCoins] = useState<number>(100);

  const handleFindOpponent = () => {
    if (wagerAmount === '') {
      alert('Please enter a wager amount.');
      return;
    }
    setGameState('searching');
    setTimeout(() => {
      setGameState('playing');
      setLog((prevLog) => [
        ...prevLog,
        `Opponent found! Wager amount: ${wagerAmount} XCH`,
      ]);
      dealHands();
    }, 5000);
  };

  const dealHands = () => {
    const deck = createDeck();
    shuffleDeck(deck);
    const playerCards = deck.slice(0, 5);
    const opponentCards = deck.slice(5, 10);
    setPlayerHand(playerCards);
    setOpponentHand(opponentCards);
    setLog((prevLog) => [...prevLog, 'Hands have been dealt.']);
  };

  const createDeck = (): string[] => {
    const suits = ['♠', '♥', '♦', '♣'];
    const ranks = [
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      'J',
      'Q',
      'K',
      'A',
    ];
    const deck: string[] = [];
    for (let suit of suits) {
      for (let rank of ranks) {
        deck.push(`${rank}${suit}`);
      }
    }
    return deck;
  };

  const shuffleDeck = (deck: string[]): void => {
    for (let i = deck.length - 1; i > 0; i--) {
      const j: number = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
  };

  const handleBet = (player: 'player' | 'opponent', amount: number): void => {
    if (player === 'player') {
      if (playerCoins >= amount) {
        setPlayerCoins(playerCoins - amount);
        setLog((prevLog) => [
          ...prevLog,
          `Player 1 bets ${amount} coins.`,
        ]);
      } else {
        alert("Player 1 doesn't have enough coins.");
      }
    } else if (player === 'opponent') {
      if (opponentCoins >= amount) {
        setOpponentCoins(opponentCoins - amount);
        setLog((prevLog) => [
          ...prevLog,
          `Player 2 bets ${amount} coins.`,
        ]);
      } else {
        alert("Player 2 doesn't have enough coins.");
      }
    }
  };

  const handleMove = (player: 'player' | 'opponent'): void => {
    if (player === 'player') {
      setLog((prevLog) => [...prevLog, 'Player 1 made a move.']);
    } else if (player === 'opponent') {
      setLog((prevLog) => [...prevLog, 'Player 2 made a move.']);
    }
  };

  if (gameState === 'idle') {
    return (
      <Box p={4}>
        <Typography variant="h4">Welcome to the Cal Poker!</Typography>
        <TextField
          label="Enter wager amount in XCH"
          type="number"
          value={wagerAmount}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setWagerAmount(e.target.value)
          }
          fullWidth
          margin="normal"
        />
        <Button
          variant="contained"
          color="primary"
          onClick={handleFindOpponent}
        >
          Find an opponent
        </Button>
      </Box>
    );
  } else if (gameState === 'searching') {
    return (
      <Box
        p={4}
        display="flex"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        height="100vh"
      >
        <Typography variant="h4">Searching for an opponent...</Typography>
        <CircularProgress />
      </Box>
    );
  } else if (gameState === 'playing') {
    return (
      <Box p={4}>
        <Typography variant="h4" align="center">
          Cal Poker
        </Typography>
        <br />
        <Grid container spacing={4}>
          <Grid item xs={12} md={6}>
            <Paper elevation={3} style={{ padding: '16px' }}>
              <Typography variant="h5">Player 1 (You)</Typography>
              <Typography>Coins: {playerCoins}</Typography>
              <Typography variant="h6">Your Hand:</Typography>
              <Box display="flex" flexDirection="row" mb={2}>
                {playerHand.map((card, index) => (
                  <Typography
                    key={index}
                    variant="h4"
                    style={{ marginRight: '8px' }}
                  >
                    {card}
                  </Typography>
                ))}
              </Box>
              <Typography>Bet:</Typography>
              <Box display="flex" flexDirection="row" mb={2}>
                <Button
                  variant="outlined"
                  onClick={() => handleBet('player', 5)}
                  style={{ marginRight: '8px' }}
                >
                  Bet 5
                </Button>
                <Button
                  variant="outlined"
                  onClick={() => handleBet('player', 10)}
                  style={{ marginRight: '8px' }}
                >
                  Bet 10
                </Button>
                <Button
                  variant="outlined"
                  onClick={() => handleBet('player', 20)}
                >
                  Bet 20
                </Button>
              </Box>
              <Button
                variant="contained"
                color="primary"
                onClick={() => handleMove('player')}
              >
                Make a move
              </Button>
            </Paper>
          </Grid>
          <Grid item xs={12} md={6}>
            <Paper elevation={3} style={{ padding: '16px' }}>
              <Typography variant="h5">Player 2 (Opponent)</Typography>
              <Typography>Coins: {opponentCoins}</Typography>
              <Typography variant="h6">Opponent's Hand:</Typography>
              <Box display="flex" flexDirection="row" mb={2}>
                {opponentHand.map((card, index) => (
                  <Typography
                    key={index}
                    variant="h4"
                    style={{ marginRight: '8px' }}
                  >
                    {card}
                  </Typography>
                ))}
              </Box>
              <Typography>Bet:</Typography>
              <Box display="flex" flexDirection="row" mb={2}>
                <Button
                  variant="outlined"
                  onClick={() => handleBet('opponent', 5)}
                  style={{ marginRight: '8px' }}
                >
                  Bet 5
                </Button>
                <Button
                  variant="outlined"
                  onClick={() => handleBet('opponent', 10)}
                  style={{ marginRight: '8px' }}
                >
                  Bet 10
                </Button>
                <Button
                  variant="outlined"
                  onClick={() => handleBet('opponent', 20)}
                >
                  Bet 20
                </Button>
              </Box>
              <Button
                variant="contained"
                color="primary"
                onClick={() => handleMove('opponent')}
              >
                Make a move
              </Button>
            </Paper>
          </Grid>
        </Grid>
        <Box mt={4}>
          <Typography variant="h5">Game Log:</Typography>
          <br />
          <Paper elevation={1} style={{ maxHeight: '200px', overflow: 'auto', padding: '8px' }}>
            {log.map((entry, index) => (
              <Typography key={index}>{entry}</Typography>
            ))}
          </Paper>
        </Box>
      </Box>
    );
  }

  return null;
};

export default App;
