import {
  Badge,
  Box,
  ButtonGroup,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Typography,
} from '@mui/material';
import { useCallback, useState, useEffect } from 'react';
import { Button } from './button';
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
import { Close } from '@mui/icons-material';
import WalletBadge from './WalletBadge';

import { Wrench, Sun } from 'lucide-react';

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

  // Theme state: keep dark/light in sync with document root and localStorage
  const [isDark, setIsDark] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('theme');
      if (stored === 'dark') return true;
      if (stored === 'light') return false;
    } catch (e) {
      // ignore
    }
    return document.documentElement.classList.contains('dark');
  });

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
      try {
        localStorage.setItem('theme', 'dark');
      } catch (e) {}
    } else {
      document.documentElement.classList.remove('dark');
      try {
        localStorage.setItem('theme', 'light');
      } catch (e) {}
    }
  }, [isDark]);

  const toggleTheme = useCallback(() => {
    setIsDark((d) => !d);
  }, []);

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
        mt: { xs: 12, sm: 16, md: 18 },
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        width: '100%',
        height: '100%',
        px: { xs: 1.5, sm: 2, md: 4 },
        py: { xs: 3, sm: 4, md: 6 },
        gap: { xs: 2, sm: 3 },
      }}
    >
      <Box
        sx={{
          width: { xs: '90%', sm: '75%', md: '50%' },
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        {/* Simulator Button */}
        <Button
          variant='solid'
          onClick={handleConnectSimulator}
          aria-label='select-simulator'
          fullWidth
        >
          Continue with Simulator
        </Button>
      </Box>
      {/* Divider with OR in the middle */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: { xs: '90%', sm: '75%', md: '45%' },
          my: { xs: 2, sm: 3 },
          gap: 1,
        }}
      >
        <Divider sx={{ flex: 1, borderColor: 'var(--color-canvas-border)' }} />
        <Typography
          variant='body2'
          sx={{
            color: 'var(--color-canvas-text)',
            fontWeight: 500,
            whiteSpace: 'nowrap',
            fontSize: { xs: '0.85rem', sm: '0.95rem' },
          }}
        >
          OR
        </Typography>
        <Divider sx={{ flex: 1, borderColor: 'var(--color-canvas-border)' }} />
      </Box>

      {/* WalletConnect Dialog */}
      <Box
        sx={{
          width: { xs: '90%', sm: '75%', md: '50%' },
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
        minHeight: 'auto',
        position: 'relative',
        padding: '1em',
        marginTop: 'clamp(26px, 10vw, 26px)',
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
        backgroundColor: 'var(--color-canvas-bg)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'row', height: 'auto' }}>
        {/* Header */}
        {/* Fixed Header */}
        <Box
          sx={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            alignItems: { xs: 'stretch', sm: 'center' },
            justifyContent: 'space-between',
            bgcolor: 'var(--color-canvas-bg)',
            color: 'var(--color-primary-text)',
            px: { xs: 1.5, sm: 2, md: 3 },
            py: { xs: 1, sm: 0 },
            minHeight: { xs: 'auto', sm: '4.5em' },
            boxShadow: '0px 4px 12px rgba(0,0,0,0.1)',
            zIndex: 1200,
            gap: { xs: 1, sm: 0 },
          }}
        >
          {/* LEFT: Title */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              minWidth: 'auto',
            }}
          >
            <Typography
              variant='h6'
              fontWeight={600}
              sx={{
                fontSize: { xs: '0.9rem', sm: '1rem', md: '1.25rem' },
                color: 'var(--color-canvas-text)',
                whiteSpace: 'nowrap',
              }}
            >
              Chia Gaming
            </Typography>
          </Box>

          {/* CENTER: Debug Status (hidden on mobile) */}
          <Box sx={{ display: { xs: 'none', md: 'flex' } }}>
            {walletConnectState.getSession() ? (
              <>
                <Box>
                  <ButtonGroup variant='outlined' size='small'>
                    <Button
                      variant='outline'
                      onClick={() => walletConnectState.disconnect()}
                    >
                      Unlink Wallet
                    </Button>
                    <Button
                      variant='outline'
                      onClick={() => {
                        localStorage.clear();
                        window.location.href = '';
                      }}
                    >
                      Reset Storage
                    </Button>
                  </ButtonGroup>
                </Box>
              </>
            ) : null}
          </Box>

          {/* RIGHT: WalletConnect + Balance */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: { xs: 'space-between', sm: 'flex-end' },
              width: { xs: '100%', sm: 'auto' },
              gap: { xs: 1.5, sm: 2, md: 3 },
            }}
          >
            {/* WalletConnect Status */}
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: { xs: 0.5, sm: 1 },
                minWidth: 'auto',
              }}
            >
              <Typography
                fontWeight='semi-bold'
                sx={{
                  fontSize: { xs: '0.7rem', sm: '0.85rem', md: '0.95rem' },
                  color: 'var(--color-canvas-solid)',
                  display: { xs: 'none', sm: 'block' },
                }}
              >
                WalletConnect
              </Typography>
              <Box>
                <WalletBadge
                  sessionConnected={sessionConnected}
                  fakeAddress={fakeAddress}
                />
              </Box>
            </Box>

            {/* BALANCE and Theme Toggle */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              {balance !== undefined && (
                <Typography
                  variant='body2'
                  sx={{
                    color: 'var(--color-canvas-solid)',
                    fontWeight: 500,
                    opacity: 0.8,
                    fontSize: { xs: '0.65rem', sm: '0.85rem', md: '0.95rem' },
                    whiteSpace: 'nowrap',
                  }}
                >
                  Bal: {balance} XCH
                </Typography>
              )}

              <IconButton
                aria-label='toggle-theme'
                onClick={toggleTheme}
                size='small'
                sx={{
                  bgcolor: 'transparent',
                  borderColor: 'var(--color-canvas-border)',
                  border: '1px solid var(--color-canvas-border)',
                  color: isDark
                    ? 'var(--color-warning-solid)'
                    : 'var(--color-canvas-text)',
                  '&:hover': { bgcolor: 'var(--color-canvas-bg-hover)' },
                }}
              >
                <Sun size={16} />
              </IconButton>
            </Box>
          </Box>
        </Box>
      </div>

      {ifExpanded}
      <IconButton
        aria-label='debug'
        onClick={() => setDebugOpen(true)}
        sx={{
          color: 'var(--color-canvas-text)',
          position: 'fixed',
          bottom: 24,
          right: 24,
          bgcolor: 'var(--color-canvas-bg)',
          border: '1px solid var(--color-canvas-border)',
          borderRadius: '20px', // right rounded
          boxShadow: '0px 4px 12px rgba(0,0,0,0.2)',
          py: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.25s ease',
          '&:hover': {
            bgcolor: 'var(--color-primary-solid-hover)',
            color: 'var(--color-primary-on-primary)',
            transform: 'translateY(-2px)',
            boxShadow: '0px 6px 16px rgba(0,0,0,0.25)',
          },
        }}
      >
        <Wrench size={'20px'} />
      </IconButton>

      {/* Debug Modal */}
      <Dialog
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
        fullWidth
        maxWidth='sm'
        sx={{
          '& .MuiPaper-root': {
            backgroundColor: 'var(--canvas-bg)',
            color: 'var(--canvas-text)',
          },
        }}
      >
        <DialogTitle
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontWeight: 600,
            color: 'var(--canvas-text)',
          }}
        >
          Developer Debug
          <IconButton
            aria-label='close'
            onClick={() => setDebugOpen(false)}
            sx={{
              color: 'var(--canvas-text)',
              '&:hover': {
                color: 'var(--secondary-solid)',
              },
            }}
          >
            <Close />
          </IconButton>
        </DialogTitle>

        <DialogContent
          dividers
          sx={{
            borderColor: 'var(--canvas-bg-subtle)', // divider color
            backgroundColor: 'var(--canvas-bg)',
            color: 'var(--canvas-text)',
          }}
        >
          <Debug connectString={wcInfo} setConnectString={setWcInfo} />
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default WalletConnectHeading;
