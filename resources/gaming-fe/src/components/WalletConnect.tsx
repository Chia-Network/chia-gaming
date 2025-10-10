import {
  Button,
  ButtonGroup,
  Divider,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Select,
  SxProps,
  Typography,
} from '@mui/material';
import { Box } from '@mui/system';
import { cloneElement, useState } from 'react';
import { QRCodeModal } from './QRCodeModal';
import { StartConnectResult, walletConnectState } from '../hooks/useWalletConnect';

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
          <Typography variant="h5">Initializing WalletConnect...</Typography>
          <Typography variant="body1" mt={2}>
            Please wait while we set up the connection.
          </Typography>
        </Box>
      ) : !haveClient ? (
        <Box sx={styles.welcome}>
          <Typography variant="h5" color="error">
            WalletConnect Failed to Initialize
          </Typography>
          <Typography variant="body1" mt={2}>
            Please check your environment configuration and try refreshing the page.
          </Typography>
          <Typography variant="body2" mt={1} color="text.secondary">
            Make sure you have a .env file with VITE_PROJECT_ID, VITE_RELAY_URL, and VITE_CHAIN_ID.
          </Typography>
        </Box>
      ) : !haveSession ? (
        <Box sx={styles.welcome}>
          <Typography variant="h5">WalletConnect Example</Typography>

          <Typography variant="body1" mt={2}>
            Before you can test out the WalletConnect commands, you will need to link the Chia wallet to this site. You
            can download the latest version of the wallet on the{' '}
            <Link href="https://www.chia.net/downloads">official download page</Link>.
          </Typography>

          <Typography variant="body1" mt={2}>
            Once you have downloaded and started the wallet, make sure it has completed syncing before connecting it.
            The WalletConnect menu can be found on the top right corner of the wallet. Click the button below to begin
            the connection.
          </Typography>

          {haveClient && (
            <Typography variant="body2" sx={{ mt: 1, color: 'text.secondary' }}>
              Client Status: {haveClient ? 'Ready' : 'Not Ready'} | Sessions: {sessions} | Connected:{' '}
              {haveSession ? 'Yes' : 'No'}
            </Typography>
          )}

          {!haveSession && haveClient && (
            <Typography variant="body2" sx={{ mt: 1, color: 'warning.main' }}>
              ⚠️ Ready to connect. Click "Link Wallet" to start.
            </Typography>
          )}

          <Button fullWidth variant="contained" onClick={onConnect} sx={{ mt: 3 }}>
            Link Wallet
          </Button>

          <Button
            fullWidth
            variant="outlined"
            color="error"
            onClick={() => {
              localStorage.clear();
              window.location.href = '';
            }}
          >
            Reset Storage
          </Button>
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
  startConnect: () => Promise<StartConnectResult>,
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

const styles: Record<string, SxProps> = {
  welcome: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  container: {
    paddingTop: '60px',
    width: { xs: '340px', md: '460px', lg: '540px' },
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  command: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    borderRadius: '8px',
  },
  response: {
    borderRadius: '8px',
  },
};
