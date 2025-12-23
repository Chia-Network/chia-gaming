import { Box, Typography, CircularProgress } from '@mui/material';
const WalletStatus = () => {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        color: '#333333',
      }}
    >
        <CircularProgress
          size={14}
          thickness={5}
          sx={{ color: '#333333', ml: 0.5 }}
        />
      <Typography fontSize='0.85rem' fontWeight={500}>
        Waiting for WalletConnect connection...
      </Typography>

    </Box>
  );
};

export default WalletStatus;
