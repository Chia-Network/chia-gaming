import { useCallback, useState, useEffect, useRef } from 'react';
import { Button } from './button';
import { getActiveBlockchain } from '../hooks/activeBlockchain';
import useDebug from '../hooks/useDebug';
import { walletConnectState } from '../hooks/useWalletConnect';
import { getTheme, setTheme as saveTheme } from '../hooks/save';

import Debug from './Debug';
import { WalletConnectDialog, doConnectWallet } from './WalletConnect';
import WalletBadge from './WalletBadge';

import { WalletConnectOutboundState } from '../hooks/useWalletConnect';
import { debugLog } from '../services/debugLog';

const WalletConnectHeading = ({ onConnected, initialExpanded = true }: { onConnected?: (blockchainType: 'simulator' | 'walletconnect', source?: 'auto' | 'manual') => void; initialExpanded?: boolean }) => {
  const { wcInfo, setWcInfo } = useDebug();
  const [_alreadyConnected, setAlreadyConnected] = useState(false);
  const [_walletConnectError, setWalletConnectError] = useState<
    string | undefined
  >();
  const [expanded, setExpanded] = useState(initialExpanded);
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
  const [balance, setBalance] = useState<number | undefined>();
  const balanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const walletConnectStartedManuallyRef = useRef(false);

  // Theme state: keep dark/light in sync with document root and localStorage
  const [isDark, setIsDark] = useState<boolean>(() => {
    const stored = getTheme();
    if (stored === 'dark') return true;
    if (stored === 'light') return false;
    return document.documentElement.classList.contains('dark');
  });

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
      saveTheme('dark');
    } else {
      document.documentElement.classList.remove('dark');
      saveTheme('light');
    }
  }, [isDark]);

  const toggleTheme = useCallback(() => {
    setIsDark((d) => !d);
  }, []);

  const walletConnectStates: Record<string, (v: never) => void> = {
    stateName: setStateName,
    initializing: setInitializing,
    initialized: setInitialized,
    connecting: setConnecting,
    waitingApproval: setWaitingApproval,
    connected: setConnected,
    haveClient: setHaveClient,
    haveSession: setHaveSession,
    sessions: setSessions,
  };

  function requestBalance() {
    try {
      getActiveBlockchain().rpc.getBalance()
        .then((bal) => {
          setBalance(bal);
          if (balanceTimerRef.current) clearTimeout(balanceTimerRef.current);
          balanceTimerRef.current = setTimeout(requestBalance, 15000);
        })
        .catch(() => {
          if (balanceTimerRef.current) clearTimeout(balanceTimerRef.current);
          balanceTimerRef.current = setTimeout(requestBalance, 15000);
        });
    } catch {
      // blockchain not set yet
    }
  }

  useEffect(() => {
    const subscription = walletConnectState.getObservable().subscribe({
      next: (evt: WalletConnectOutboundState) => {
        if (evt.stateName === 'connected') {
          const source: 'auto' | 'manual' = walletConnectStartedManuallyRef.current ? 'manual' : 'auto';
          walletConnectStartedManuallyRef.current = false;
          debugLog('WalletConnect connected');
          toggleExpanded();
          setAlreadyConnected(true);
          onConnected?.('walletconnect', source);
          requestBalance();
        }

        const record = evt as unknown as Record<string, unknown>;
        Object.keys(record).forEach((k: string) => {
          if (walletConnectStates[k]) {
            walletConnectStates[k](record[k] as never);
          }
        });
      },
    });

    return () => subscription.unsubscribe();
  }, []);

  const toggleExpanded = useCallback(() => {
    setExpanded(!expanded);
  }, [expanded]);

  const initWalletConnect = useCallback(async () => {
    if (!initializing) {
      setInitializing(true);
      await walletConnectState.init().catch(() => {});
    }
  }, [initializing]);

  useEffect(() => {
    return () => {
      if (balanceTimerRef.current) clearTimeout(balanceTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setExpanded(initialExpanded);
  }, [initialExpanded]);

  // (height managed by parent Shell layout)
  const handleConnectSimulator = useCallback(() => {
    toggleExpanded();
    onConnected?.('simulator', 'manual');
    requestBalance();
  }, [onConnected, toggleExpanded]);

  const onDoWalletConnect = useCallback(async () => {
    walletConnectStartedManuallyRef.current = true;
    await initWalletConnect();
    doConnectWallet(
      setShowQRModal,
      setConnectionUri,
      () => walletConnectState.startConnect(),
      () => {},
      (e) => {
        setWalletConnectError(e);
      },
    );
  }, [initWalletConnect]);

  const onWalletDismiss = useCallback(() => {
    // toggleExpanded();
    setShowQRModal(false);
  }, []);

  const sessionConnected = connected
    ? 'connected'
    : 'disconnected';

  const ifSession = (
    <div className='flex flex-col justify-center items-center w-full px-1.5 sm:px-2 md:px-4 py-3 sm:py-4 md:py-6 gap-2 sm:gap-3'>
      {/* Simulator Button */}
      <div className='w-[90%] sm:w-3/4 md:w-1/2 flex justify-center items-center'>
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
      <div className='flex items-center justify-center w-[90%] sm:w-3/4 md:w-[45%] my-2 sm:my-3 gap-1'>
        <div className='flex-1 border-t border-canvas-border' />
        <span className='text-canvas-text font-medium whitespace-nowrap text-[0.85rem] sm:text-[0.95rem]'>
          OR
        </span>
        <div className='flex-1 border-t border-canvas-border' />
      </div>

      {/* WalletConnect Dialog */}
      <div className='w-[90%] sm:w-3/4 md:w-1/2 flex justify-center items-center'>
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

  const ifExpanded = expanded ? (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 0%',
        justifyContent: 'center',
        alignItems: 'center',
        width: '100%',
        padding: '1em',
      }}
    >
      {ifSession}
    </div>
  ) : null;

  const balanceDisplay =
    balance !== undefined ? <div>- Balance {balance}</div> : <div />;

  return (
    <div
      className='flex flex-col w-full'
      style={{ backgroundColor: 'var(--color-canvas-bg)', ...(expanded ? { flex: '1 1 0%' } : {}) }}
    >
      <div className='flex flex-row h-auto'>
        {/* Header */}
        {/* Fixed Header */}
        <div
          className='w-full flex gap-1 shadow-md'
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
            minHeight: window.innerWidth < 640 ? 'auto' : '3.5em',
            backgroundColor: 'var(--color-canvas-bg)',
            color: 'var(--color-primary-text)',
          }}
        >
          {/* LEFT: Title */}
          <div className='flex items-end gap-1 min-w-auto'>
            <img
              src='/images/chia_logo.png'
              alt='Chia Logo'
              className='max-w-24 h-auto rounded-md transition-opacity'
            />
            <span
              className='font-semibold whitespace-nowrap '
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
                  onClick={async () => {
                    try {
                      await walletConnectState.disconnect();
                    } finally {
                      window.location.reload();
                    }
                  }}
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
            className={`flex items-center gap-1.5 sm:gap-2 md:gap-3 ${
              window.innerWidth < 640
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
                  sessionConnected={sessionConnected}
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
                className={`p-1 border border-(--color-canvas-border) rounded ${
                  isDark ? 'text-warning-solid' : 'text-canvas-text'
                } hover:bg-canvas-bg-hover`}
                aria-label='toggle theme'
                title='Toggle theme'
              >
                <span className='text-sm leading-none'>{isDark ? '☀' : '☾'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {ifExpanded}

      {/* Debug IconButton */}
      <button
        onClick={() => setDebugOpen(true)}
        className='fixed bottom-6 right-6 flex items-center justify-center px-2 py-1.5 rounded-full border border-canvas-border shadow-md'
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
        aria-label='open debug'
        title='Open debug'
      >
        <span className='text-xs font-semibold'>Debug</span>
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
                aria-label='close debug'
                title='Close'
              >
                <span aria-hidden='true' className='text-lg leading-none'>&times;</span>
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
