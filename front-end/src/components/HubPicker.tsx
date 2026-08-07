import { useState, useCallback } from 'react';
import { Button } from './button';

const DEV_HUB = 'http://localhost:3003';

function parseHubUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Plain http to a remote host is the one thing about a hub the user cannot read
 * off the URL they typed, so it is called out before they connect. Loopback is
 * exempt: the dev hub is not carried over a network anyone can sit on.
 */
function insecureHubWarning(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') {
    return null;
  }
  return 'This hub uses plain http. The connection is not encrypted, so anyone on the network path can read it.';
}

interface HubPickerProps {
  onConnect: (origin: string) => void;
  connectionError?: string | null;
}

export function HubPicker({ onConnect, connectionError }: HubPickerProps) {
  const [customUrl, setCustomUrl] = useState('');
  const [error, setError] = useState('');
  const insecureWarning = insecureHubWarning(customUrl);

  const handleCustomConnect = useCallback(() => {
    const origin = parseHubUrl(customUrl);
    if (origin) {
      setError('');
      onConnect(origin);
    } else {
      setError('Enter a valid URL (e.g. https://hub.example.com)');
    }
  }, [customUrl, onConnect]);

  return (
    <div className="flex flex-col items-center justify-center h-full px-4">
      <div className="flex flex-col items-center gap-6 w-full max-w-sm">
        <div className="flex flex-col items-center gap-2">
          <p className="text-lg font-semibold text-canvas-text-contrast">Connect to Hub</p>
          <p className="text-xs text-canvas-solid text-center">
            A hub finds you an opponent and relays your game messages. It sees who you play against
            and how much you wager, and it displays its own interface in this tab. It cannot take
            your funds or change the outcome of a game, because those are settled on-chain. Connect
            only to a hub you chose yourself.
          </p>
        </div>

        <div className="flex flex-col gap-1 w-full">
          <div className="flex gap-2 w-full">
            <input
              type="text"
              value={customUrl}
              onChange={(e) => {
                setCustomUrl(e.target.value);
                setError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCustomConnect();
              }}
              placeholder="https://hub.example.com"
              className={
                'flex-1 px-3 py-2 rounded-lg text-sm bg-canvas-bg border text-canvas-text placeholder:text-canvas-solid outline-none ' +
                (error
                  ? 'border-alert-border'
                  : 'border-canvas-border focus:border-primary-border-hover')
              }
            />
            <Button variant="solid" onClick={handleCustomConnect} disabled={!customUrl.trim()}>
              Connect
            </Button>
          </div>
          {(error || connectionError) && (
            <p className="text-xs text-alert-text">{error || connectionError}</p>
          )}
          {insecureWarning !== null && (
            <p className="text-xs text-warning-text">{insecureWarning}</p>
          )}
        </div>

        <button
          type="button"
          onClick={() => onConnect(DEV_HUB)}
          className="text-xs text-canvas-solid underline hover:text-canvas-text"
        >
          dev: connect to local hub (localhost:3003)
        </button>
      </div>
    </div>
  );
}
