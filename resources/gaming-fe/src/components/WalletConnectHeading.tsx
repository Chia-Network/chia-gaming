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

export interface WalletConnectHeadingParams {appReceivedGameNavigate: boolean};

const WalletConnectHeading: React.FC<WalletConnectHeadingParams> = ({appReceivedGameNavigate}) => {
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
  const [waitingApproval, setWaitingApproval] = useState(false);
  const [connected, setConnected] = useState(false);
  const [haveClient, setHaveClient] = useState(false);
  const [haveSession, setHaveSession] = useState(false);
  const [sessions, setSessions] = useState(0);
  const [_address, setAddress] = useState();
  const [balance, setBalance] = useState<number | undefined>();
  const [haveBlock, setHaveBlock] = useState(false);
  const [blockNumber, setBlockNumber] = useState(0);
  const [receivedGameNavigate, setReceivedGameNavigate] = useState(false);
  const [lastPeakNotification, setLastPeakNotification] = useState<any | undefined>();
  const uniqueId = generateOrRetrieveUniqueId();

  function notifyBlockchainInfo(evt_type: string, evt: any) {
      const subframe = document.getElementById('subframe');
      let new_event: any = { };
      new_event[evt_type] = evt;
      if (subframe) {
        (subframe as any).contentWindow.postMessage(
          new_event,
          '*',
        );
      } else {
        throw new Error('attempted blockchain reply to peer, but no subframe exists');
      }
  }

  if (!receivedGameNavigate && appReceivedGameNavigate) {
    setReceivedGameNavigate(true);
    notifyBlockchainInfo("blockchain_info", lastPeakNotification);
  }

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
          notifyBlockchainInfo('walletBalance', { balance: evt.getBalance });
          setTimeout(requestBalance, 2000);
        }
        notifyBlockchainInfo("blockchain_reply", evt);
      },
    });

    const biSubscription = blockchainDataEmitter.getObservable().subscribe({
      next: (evt: any) => {
        if (!haveBlock) {
          setHaveBlock(true);
          requestBalance();
        }
        if (evt.peak) {
          setLastPeakNotification(evt);
          setBlockNumber(parseInt(evt.peak.toString()));
        }
        notifyBlockchainInfo("blockchain_info", evt);
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

  const ifExpanded = expanded ?
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
    </div> : <div style={{ display: 'none' }} />;

  const balanceDisplay =
    balance !== undefined ? <div>- Balance {balance}</div> : <div />;

  return (
    <div
      className='flex flex-col w-screen'
      style={{ height: useHeight, backgroundColor: 'var(--color-canvas-bg)' }}
    >
      <div className='flex flex-row h-auto'>
        {/* Header */}
        {/* Fixed Header */}
        <div
          className='fixed top-0 left-0 w-full flex gap-1 shadow-md z-1200'
          style={{
            flexDirection: window.innerWidth < 640 ? 'column' : 'row',
            alignItems: window.innerWidth < 640 ? 'stretch' : 'center',
            justifyContent: 'space-between',
            paddingLeft:
              window.innerWidth < 768
                ? '0.375rem'
                : window.innerWidth < 1024
                  ? '0.5rem'
                  : '0.75rem',
            paddingRight:
              window.innerWidth < 768
                ? '0.375rem'
                : window.innerWidth < 1024
                  ? '0.5rem'
                  : '0.75rem',
            paddingTop: window.innerWidth < 640 ? '0.25rem' : 0,
            minHeight: window.innerWidth < 640 ? 'auto' : '4.5em',
            backgroundColor: 'var(--color-canvas-bg)',
            color: 'var(--color-primary-text)',
          }}
        >
          {/* LEFT: Title */}
          <div className='flex items-center gap-1 min-w-auto'>
            <span
              className='font-semibold whitespace-nowrap'
              style={{
                fontSize:
                  window.innerWidth < 640
                    ? '0.9rem'
                    : window.innerWidth < 768
                      ? '1rem'
                      : '1.25rem',
                color: 'var(--color-canvas-text)',
              }}
            >
              Chia Gaming
            </span>
          </div>

          {/* CENTER: Debug Status (hidden on mobile) */}
          <div className='hidden md:flex'>
            {walletConnectState.getSession() && (
              <div className='flex gap-2'>
                <button
                  className='border border-gray-300 px-2 py-1 rounded hover:bg-gray-100'
                  onClick={() => walletConnectState.disconnect()}
                >
                  Unlink Wallet
                </button>
                <button
                  className='border border-gray-300 px-2 py-1 rounded hover:bg-gray-100'
                  onClick={() => {
                    localStorage.clear();
                    window.location.href = '';
                  }}
                >
                  Reset Storage
                </button>
              </div>
            )}
          </div>

          {/* RIGHT: Block + WalletConnect + Balance */}
          <div
            className={`flex items-center gap-1.5 sm:gap-2 md:gap-3 ${
              window.innerWidth < 640
                ? 'justify-between w-full'
                : 'justify-end w-auto'
            }`}
          >
            {/* Alert User to check their Wallet*/}
            <div className='flex items-center gap-1 min-w-auto'>
              <span
                className='font-medium opacity-80 whitespace-nowrap'
                style={{
                  fontSize:
                    window.innerWidth < 640
                      ? '0.7rem'
                      : window.innerWidth < 768
                        ? '0.85rem'
                        : '0.95rem',
                  color: 'red',
                }}
              >
              {waitingApproval && "Please check wallet!"}
              </span>
            </div>

            {/* Block Number */}
            <div className='flex items-center gap-1 min-w-auto'>
              <span
                className='font-medium opacity-80 whitespace-nowrap'
                style={{
                  fontSize:
                    window.innerWidth < 640
                      ? '0.7rem'
                      : window.innerWidth < 768
                        ? '0.85rem'
                        : '0.95rem',
                  color: 'var(--color-canvas-solid)',
                }}
              >Block {blockNumber}
              </span>
            </div>
            {/* WalletConnect Status */}
            <div className='flex items-center gap-1 min-w-auto'>
              <span
                className='font-semibold hidden sm:block'
                style={{
                  fontSize:
                    window.innerWidth < 640
                      ? '0.7rem'
                      : window.innerWidth < 768
                        ? '0.85rem'
                        : '0.95rem',
                  color: 'var(--color-canvas-solid)',
                }}
              >
                WalletConnect
              </span>
              <div>
                <WalletBadge
                  sessionConnected={sessionConnected}
                  fakeAddress={fakeAddress}
                />
              </div>
            </div>

            {/* BALANCE and Theme Toggle */}
            <div className='flex items-center gap-1'>
              {balance !== undefined && (
                <span
                  className='font-medium opacity-80 whitespace-nowrap'
                  style={{
                    fontSize:
                      window.innerWidth < 640
                        ? '0.65rem'
                        : window.innerWidth < 768
                          ? '0.85rem'
                          : '0.95rem',
                    color: 'var(--color-canvas-solid)',
                  }}
                >
                  Bal: {balance} XCH
                </span>
              )}

              <button
                onClick={toggleTheme}
                className={`p-1 border border-(--color-canvas-border) rounded ${
                  isDark
                    ? 'text-warning-solid'
                    : 'text-canvas-text'
                } hover:bg-canvas-bg-hover`}
              >
                <Sun size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {ifExpanded}

      {/* Debug IconButton */}
      <button
        onClick={() => setDebugOpen(true)}
        className='fixed bottom-6 right-6 flex items-center justify-center p-1.5 rounded-full border border-canvas-border shadow-md'
        style={{
          backgroundColor: 'var(--color-canvas-bg)',
          color: 'var(--color-canvas-text)',
          borderRadius: '20px',
          transition: 'all 0.25s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor =
            'var(--color-primary-solid-hover)';
          e.currentTarget.style.color = 'var(--color-primary-on-primary)';
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.boxShadow = '0px 6px 16px rgba(0,0,0,0.25)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'var(--color-canvas-bg)';
          e.currentTarget.style.color = 'var(--color-canvas-text)';
          e.currentTarget.style.transform = 'translateY(0)';
          e.currentTarget.style.boxShadow = '0px 4px 12px rgba(0,0,0,0.2)';
        }}
      >
        <Wrench size={'20px'} />
      </button>

      {/* Debug Modal */}
      {debugOpen && (
        <div className='fixed inset-0 flex items-center justify-center z-1300'>
          <div className='bg-canvas-bg-active text-canvas-text w-full max-w-sm rounded shadow-lg'>
            <div className='flex items-center justify-between p-4 font-semibold'>
              Developer Debug
              <button
                onClick={() => setDebugOpen(false)}
                className='text-canvas-text hover:text-secondary-solid'
              >
                <Close />
              </button>
            </div>
            <div
              className='p-4 border-t border-canvas-bg-subtle'
              style={{
                backgroundColor: 'var(--canvas-bg)',
                color: 'var(--canvas-text)',
              }}
            >
              <Debug connectString={wcInfo} setConnectString={setWcInfo} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WalletConnectHeading;
