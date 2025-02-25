import React from 'react';
import { Box, Typography, CircularProgress } from '@mui/material';

const WaitingScreen: React.FC = () => {
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
};

export default WaitingScreen;

