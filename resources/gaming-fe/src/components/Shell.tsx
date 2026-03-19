import { useEffect, useState, useCallback, useRef } from 'react';

import WalletConnectHeading from './WalletConnectHeading';
import GameSession from './GameSession';
import GameRedirectPopup from './GameRedirectPopup';
import { blockchainDataEmitter } from '../hooks/BlockchainInfo';
import { BlockchainReport } from '../types/ChiaGaming';
import {
  getGameSelection,
  getSearchParams,
  getParamsFromString,
  generateOrRetrieveUniqueId,
} from '../util';
import { useThemeSyncToIframe } from '../hooks/useThemeSyncToIframe';
import { Loader2 } from 'lucide-react';

type TabId = 'tracker' | 'session' | 'game-log' | 'debug-log';

const TAB_DEFS: { id: TabId; label: string; needsSession: boolean }[] = [
  { id: 'tracker', label: 'Tracker', needsSession: false },
  { id: 'session', label: 'Game Session', needsSession: true },
  { id: 'game-log', label: 'Game Log', needsSession: true },
  { id: 'debug-log', label: 'Debug Log', needsSession: true },
];

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
  const urlParams = getSearchParams();
  const gameSelection = getGameSelection();

  const [activeTab, setActiveTab] = useState<TabId>('tracker');
  const [gameParams, setGameParams] = useState<Record<string, string | undefined> | null>(null);

  const [gameLog, setGameLog] = useState<string[]>([]);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  const [havePeak, setHavePeak] = useState(false);
  const [iframeUrl, setIframeUrl] = useState('about:blank');
  const [iframeAllowed, setIframeAllowed] = useState('');

  const [showPopup, setShowPopup] = useState(false);
  const [pendingGameUrl, setPendingGameUrl] = useState<string | null>(null);

  const appendGameLog = useCallback((line: string) => {
    setGameLog(prev => [...prev, line]);
  }, []);

  const appendDebugLog = useCallback((line: string) => {
    setDebugLog(prev => [...prev, line]);
  }, []);

  // Wait for first blockchain peak
  useEffect(() => {
    const subscription = blockchainDataEmitter.getObservable().subscribe({
      next: (_peak: BlockchainReport) => {
        setHavePeak(true);
      },
    });
    return () => subscription.unsubscribe();
  }, []);

  // Fetch tracker URL and set up iframe
  useEffect(() => {
    fetch('/urls')
      .then((res) => res.json())
      .then((urls: { tracker: string }) => {
        const trackerURL = new URL(urls.tracker);
        setIframeAllowed(trackerURL.origin);

        const baseUrl = urls.tracker;
        const lobbyUrl = gameSelection
          ? `${baseUrl}&uniqueId=${uniqueId}&token=${gameSelection.token}&view=game`
          : `${baseUrl}&view=game&uniqueId=${uniqueId}`;

        if (urlParams.join) {
          setPendingGameUrl(lobbyUrl);
          setShowPopup(true);
        } else {
          setIframeUrl(lobbyUrl);
        }
      })
      .catch(e => console.error('[Shell] failed to fetch /urls:', e));
  }, []);

  // Listen for game-start postMessage from lobby iframe
  useEffect(() => {
    function handler(ev: MessageEvent) {
      if (!ev.data || ev.data.type !== 'game-start' || typeof ev.data.url !== 'string') return;
      const url = ev.data.url as string;
      const qIdx = url.indexOf('?');
      if (qIdx < 0) return;
      const parsed = getParamsFromString(url.substring(qIdx + 1));
      setGameParams(parsed);
      setGameLog([]);
      setDebugLog([]);
      setActiveTab('session');
    }
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useThemeSyncToIframe('tracker-iframe', [iframeUrl]);

  const handleAccept = () => {
    if (pendingGameUrl) {
      setIframeUrl(pendingGameUrl);
    }
    setShowPopup(false);
  };

  const handleCancel = () => {
    setShowPopup(false);
    window.location.href = '/';
  };

  const wcHeading = (
    <div style={{ flexShrink: 0, height: '3rem', width: '100%' }}>
      <WalletConnectHeading />
    </div>
  );

  if (!havePeak) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', position: 'relative', width: '100vw', height: '100vh' }}
           className='bg-canvas-bg-subtle text-canvas-text'>
        {wcHeading}
        <div style={{ flex: '1 1 0%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: '0.75rem' }}>
          <Loader2 className='h-6 w-6 z-0 animate-spin text-primary mb-4' />
          Waiting for blockchain peak ...
        </div>
        <GameRedirectPopup
          open={showPopup}
          gameName={urlParams.game}
          message='You have been invited to join this game.'
          onAccept={handleAccept}
          onCancel={handleCancel}
        />
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
          {gameParams ? (
            <GameSession
              params={gameParams}
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

      <GameRedirectPopup
        open={showPopup}
        gameName={urlParams.game}
        message='You have been invited to join this game.'
        onAccept={handleAccept}
        onCancel={handleCancel}
      />
    </div>
  );
};

export default Shell;
