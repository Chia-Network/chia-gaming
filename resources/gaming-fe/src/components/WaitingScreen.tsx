import { Box, Typography, CircularProgress } from '@mui/material';

interface WaitingScreenProps {
  stateName: string;
  messages: string[];
}

const WaitingScreen = ({ stateName, messages }: WaitingScreenProps) => {
  return (
    <Box
      p={4}
      display='flex'
      flexDirection='column'
      alignItems='center'
      justifyContent='center'
      height='100vh'
    >
      <Typography variant='h4' aria-label='waiting-state'>
        {stateName}
      </Typography>
      <div>
        {messages.map((msg) => (
          <div>{msg}</div>
        ))}
      </div>
      <CircularProgress />
    </Box>
  );
};

export default WaitingScreen;
