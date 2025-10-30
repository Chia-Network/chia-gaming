import { Button, Link, SxProps, Typography } from '@mui/material';
import { alignSelf, border, borderRadius, Box, display } from '@mui/system';
import {
  StartConnectResult,
  walletConnectState,
} from '../hooks/useWalletConnect';
import { QRCodeModal } from './QRCodeModal';
import { InfoRounded } from '@mui/icons-material';

const styles: Record<string, SxProps> = {
  container: {
    px: { xs: 2, sm: 3 },
    maxWidth: { xs: '100%', sm: '400px', md: '480px', lg: '100%' },
    margin: '0 auto',
  },
  welcome: {
    display: 'flex',
    flexDirection: 'column',
    gap: { xs: '8px', sm: '12px' },
  },
  buttonGroup: {
    display: 'flex',
    flexDirection: { xs: 'column', sm: 'row' },
    justifyContent: 'space-between',
    gap: { xs: 2, sm: 2 },
    mt: 4,
  },
};

interface ShowWalletConnectState {
  initialized: boolean;
  haveClient: boolean;
  haveSession: boolean;
  sessions: number;
  showQRModal: boolean;
  connectionUri: string | undefined;
  onConnect: () => void;
  dismiss: () => void;
}

export const WalletConnectDialog: React.FC<ShowWalletConnectState> = ({
  initialized,
  haveClient,
  haveSession,
  sessions,
  showQRModal,
  connectionUri,
  onConnect,
  dismiss,
}) => {
  return (
    <Box sx={styles.container}>
      <QRCodeModal open={showQRModal} uri={connectionUri} onClose={dismiss} />

      {!initialized ? (
        <Box sx={styles.welcome}>
          <Typography variant='h5' fontSize={{ xs: '1.2rem', sm: '1.5rem' }}>
            Initializing WalletConnect...
          </Typography>
          <Typography variant='body1' mt={2}>
            Please wait while we set up the connection.
          </Typography>
        </Box>
      ) : !haveClient ? (
        <Box sx={styles.welcome}>
          <Typography
            variant='h5'
            color='error'
            fontSize={{ xs: '1.2rem', sm: '1.5rem' }}
          >
            WalletConnect Failed to Initialize
          </Typography>
          <Typography variant='body1' mt={2}>
            Please check your environment configuration and try refreshing the
            page.
          </Typography>
          <Typography
            variant='body2'
            mt={1}
            color='text.secondary'
            fontSize={{ xs: '0.85rem', sm: '0.95rem' }}
          >
            Make sure you have a .env file with VITE_PROJECT_ID, VITE_RELAY_URL,
            and VITE_CHAIN_ID.
          </Typography>
        </Box>
      ) : !haveSession ? (
        <Box sx={styles.welcome}>
          <Box sx={styles.buttonGroup}>
            <Button
              fullWidth
              variant='contained'
              onClick={onConnect}
              sx={{
                backgroundColor: '#424F6D',
                color: '#fff',
                fontWeight: 600,
                letterSpacing: '0.5px',
                textTransform: 'uppercase',
                borderRadius: '6px',
                py: 1.2,
                boxShadow: '0px 4px 8px rgba(66, 79, 109, 0.85)',
                '&:hover': {
                  backgroundColor: '#3A4663',
                  boxShadow: '0px 6px 12px rgba(66, 79, 109, 0.35)',
                },
              }}
            >
              Link Wallet
            </Button>

            <Button
              fullWidth
              variant='outlined'
              color='error'
              sx={{
                py: 1.2,
                fontWeight: 600,
                boxShadow: '0px 4px 8px rgba(66, 79, 109, 0.85)',
              }}
              onClick={() => {
                localStorage.clear();
                window.location.href = '';
              }}
            >
              Reset Storage
            </Button>
          </Box>
          {/* <Typography
            variant='h5'
            fontSize={{ xs: '1.25rem', sm: '1.5rem' }}
            textAlign='start'
          >
            WalletConnect Example
          </Typography> */}
          <Box
            sx={{
              backgroundColor: 'rgba(66, 81, 196, 0.2)',
              borderRadius: 2,
              p: 3,
              display: 'flex',
              gap: 2,
              mt: 3,
              color: '#1A1A1A',
            }}
          >
            <Box
              style={{
                padding: '4px',
                backgroundColor: 'rgba(66, 81, 196, 0.4)',
                display: 'flex',
                borderRadius: '30%',
                alignSelf: 'baseline',
              }}
            >
              <InfoRounded sx={{ color: '#424F6D' }} />
            </Box>
            <Box>
              <Typography variant='body1' mt={2}>
                Before you can test out WalletConnect, you need to link your
                Chia wallet. Download the latest wallet from the{' '}
                <Link
                  href='https://www.chia.net/downloads'
                  target='_blank'
                  rel='noopener'
                >
                  official download page
                </Link>
                .
              </Typography>

              <Typography variant='body1' mt={2}>
                Once the wallet is synced, use the WalletConnect menu on the top
                right to link it to this site. Then click the button below to
                begin.
              </Typography>
              {!haveSession && haveClient && (
                <Typography
                  variant='body2'
                  sx={{
                    mt: 1,
                    fontSize: { xs: '0.9rem' },
                  }}
                >
                  Ready to connect. Click "Link Wallet" to start.
                </Typography>
              )}
            </Box>
          </Box>
          {haveClient && (
            <Typography
              variant='body2'
              sx={{
                mt: 1,
                color: '#666666',
                fontSize: { xs: '0.85rem' },
              }}
            >
              Client Status: {haveClient ? 'Ready' : 'Not Ready'} | Sessions:{' '}
              {sessions} | Connected: {haveSession ? 'Yes' : 'No'}
            </Typography>
          )}
        </Box>
      ) : (
        <div />
      )}
    </Box>
  );
};

export const doConnectWallet = (
  setShowQRModal: (s: boolean) => void,
  setConnectionUri: (s: string) => void,
  _startConnect: () => Promise<StartConnectResult>,
  setComplete: () => void,
  signalError: (s: string) => void,
) => {
  setShowQRModal(true);
  walletConnectState
    .startConnect()
    .then((result) => {
      setConnectionUri(result.uri);
      return walletConnectState.connect(result.approval);
    })
    .then(() => {
      setShowQRModal(false);
      setComplete();
    })
    .catch((e) => signalError(e.toString()));
};
