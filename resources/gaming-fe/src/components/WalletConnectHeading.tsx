
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
import WalletBadge from './WalletBadge';

import { Wrench, Sun, Cross } from 'lucide-react';

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
  const [recvAddress, setRecvAddress] = useState();
  const [synced, setSynced] = useState(false);
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
      } catch (e) { }
    } else {
      document.documentElement.classList.remove('dark');
      try {
        localStorage.setItem('theme', 'light');
      } catch (e) { }
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
    address: setRecvAddress,
    synced: setSynced,
  };

  function requestSyncStatus() {
    blockchainConnector.getOutbound().next({
      requestId: -3,
      getSyncStatus: true,
    });
  }

  function requestBalance() {
    blockchainConnector.getOutbound().next({
      requestId: -2,
      getBalance: true,
    });
  }

  function requestRecvAddress() {
    blockchainConnector.getOutbound().next({
      requestId: -1,
      getAddress: true,
    });
  }

  useEffect(() => {
    const subscription = walletConnectState.getObservable().subscribe({
      next: (evt: any) => {
        if (evt.stateName === 'connected') {
          requestSyncStatus();
          toggleExpanded();
          setAlreadyConnected(true);
          console.log('doing connect real blockchain');
          blockchainDataEmitter.select({
            selection: REAL_BLOCKCHAIN_ID,
            uniqueId,
          });
          connectRealBlockchain('https://api.coinset.org');
          requestBalance();
          requestRecvAddress();
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
        // On any response, check the sync status
        if (evt.getSyncStatus !== undefined) {
          setSynced(!!evt.getSyncStatus);
          // Keep polling while connected so the UI can flip to "Connected" once synced.
          if (connected) {
            setTimeout(requestSyncStatus, 5000);
          }
        }
        if (evt.getBalance) {
          setBalance(evt.getBalance);
          setTimeout(requestBalance, 2000);
        }
        if (evt.getAddress) {
          setRecvAddress(evt.getRecvAddress);
          setTimeout(requestRecvAddress, 2000);
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
          // TODO: Two cases:
          // 1. we don't have the subframe until we get the first block
          // 2. Do throw in other cases
          // throw new Error('blockchain reply to no subframe');
        }
      },
    });

    const biSubscription = blockchainDataEmitter.getObservable().subscribe({
      next: (evt: any) => {
        if (!haveBlock) {
          setHaveBlock(true);
          requestBalance();
          requestRecvAddress();
          requestSyncStatus();
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
          // TODO: Two cases:
          // 1. we don't have the subframe until we get the first block
          // 2. Do throw in other cases
          // throw new Error('blockchain reply to no subframe');
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
        requestRecvAddress();
        requestSyncStatus();
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
    // toggleExpanded();
    setShowQRModal(false)
  }, []);

  const sessionConnected = connected
    ? 'connected'
    : fakeAddress
      ? 'simulator'
      : 'disconnected';

  const ifSession = (
    <div className="flex flex-col justify-center items-center w-full h-full mt-12 sm:mt-16 md:mt-20 px-1.5 sm:px-2 md:px-4 py-3 sm:py-4 md:py-6 gap-2 sm:gap-3">
      {/* Simulator Button */}
      <div className="w-[90%] sm:w-3/4 md:w-1/2 flex justify-center items-center">
        <Button
          variant='solid'
          onClick={handleConnectSimulator}
          aria-label='select-simulator'
          fullWidth
        >
          Continue with Simulator
        </Button>
      </div>

      {/* Divider with OR */}
      <div className="flex items-center justify-center w-[90%] sm:w-3/4 md:w-[45%] my-2 sm:my-3 gap-1">
        <div className="flex-1 border-t border-canvas-border" />
        <span className="text-canvas-text font-medium whitespace-nowrap text-[0.85rem] sm:text-[0.95rem]">
          OR
        </span>
        <div className="flex-1 border-t border-canvas-border" />
      </div>

      {/* WalletConnect Dialog */}
      <div className="w-[90%] sm:w-3/4 md:w-1/2 flex justify-center items-center">
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
      </div>
    </div>

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
        marginTop: 'clamp(46px, 20vw, 86px)',
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
          <div className="flex items-end gap-1 min-w-auto">
            <img
              src="/images/chia_logo.png"
              alt="Chia Logo"
              className="max-w-24 h-auto rounded-md transition-opacity"
            />
            <span
              className="font-semibold whitespace-nowrap "
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
              Gaming
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

          {/* RIGHT: WalletConnect + Balance */}
          <div
            className={`flex items-center gap-1.5 sm:gap-2 md:gap-3 ${window.innerWidth < 640
              ? 'justify-between w-full'
              : 'justify-end w-auto'
              }`}
          >
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
                  {...({
                    sessionConnected,
                    synced,
                    fakeAddress,
                  } as any)}
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
                  Bal: {balance} mojos
                </span>
              )}

              <button
                onClick={toggleTheme}
                className={`p-1 border border-(--color-canvas-border) rounded ${isDark
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
                <Cross />
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
