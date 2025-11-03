import { Box, Typography } from '@mui/material';

interface WalletBadgeProps {
  sessionConnected: 'connected' | 'simulator' | 'disconnected';
}

const WalletBadge = ({ sessionConnected }: WalletBadgeProps) => {
  let bgColor = '';
  let textColor = '';
  let borderColor = '';
  let label = '';

  switch (sessionConnected) {
    case 'connected':
      bgColor = '#D4EDDA';
      textColor = '#155724';
      borderColor = '#28A745';
      label = 'Connected';
      break;
    case 'simulator':
      bgColor = '#FFF3CD';
      textColor = '#856404';
      borderColor = '#FFC107';
      label = 'Simulator';
      break;
    default:
      bgColor = '#FBFCFD';
      textColor = '#5A666E';
      borderColor = '#D3DBE1';
      label = 'Disconnected';
      break;
  }

  return (
    <Box
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: bgColor,
        color: textColor,
        border: `2px solid ${borderColor}`,
        borderRadius: '16px',
        px: .5,
        py: .8,
        fontSize: '0.7rem',
        fontWeight: 600,
        minWidth: '80px',
        textAlign: 'center',
      }}
    >
      <Typography variant="body2" sx={{ fontSize: '0.7rem', fontWeight: 600 }}>
        {label}
      </Typography>
    </Box>
  );
};

export default WalletBadge;
