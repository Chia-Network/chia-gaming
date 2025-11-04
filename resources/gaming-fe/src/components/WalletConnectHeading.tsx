import {
  Badge,
  Box,
  Button,
  ButtonGroup,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  Fab,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useState, useEffect } from 'react';

import { blockchainConnector } from '../hooks/BlockchainConnector';
import { blockchainDataEmitter } from '../hooks/BlockchainInfo';
import { FAKE_BLOCKCHAIN_ID } from '../hooks/FakeBlockchainInterface';
import {
  REAL_BLOCKCHAIN_ID,
  connectRealBlockchain,
} from '../hooks/RealBlockchainInterface';
import useDebug from '../hooks/useDebug';
import { walletConnectState } from '../hooks/useWalletConnect';
import { BLOCKCHAIN_SERVICE_URL } from '../settings';
import { generateOrRetrieveUniqueId } from '../util';

import Debug from './Debug';
import { WalletConnectDialog, doConnectWallet } from './WalletConnect';
import {
  BugReportOutlined,
  Close,
  ContentCopy,
  LocalActivity,
} from '@mui/icons-material';
import WalletBadge from './WalletBadge';
import WalletStatus from './WalletStatus';

const WalletConnectHeading = (_args: any) => {
  const { wcInfo, setWcInfo } = useDebug();
  const [_alreadyConnected, setAlreadyConnected] = useState(false);
  const [_walletConnectError, setWalletConnectError] = useState<
    string | undefined
  >();
  const [fakeAddress, setFakeAddress] = useState<string | undefined>();
  const [expanded, setExpanded] = useState(true);
  const [showQRModal, setShowQRModal] = useState(false);
  const [connectionUri, setConnectionUri] = useState<string | undefined>();
  const [debugOpen, setDebugOpen] = useState(false);

  // Wallet connect state.
  const [_stateName, setStateName] = useState('empty');
  const [initializing, setInitializing] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [_connecting, setConnecting] = useState(false);
  const [_waitingApproval, setWaitingApproval] = useState(false);
  const [connected, setConnected] = useState(false);
  const [haveClient, setHaveClient] = useState(false);
  const [haveSession, setHaveSession] = useState(false);
  const [sessions, setSessions] = useState(0);
  const [_address, setAddress] = useState();
  const [balance, setBalance] = useState<number | undefined>();
  const [haveBlock, setHaveBlock] = useState(false);

  const uniqueId = generateOrRetrieveUniqueId();

  const walletConnectStates: any = {
    stateName: setStateName,
    initializing: setInitializing,
    initialized: setInitialized,
    connecting: setConnecting,
    waitingApproval: setWaitingApproval,
    connected: setConnected,
    haveClient: setHaveClient,
    haveSession: setHaveSession,
    sessions: setSessions,
    address: setAddress,
  };

  function requestBalance() {
    blockchainConnector.getOutbound().next({
      requestId: -1,
      getBalance: true,
    });
  }

  useEffect(() => {
    const subscription = walletConnectState.getObservable().subscribe({
      next: (evt: any) => {
        if (evt.stateName === 'connected') {
          toggleExpanded();
          setAlreadyConnected(true);
          console.log('doing connect real blockchain');
          blockchainDataEmitter.select({
            selection: REAL_BLOCKCHAIN_ID,
            uniqueId,
          });
          connectRealBlockchain('https://api.coinset.org');
          requestBalance();
        }

        const keys = Object.keys(evt);
        keys.forEach((k: string) => {
          if (walletConnectStates[k]) {
            walletConnectStates[k](evt[k]);
          }
        });
      },
    });

    return () => subscription.unsubscribe();
  }, []);

  const toggleExpanded = useCallback(() => {
    setExpanded(!expanded);
  }, [expanded]);

  useEffect(() => {
    if (!initializing) {
      console.log(
        'initialzing wallet connect if needed',
        initializing,
        initialized,
      );
      walletConnectState.init();
      setInitializing(true);
    }
  });

  useEffect(() => {
    function receivedWindowMessage(evt: any) {
      const key = evt.message ? 'message' : 'data';
      // Not decoded, despite how it's displayed in console.log.
      const data = evt[key];
      if (data.blockchain_request) {
        if (evt.origin !== window.location.origin) {
          throw new Error(
            `wrong origin for parent event: ${JSON.stringify(evt)}`,
          );
        }
        // Ensure that requests from the child frame go to our request channel.
        blockchainConnector.getOutbound().next(data.blockchain_request);
      }
    }

    window.addEventListener('message', receivedWindowMessage);

    // Ensure that replies go to the child frame.
    const bcSubscription = blockchainConnector.getInbound().subscribe({
      next: (evt: any) => {
        if (evt.getBalance) {
          setBalance(evt.getBalance);
          setTimeout(requestBalance, 2000);
        }

        const subframe = document.getElementById('subframe');
        if (subframe) {
          (subframe as any).contentWindow.postMessage(
            {
              blockchain_reply: evt,
            },
            window.location.origin,
          );
        } else {
          throw new Error('blockchain reply to no subframe');
        }
      },
    });

    const biSubscription = blockchainDataEmitter.getObservable().subscribe({
      next: (evt: any) => {
        if (!haveBlock) {
          setHaveBlock(true);
          requestBalance();
        }
        const subframe = document.getElementById('subframe');
        if (subframe) {
          (subframe as any).contentWindow.postMessage(
            {
              blockchain_info: evt,
            },
            '*',
          );
        } else {
          throw new Error('blockchain reply to no subframe');
        }
      },
    });

    return function () {
      window.removeEventListener('message', receivedWindowMessage);
      bcSubscription.unsubscribe();
      biSubscription.unsubscribe();
    };
  }, [haveBlock]);

  const useHeight = expanded ? '3em' : '50em';
  const handleConnectSimulator = useCallback(() => {
    const baseUrl = BLOCKCHAIN_SERVICE_URL;

    fetch(`${baseUrl}/register?name=${uniqueId}`, {
      method: 'POST',
    })
      .then((res) => {
        return res.json();
      })
      .then((res) => {
        // Trigger fake connect if not connected.
        console.warn('fake address is', res);
        setFakeAddress(res);
        toggleExpanded();
        blockchainDataEmitter.select({
          selection: FAKE_BLOCKCHAIN_ID,
          uniqueId,
        });
        requestBalance();
      });
  }, []);

  const onDoWalletConnect = useCallback(() => {
    doConnectWallet(
      setShowQRModal,
      setConnectionUri,
      () => walletConnectState.startConnect(),
      () => {
        console.warn('walletconnect should now be connected');
      },
      (e) => setWalletConnectError(e),
    );
  }, []);

  const onWalletDismiss = useCallback(() => {
    toggleExpanded();
  }, []);

  const sessionConnected = connected
    ? 'connected'
    : fakeAddress
      ? 'simulator'
      : 'disconnected';

  const ifSession = (
    <Box
      sx={{
        mt: 16,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        width: '100%',
        height: '100%',
        px: 2,
        py: 4,
      }}
    >
      {/* Simulator Button */}
      <Button
        variant='contained'
        onClick={handleConnectSimulator}
        aria-label='select-simulator'
        sx={{
          width: { xs: '80%', sm: '60%', md: '50%' },
          mb: 3,
          backgroundColor: '#E5FE75',
          boxShadow: '0px 4px 8px rgba(66, 79, 109, 0.85)',
          color: '#424F6D',
          fontWeight: 600,
          '&:hover': {
            backgroundColor: '#bb3',
          },
        }}
      >
        CONTINUE WITH SIMULATOR
      </Button>

      {/* Divider with OR in the middle */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: { xs: '85%', sm: '65%', md: '45%' },
          my: 3,
        }}
      >
        <Divider sx={{ flex: 1, borderColor: 'rgba(0,0,0,0.2)' }} />
        <Typography
          variant='body2'
          sx={{
            mx: 2,
            color: '#666',
            fontWeight: 500,
            whiteSpace: 'nowrap',
          }}
        >
          OR
        </Typography>
        <Divider sx={{ flex: 1, borderColor: 'rgba(0,0,0,0.2)' }} />
      </Box>

      {/* WalletConnect Dialog */}
      <Box
        sx={{
          width: { xs: '90%', sm: '70%', md: '50%' },
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <WalletConnectDialog
          initialized={initialized}
          haveClient={haveClient}
          haveSession={haveSession}
          sessions={sessions}
          showQRModal={showQRModal}
          connectionUri={connectionUri}
          onConnect={onDoWalletConnect}
          dismiss={onWalletDismiss}
        />
      </Box>
    </Box>
  );

  const ifExpanded = expanded && (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '17em',
        position: 'relative',
        background: 'white',
        padding: '1em',
        marginTop: '10em',
        gap: '1em',
      }}
    >
      {ifSession}
    </div>
  );

  const balanceDisplay =
    balance !== undefined ? <div>- Balance {balance}</div> : <div />;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: useHeight,
        width: '100vw',
        backgroundColor: 'white',
        // zIndex: 1000,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'row', height: '3em' }}>
        {/* Header */}
        {/* Fixed Header */}
        <Box
          sx={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            bgcolor: 'white',
            color: '#424F6D',
            px: { xs: 2, sm: 3 },
            height: '4.5em',
            boxShadow: '0px 4px 12px rgba(0,0,0,0.1)',
            zIndex: 1200,
          }}
        >
          {/* LEFT: Title */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            {/* <img src='../assets/images/chia_logo.png' alt='logo' height={32} /> */}
            <Typography
              variant='h6'
              fontWeight={600}
              sx={{
                whiteSpace: 'nowrap',
                fontSize: { xs: '1rem', sm: '1.25rem' },
                color: '#555555',
              }}
            >
              Chia Gaming
            </Typography>
          </Box>
          <Box>
            {walletConnectState.getSession() ? (
              <>
                <Box>
                  <ButtonGroup variant='outlined' fullWidth>
                    <Button
                      variant='outlined'
                      color='error'
                      onClick={() => walletConnectState.disconnect()}
                    >
                      Unlink Wallet
                    </Button>
                    <Button
                      variant='outlined'
                      color='error'
                      onClick={() => {
                        localStorage.clear();
                        window.location.href = '';
                      }}
                    >
                      Reset Storage
                    </Button>
                  </ButtonGroup>
                </Box>
                <Divider sx={{ mt: 4 }} />
                <Box mt={3}>
                  <Typography variant='h5'>Response</Typography>
                  <Button
                    fullWidth
                    variant='outlined'
                    color='error'
                    onClick={() => {
                      localStorage.clear();
                      window.location.href = '';
                    }}
                  >
                    Unlink Wallet
                  </Button>
                </Box>
              </>
            ) : fakeAddress ? (
              <></>
            ) : (
              <WalletStatus />
            )}
          </Box>
          {/* RIGHT: WalletConnect + Balance + Burger */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: { xs: 4.5, sm: 3, md: 2 },
            }}
          >
            {/* WalletConnect Status */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography
                fontWeight={'semi-bold'}
                sx={{
                  fontSize: { xs: '0.85rem', sm: '0.95rem', color: '#555555' },
                }}
              >
                WalletConnect
              </Typography>
              <Box>
                <WalletBadge sessionConnected={sessionConnected} />
              </Box>
              <Box>
                {fakeAddress && (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Typography
                      sx={{
                        fontSize: { xs: '0.85rem', sm: '0.9rem' },
                        color: '#424F6D',
                        fontWeight: 500,
                      }}
                    >
                      {`${fakeAddress.slice(0, 3)}...${fakeAddress.slice(-3)}`}
                    </Typography>

                    <Tooltip title='Copy address'>
                      <IconButton
                        size='small'
                        onClick={() =>
                          navigator.clipboard.writeText(fakeAddress)
                        }
                        sx={{
                          color: '#555555',
                          '&:hover': { color: '#000000' },
                        }}
                      >
                        <ContentCopy sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                )}
              </Box>
            </Box>

            {/* BALANCE */}
            {balance !== undefined && (
              <Typography
                variant='body2'
                sx={{
                  color: '#424F6D',
                  fontWeight: 500,
                  opacity: 0.8,
                  fontSize: { xs: '0.85rem', sm: '0.95rem' },
                  whiteSpace: 'nowrap',
                }}
              >
                Balance: {balance} XCH
              </Typography>
            )}

            {/* BURGER BUTTON */}
            {/* <Button
              onClick={toggleExpanded}
              aria-label='menu-toggle'
              sx={{
                minWidth: 'auto',
                color: '#424F6D',
                fontSize: 26,
                fontWeight: 'bold',
                lineHeight: 1,
                px: 1,
                '&:hover': {
                  bgcolor: 'rgba(66,79,109,0.08)',
                },
              }}
            >
              ☰
            </Button> */}
          </Box>
        </Box>
      </div>

      {ifExpanded}
      <IconButton
        aria-label='debug'
        onClick={() => setDebugOpen(true)}
        sx={{
          color: '#000',
          position: 'fixed',
          bottom: 24,
          right: 24,
          bgcolor: 'white',
          border: '1px solid #ccc',
          borderRadius: '0 12px 12px 0', // right rounded
          boxShadow: '0px 4px 12px rgba(0,0,0,0.2)',
          px: 1.5,
          py: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.25s ease',
          '&:hover': {
            bgcolor: '#7A8398',
            color: 'white',
            transform: 'translateY(-2px)',
            boxShadow: '0px 6px 16px rgba(0,0,0,0.25)',
          },
        }}
      >
        <BugReportOutlined sx={{ fontSize: 22 }} />
      </IconButton>

      {/* Debug Modal */}
      <Dialog
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
        fullWidth
        maxWidth='sm'
      >
        <DialogTitle
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontWeight: 600,
            color: '#424F6D',
          }}
        >
          Developer Debug
          <IconButton
            aria-label='close'
            onClick={() => setDebugOpen(false)}
            sx={{ color: '#424F6D' }}
          >
            <Close />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Debug connectString={wcInfo} setConnectString={setWcInfo} />
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default WalletConnectHeading;
