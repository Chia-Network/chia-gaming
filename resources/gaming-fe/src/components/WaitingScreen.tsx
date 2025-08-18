import React from 'react';
import { Box, Typography, CircularProgress } from '@mui/material';

interface WaitingScreenProps {
  stateName: string;
  messages: string[];
};

const WaitingScreen: React.FC<WaitingScreenProps> = ({ stateName, messages }) => {
  return (
    <Box
      p={4}
      display="flex"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      height="100vh"
    >
      <Typography aria-label="waiting-state" variant="h4">{stateName}</Typography>
      <div>{messages.map((msg) => <div>{msg}</div>)}</div>
      <CircularProgress />
    </Box>
  );
};

export default WaitingScreen;

