import React from 'react';
import { Box, Button, TextField, Typography } from '@mui/material';

interface LobbyScreenProps {
  wagerAmount: string;
  setWagerAmount: (value: string) => void;
  handleFindOpponent: () => void;
}

const LobbyScreen: React.FC<LobbyScreenProps> = ({
  wagerAmount,
  setWagerAmount,
  handleFindOpponent,
}) => {
  return (
    <Box p={4}>
      <Typography variant="h4">Welcome to Cal Poker</Typography>
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
      <Button variant="contained" color="primary" onClick={handleFindOpponent}>
        Find an opponent
      </Button>
    </Box>
  );
};

export default LobbyScreen;
