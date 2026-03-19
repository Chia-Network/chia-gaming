import { useEffect, useState, useCallback, useRef } from 'react';

import WalletConnectHeading from './WalletConnectHeading';
import GameSession from './GameSession';
import { blockchainDataEmitter } from '../hooks/BlockchainInfo';
import { BlockchainReport, GameSessionParams, PeerConnectionResult } from '../types/ChiaGaming';
import { TrackerConnection, MatchedParams } from '../services/TrackerConnection';
import {
  generateOrRetrieveUniqueId,
  generateOrRetrieveSessionId,
} from '../util';
import { useThemeSyncToIframe } from '../hooks/useThemeSyncToIframe';
import { Loader2, LogOut } from 'lucide-react';

type TabId = 'tracker' | 'session' | 'game-log' | 'debug-log';

const TAB_DEFS: { id: TabId; label: string; needsSession: boolean }[] = [
  { id: 'tracker', label: 'Tracker', needsSession: false },
  { id: 'session', label: 'Game Session', needsSession: true },
  { id: 'game-log', label: 'Game Log', needsSession: true },
  { id: 'debug-log', label: 'Debug Log', needsSession: true },
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
  const uniqueId = generateOrRetrieveUniqueId();
  const sessionId = generateOrRetrieveSessionId();

  const [activeTab, setActiveTab] = useState<TabId>('tracker');
  const [gameParams, setGameParams] = useState<GameSessionParams | null>(null);
  const [peerConn, setPeerConn] = useState<PeerConnectionResult | null>(null);

  const [gameLog, setGameLog] = useState<string[]>([]);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  const [havePeak, setHavePeak] = useState(false);
  const [iframeUrl, setIframeUrl] = useState('about:blank');
  const [iframeAllowed, setIframeAllowed] = useState('');

  const trackerConnRef = useRef<TrackerConnection | null>(null);

  const appendGameLog = useCallback((line: string) => {
    setGameLog(prev => [...prev, line]);
  }, []);

  const appendDebugLog = useCallback((line: string) => {
    setDebugLog(prev => [...prev, line]);
  }, []);

  const registerMessageHandler = useCallback((handler: (msgno: number, msg: string) => void) => {
    if (trackerConnRef.current) {
      trackerConnRef.current.registerMessageHandler(handler);
    }
  }, []);

  useEffect(() => {
    const subscription = blockchainDataEmitter.getObservable().subscribe({
      next: (_peak: BlockchainReport) => {
        setHavePeak(true);
      },
    });
    return () => subscription.unsubscribe();
  }, []);

  // Fetch tracker URL, set up iframe and TrackerConnection
  useEffect(() => {
    fetch('/urls')
      .then((res) => res.json())
      .then((urls: { tracker: string }) => {
        const trackerURL = new URL(urls.tracker);
        const trackerOrigin = trackerURL.origin;
        setIframeAllowed(trackerOrigin);

        const lobbyUrl = `${trackerOrigin}/?lobby=true&session=${sessionId}&uniqueId=${uniqueId}`;
        setIframeUrl(lobbyUrl);

        // Create TrackerConnection for game message relay
        const conn = new TrackerConnection(trackerOrigin, sessionId, {
          onMatched: (matched: MatchedParams) => {
            let amount: bigint;
            let perGame: bigint;
            try { amount = BigInt(matched.amount); } catch { amount = FALLBACK_AMOUNT; }
            try { perGame = BigInt(matched.per_game); } catch { perGame = FALLBACK_PER_GAME; }
            setGameParams({
              iStarted: matched.i_am_initiator,
              amount,
              perGameAmount: perGame,
            });
            setPeerConn(conn.getPeerConnection());
            setGameLog([]);
            setDebugLog([]);
            setActiveTab('session');
          },
          onMessage: (_data: string) => {
            // Will be replaced by registerMessageHandler once GameSession mounts
          },
          onClosed: () => {
            console.log('[Shell] tracker connection closed');
          },
        });
        trackerConnRef.current = conn;
      })
      .catch(e => console.error('[Shell] failed to fetch /urls:', e));

    return () => {
      trackerConnRef.current?.disconnect();
    };
  }, [uniqueId, sessionId]);

  const handleReset = useCallback(() => {
    localStorage.clear();
    window.location.reload();
  }, []);

  useThemeSyncToIframe('tracker-iframe', [iframeUrl]);

  const wcHeading = (
    <div style={{ flexShrink: 0, height: '3rem', width: '100%' }}>
      <WalletConnectHeading />
    </div>
  );

  const resetButton = (
    <button
      onClick={handleReset}
      className='px-4 py-2 text-sm font-bold rounded-md bg-alert-bg text-alert-text border border-alert-border hover:bg-alert-bg-hover transition-colors inline-flex items-center gap-1.5'
    >
      <LogOut className='w-4 h-4' />
      Reset
    </button>
  );

  if (!havePeak) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', position: 'relative', width: '100vw', height: '100vh' }}
           className='bg-canvas-bg-subtle text-canvas-text'>
        {wcHeading}
        <div style={{ flex: '1 1 0%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: '0.75rem' }}>
          <Loader2 className='h-6 w-6 z-0 animate-spin text-primary mb-4' />
          Waiting for blockchain peak ...
          <div style={{ marginTop: '1rem' }}>{resetButton}</div>
        </div>
      </div>
    );
  }

  const tabBar = (
    <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.25rem 1rem', borderBottom: '1px solid var(--color-canvas-border)', background: 'var(--color-canvas-bg-subtle)' }}>
      {TAB_DEFS.map((tab) => {
        const disabled = tab.needsSession && !gameParams;
        const active = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            disabled={disabled}
            onClick={() => setActiveTab(tab.id)}
            className={
              'px-3 py-1.5 text-sm font-medium rounded-t-md transition-colors ' +
              (active
                ? 'bg-canvas-bg text-canvas-text-contrast border border-b-0 border-canvas-border -mb-px'
                : disabled
                  ? 'text-canvas-text/30 cursor-not-allowed'
                  : 'text-canvas-text hover:text-canvas-text-contrast hover:bg-canvas-bg-hover')
            }
          >
            {tab.label}
          </button>
        );
      })}
      <div style={{ marginLeft: 'auto' }}>{resetButton}</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', position: 'relative', width: '100vw', height: '100vh' }}
         className='bg-canvas-bg-subtle text-canvas-text'>
      {wcHeading}
      <div style={{ height: '2rem', flexShrink: 0 }} />
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
              appendDebugLog={appendDebugLog}
            />
          ) : (
            <div className='w-full h-full flex items-center justify-center text-canvas-text/50'>
              No active game session
            </div>
          )}
        </div>

        {/* Game Log tab */}
        <div style={{ position: 'absolute', inset: 0, padding: '1rem', display: activeTab === 'game-log' ? 'block' : 'none' }}>
          {gameLog.length > 0 ? (
            <LogPanel lines={gameLog} />
          ) : (
            <div className='w-full h-full flex items-center justify-center text-canvas-text/50'>
              No game log entries yet
            </div>
          )}
        </div>

        {/* Debug Log tab */}
        <div style={{ position: 'absolute', inset: 0, padding: '1rem', display: activeTab === 'debug-log' ? 'block' : 'none' }}>
          {debugLog.length > 0 ? (
            <LogPanel lines={debugLog} />
          ) : (
            <div className='w-full h-full flex items-center justify-center text-canvas-text/50'>
              No debug log entries yet
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Shell;
