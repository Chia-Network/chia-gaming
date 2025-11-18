import { Box, Typography, Tooltip, IconButton } from '@mui/material';
import { ContentCopy } from '@mui/icons-material';

interface WalletBadgeProps {
  sessionConnected: 'connected' | 'simulator' | 'disconnected';
  fakeAddress?: string;
}

const WalletBadge = ({ sessionConnected, fakeAddress }: WalletBadgeProps) => {
  let bgColor = '';
  let textColor = '';
  let borderColor = '';
  let label = '';

  switch (sessionConnected) {
    case 'connected':
      bgColor = 'var(--color-success-bg)';
      textColor = 'var(--color-success-text)';
      borderColor = 'var(--color-success-border)';
      label = 'Connected';
      break;
    case 'simulator':
      bgColor = 'var(--color-warning-bg)';
      textColor = 'var(--color-warning-text)';
      borderColor = 'var(--color-warning-border)';
      label = 'Simulator';
      break;
    default:
      bgColor = 'var(--color-canvas-bg)';
      textColor = 'var(--color-canvas-text)';
      borderColor = 'var(--color-canvas-border)';
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
        border: `1px solid ${borderColor}`,
        borderRadius: '28px',
        px: 0.8,
        py: 0.4,
        fontSize: '0.7rem',
        fontWeight: 600,
        minWidth: '36px',
        textAlign: 'center',
      }}
    >
      <Typography variant='body2' sx={{ fontSize: '0.7rem', fontWeight: 600,ml: 0.2 }}>
        {label}
      </Typography>
      {fakeAddress && (
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <Typography sx={{ fontSize: '0.75rem', color: '#856404', ml: 0.2 }}>
            {`${fakeAddress.slice(0, 3)}...${fakeAddress.slice(-3)}`}
          </Typography>
          <Tooltip title='Copy address' color='#856404'>
            <IconButton
              size='small'
              onClick={() => navigator.clipboard.writeText(fakeAddress)}
              sx={{ color: '#856404', ml: 0.5 }}
            >
              <ContentCopy sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>
      )}
    </Box>
  );
};

export default WalletBadge;
