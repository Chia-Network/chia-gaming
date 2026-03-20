import { useEffect, useState, useCallback, useRef } from 'react';

import WalletConnectHeading from './WalletConnectHeading';
import GameSession from './GameSession';
import { GameSessionParams, PeerConnectionResult } from '../types/ChiaGaming';
import { TrackerConnection, MatchedParams, ConnectionStatus } from '../services/TrackerConnection';
import { subscribeDebugLog } from '../services/debugLog';
import {
  getPlayerId,
  getSessionId,
  setBlockchainType as persistBlockchainType,
  getBlockchainType,
  loadSession,
  clearSession,
  startNewSession,
  SessionSave,
} from '../hooks/save';
import { blobSingleton } from '../hooks/blobSingleton';
import { blockchainDataEmitter } from '../hooks/BlockchainInfo';
import { FAKE_BLOCKCHAIN_ID } from '../hooks/FakeBlockchainInterface';
import { BLOCKCHAIN_SERVICE_URL } from '../settings';
import { useThemeSyncToIframe } from '../hooks/useThemeSyncToIframe';
import { debugLog } from '../services/debugLog';
import { LogOut } from 'lucide-react';

type TabId = 'tracker' | 'session' | 'game-log' | 'debug-log';

const TAB_DEFS: { id: TabId; label: string }[] = [
  { id: 'tracker', label: 'Tracker' },
  { id: 'session', label: 'Game Session' },
  { id: 'game-log', label: 'Game Log' },
  { id: 'debug-log', label: 'Debug Log' },
];

const FALLBACK_AMOUNT = 100n;
const FALLBACK_PER_GAME = 10n;

function LogPanel({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [lines]);

  return (
    <textarea
      ref={ref}
      readOnly
      value={lines.join('\n')}
      className='w-full h-full resize-none rounded-md border border-canvas-border bg-canvas-bg p-3 text-xs font-mono text-canvas-text focus:outline-none'
    />
  );
}

const Shell = () => {
  const uniqueId = getPlayerId();
  const sessionId = getSessionId();

  const [activeTab, setActiveTab] = useState<TabId>('tracker');
  const [gameParams, setGameParams] = useState<GameSessionParams | null>(null);
  const [peerConn, setPeerConn] = useState<PeerConnectionResult | null>(null);

  const [walletConnected, setWalletConnected] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<SessionSave | null>(() => loadSession());
  const [gameLog, setGameLog] = useState<string[]>([]);
  const [debugLogLines, setDebugLogLines] = useState<string[]>([]);

  const [iframeUrl, setIframeUrl] = useState('about:blank');
  const [iframeAllowed, setIframeAllowed] = useState('');

  const trackerConnRef = useRef<TrackerConnection | null>(null);
  const sessionSaveRef = useRef<SessionSave | null>(null);
  const activePairingTokenRef = useRef<string | null>(null);
  const blockchainTypeRef = useRef<import('../hooks/save').BlockchainType>('simulator');

  const appendGameLog = useCallback((line: string) => {
    setGameLog(prev => [...prev, line]);
  }, []);

  const registerMessageHandler = useCallback((handler: (msgno: number, msg: string) => void, ackHandler: (ack: number) => void, pingHandler: () => void) => {
    if (trackerConnRef.current) {
      trackerConnRef.current.registerMessageHandler(handler, ackHandler, pingHandler);
    }
  }, []);

  useEffect(() => {
    return subscribeDebugLog((line) => {
      setDebugLogLines(prev => [...prev, line]);
    });
  }, []);

  // Fetch tracker URL, set up iframe and TrackerConnection
  useEffect(() => {
    let cancelled = false;

    fetch('/urls')
      .then((res) => res.json())
      .then((urls: { tracker: string }) => {
        if (cancelled) return;

        const trackerURL = new URL(urls.tracker);
        const trackerOrigin = trackerURL.origin;
        setIframeAllowed(trackerOrigin);

        const lobbyUrl = `${trackerOrigin}/?lobby=true&session=${sessionId}&uniqueId=${uniqueId}`;
        setIframeUrl(lobbyUrl);

        const startSession = (
          conn: TrackerConnection,
          iStarted: boolean,
          amount: bigint,
          perGame: bigint,
          token: string,
          save: SessionSave | null,
        ) => {
          activePairingTokenRef.current = token;
          sessionSaveRef.current = save;
          setGameParams({
            iStarted,
            amount,
            perGameAmount: perGame,
            restoring: save !== null,
            pairingToken: token,
          });
          setPeerConn(conn.getPeerConnection());
          if (save) {
            setGameLog(save.gameLog);
            setDebugLogLines(save.debugLog);
          } else {
            setGameLog([]);
          }
          setActiveTab('session');
        };

        const conn = new TrackerConnection(trackerOrigin, sessionId, {
          onMatched: (matched: MatchedParams) => {
            let amount: bigint;
            let perGame: bigint;
            try { amount = BigInt(matched.amount); } catch { amount = FALLBACK_AMOUNT; }
            try { perGame = BigInt(matched.per_game); } catch { perGame = FALLBACK_PER_GAME; }
            startSession(conn, matched.i_am_initiator, amount, perGame, matched.token, null);
          },
          onConnectionStatus: (status: ConnectionStatus) => {
            // Mid-session reconnect: we already have an active session
            if (activePairingTokenRef.current !== null) {
              if (status.has_pairing && status.token === activePairingTokenRef.current) {
                console.log('[Shell] mid-session reconnect: token matches, resending un-acked');
                blobSingleton?.resendUnacked();
              } else {
                console.warn('[Shell] mid-session reconnect: pairing lost or mismatched, going on-chain');
                blobSingleton?.goOnChain();
                conn.close();
              }
              return;
            }

            // Initial page-load reconciliation
            const save = loadSession();

            if (status.has_pairing && status.token) {
              if (save && save.pairingToken === status.token) {
                let amount: bigint;
                let perGame: bigint;
                try { amount = BigInt(save.amount); } catch { amount = FALLBACK_AMOUNT; }
                try { perGame = BigInt(save.perGameAmount); } catch { perGame = FALLBACK_PER_GAME; }
                startSession(conn, status.i_am_initiator!, amount, perGame, status.token, save);
              } else if (!save) {
                console.warn('[Shell] connection_status: unrecognized pairing, requesting close');
                conn.close();
                clearSession();
              } else {
                console.warn('[Shell] connection_status: token mismatch (tracker=%s, save=%s), closing unknown pairing', status.token, save.pairingToken);
                conn.close();
                let amount: bigint;
                let perGame: bigint;
                try { amount = BigInt(save.amount); } catch { amount = FALLBACK_AMOUNT; }
                try { perGame = BigInt(save.perGameAmount); } catch { perGame = FALLBACK_PER_GAME; }
                sessionSaveRef.current = save;
                setGameParams({
                  iStarted: save.iStarted,
                  amount,
                  perGameAmount: perGame,
                  restoring: true,
                  pairingToken: save.pairingToken,
                });
                setPeerConn(conn.getPeerConnection());
                setGameLog(save.gameLog);
                setDebugLogLines(save.debugLog);
                setActiveTab('session');
              }
            } else {
              if (save) {
                console.warn('[Shell] connection_status: no pairing but have save, going on-chain');
                let amount: bigint;
                let perGame: bigint;
                try { amount = BigInt(save.amount); } catch { amount = FALLBACK_AMOUNT; }
                try { perGame = BigInt(save.perGameAmount); } catch { perGame = FALLBACK_PER_GAME; }
                sessionSaveRef.current = save;
                setGameParams({
                  iStarted: save.iStarted,
                  amount,
                  perGameAmount: perGame,
                  restoring: true,
                  pairingToken: save.pairingToken,
                });
                setPeerConn(conn.getPeerConnection());
                setGameLog(save.gameLog);
                setDebugLogLines(save.debugLog);
                setActiveTab('session');
              }
              // else: no pairing, no save -> idle, wait for fresh match
            }
          },
          onPeerReconnected: () => {
            blobSingleton?.resendUnacked();
          },
          onMessage: (_data: string) => {
            // Will be replaced by registerMessageHandler once GameSession mounts
          },
          onAck: (_ack: number) => {
            // Will be replaced by registerMessageHandler once GameSession mounts
          },
          onPing: () => {
            // Peer pings are handled by registerMessageHandler
          },
          onClosed: () => {
            console.log('[Shell] tracker connection closed');
          },
          onTrackerDisconnected: () => {
            console.log('[Shell] tracker disconnected');
          },
          onTrackerReconnected: () => {
            console.log('[Shell] tracker reconnected');
          },
        });
        trackerConnRef.current = conn;
      })
      .catch(e => {
        if (!cancelled) console.error('[Shell] failed to fetch /urls:', e);
      });

    return () => {
      cancelled = true;
      trackerConnRef.current?.disconnect();
      trackerConnRef.current = null;
    };
  }, [uniqueId, sessionId]);

  const handleReset = useCallback(() => {
    activePairingTokenRef.current = null;
    clearSession();
    startNewSession();
    window.location.reload();
  }, []);

  useThemeSyncToIframe('tracker-iframe', [iframeUrl]);

  const [resuming, setResuming] = useState(false);

  const handleResume = useCallback(() => {
    const bcType = getBlockchainType() ?? 'simulator';
    setResuming(true);

    const onRegistered = () => {
      setPendingRestore(null);
      setResuming(false);
      blockchainTypeRef.current = bcType;
      setWalletConnected(true);
      blockchainDataEmitter.select({ selection: FAKE_BLOCKCHAIN_ID, uniqueId });
    };
    const onFailed = (e: unknown) => {
      console.error('[Shell] wallet register failed on resume:', e);
      setResuming(false);
    };

    if (bcType === 'simulator') {
      fetch(`${BLOCKCHAIN_SERVICE_URL}/register?name=${uniqueId}`, { method: 'POST' })
        .then(res => res.json())
        .then(() => { debugLog('Simulator wallet registered (resume)'); onRegistered(); })
        .catch(onFailed);
    } else {
      debugLog('WalletConnect resume not yet implemented, falling back to simulator');
      fetch(`${BLOCKCHAIN_SERVICE_URL}/register?name=${uniqueId}`, { method: 'POST' })
        .then(res => res.json())
        .then(onRegistered)
        .catch(onFailed);
    }
  }, [uniqueId]);

  const handleStartFresh = useCallback(() => {
    clearSession();
    startNewSession();
    window.location.reload();
  }, []);

  const wcHeading = (
    <div style={{
      width: '100%',
      ...(walletConnected
        ? { flexShrink: 0 }
        : { flex: '1 1 0%', display: 'flex', flexDirection: 'column' as const }),
    }}>
      {(pendingRestore || getBlockchainType()) && !walletConnected ? (
        <div style={{
          flex: '1 1 0%',
          display: 'flex',
          flexDirection: 'column' as const,
          justifyContent: 'center',
          alignItems: 'center',
          width: '100%',
          padding: '1em',
        }}>
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '1.5rem',
            borderRadius: '0.5rem',
            border: '1px solid var(--color-canvas-border)',
            background: 'var(--color-canvas-bg)',
            maxWidth: '24rem',
            width: '90%',
          }}>
            <p className='text-canvas-text-contrast font-semibold text-lg'>Saved session found</p>
            <p className='text-canvas-text text-sm text-center'>
              {pendingRestore
                ? 'You have an in-progress game session. Resume where you left off, or start fresh?'
                : 'You have a previous session. Resume where you left off, or start fresh?'}
            </p>
            <button
              onClick={handleResume}
              disabled={resuming}
              className='w-full px-4 py-2 rounded-md font-medium text-sm bg-primary-solid text-primary-on-primary hover:bg-primary-solid-hover transition-colors disabled:opacity-50'
            >
              {resuming ? 'Resuming…' : 'Resume Session'}
            </button>
            <button
              onClick={handleStartFresh}
              disabled={resuming}
              className='w-full px-4 py-2 rounded-md font-medium text-sm border border-canvas-border text-canvas-text hover:bg-canvas-bg-hover transition-colors disabled:opacity-50'
            >
              Start Fresh
            </button>
          </div>
        </div>
      ) : (
        <WalletConnectHeading
          onConnected={(bcType) => {
            blockchainTypeRef.current = bcType;
            persistBlockchainType(bcType);
            setWalletConnected(true);
          }}
          initialExpanded={!walletConnected}
        />
      )}
    </div>
  );

  const tabBar = (
    <div style={{ flexShrink: 0, display: 'flex', alignItems: 'flex-end', gap: '0.25rem', padding: '0.5rem 1rem 0', borderBottom: '1px solid var(--color-canvas-border)', background: 'var(--color-canvas-bg-subtle)' }}>
      {TAB_DEFS.map((tab) => {
        const active = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={
              'px-3 py-1.5 text-sm font-medium rounded-t-md transition-colors ' +
              (active
                ? 'bg-canvas-bg text-canvas-text-contrast border border-b-0 border-canvas-border -mb-px'
                : 'text-canvas-text hover:text-canvas-text-contrast hover:bg-canvas-bg-hover')
            }
          >
            {tab.label}
          </button>
        );
      })}
      <div style={{ marginLeft: 'auto', paddingBottom: '0.25rem' }}>
        <button
          onClick={handleReset}
          className='px-2.5 py-1 text-xs font-bold rounded-md bg-alert-bg text-alert-text border border-alert-border hover:bg-alert-bg-hover transition-colors inline-flex items-center gap-1'
        >
          <LogOut className='w-3.5 h-3.5' />
          Reset
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', position: 'relative', width: '100vw', height: '100vh' }}
         className='bg-canvas-bg-subtle text-canvas-text'>
      {wcHeading}
      {walletConnected && (<>
      {tabBar}
      <div style={{ position: 'relative', flex: '1 1 0%', minHeight: 0, zIndex: 0 }}
           className='bg-canvas-bg-subtle'>
        {/* Tracker tab */}
        <div style={{ position: 'absolute', inset: 0, display: activeTab === 'tracker' ? 'block' : 'none' }}>
          <iframe
            id='tracker-iframe'
            className='bg-canvas-bg-subtle'
            style={{ width: '100%', height: '100%', border: 'none', margin: 0 }}
            src={iframeUrl}
            allow={`clipboard-write self ${iframeAllowed}`}
          />
        </div>

        {/* Game Session tab */}
        <div style={{ position: 'absolute', inset: 0, overflow: 'auto', display: activeTab === 'session' ? 'block' : 'none' }}>
          {gameParams && peerConn ? (
            <GameSession
              params={gameParams}
              peerConn={peerConn}
              registerMessageHandler={registerMessageHandler}
              appendGameLog={appendGameLog}
              sessionSave={sessionSaveRef.current ?? undefined}
              blockchainType={blockchainTypeRef.current}
            />
          ) : (
            <div className='w-full h-full flex items-center justify-center text-canvas-text/50'>
              No active game session
            </div>
          )}
        </div>

        {/* Game Log tab */}
        <div style={{ position: 'absolute', inset: 0, padding: '1rem', display: activeTab === 'game-log' ? 'block' : 'none' }}>
          <LogPanel lines={gameLog} />
        </div>

        {/* Debug Log tab */}
        <div style={{ position: 'absolute', inset: 0, padding: '1rem', display: activeTab === 'debug-log' ? 'block' : 'none' }}>
          {debugLogLines.length > 0 ? (
            <LogPanel lines={debugLogLines} />
          ) : (
            <div className='w-full h-full flex items-center justify-center text-canvas-text/50'>
              No debug log entries yet
            </div>
          )}
        </div>
      </div>
      </>)}
    </div>
  );
};

export default Shell;
