import { useState, useCallback } from 'react';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { ChevronDownIcon } from 'lucide-react';
import { Button } from './button';
import { Input } from './ui/input';

const DEV_HUB = 'http://localhost:3003';
// Suggested hubs; the first one prefills the field.
const KNOWN_HUBS = ['https://hub.nokitlan.com'];

export function parseHubUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const schemeLikePrefix = trimmed.match(/^[a-zA-Z][a-zA-Z\d+\-.]*:/);
  const numericPort =
    schemeLikePrefix !== null && /^\d+(?:[/?#]|$)/.test(trimmed.slice(schemeLikePrefix[0].length));
  if (schemeLikePrefix !== null && !numericPort && !/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
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
  const [hubUrl, setHubUrl] = useState(KNOWN_HUBS[0]);
  const [error, setError] = useState('');
  const insecureWarning = insecureHubWarning(hubUrl);

  const handleConnect = useCallback(() => {
    const origin = parseHubUrl(hubUrl);
    if (origin) {
      setError('');
      onConnect(origin);
    } else {
      setError('Enter a valid URL (e.g. https://hub.example.com)');
    }
  }, [hubUrl, onConnect]);

  return (
    <div className="flex flex-col items-center justify-center h-full px-4">
      <div className="flex flex-col items-center gap-6 w-full max-w-sm">
        <div className="flex flex-col items-center gap-2">
          <p className="text-lg font-semibold text-canvas-text-contrast">Connect to Hub</p>
          <p className="text-xs text-canvas-solid text-center">
            A hub finds you an opponent and relays your game messages. It sees who you play against
            and how much you wager, and it displays its own interface in this tab. It cannot take
            your funds or change the outcome of a game, because those are settled on-chain. Do not
            send funds directly to a hub or players on a hub. You do not need to do that to play
            games.
          </p>
        </div>

        <div className="flex flex-col gap-2 w-full">
          <div className="flex gap-2 w-full">
            <Autocomplete.Root
              items={KNOWN_HUBS}
              filter={null}
              value={hubUrl}
              onValueChange={(value) => {
                setHubUrl(value);
                setError('');
              }}
              openOnInputClick
            >
              <Autocomplete.InputGroup className="relative flex-1">
                <Autocomplete.Input
                  render={<Input />}
                  aria-label="Hub URL"
                  aria-invalid={error ? true : undefined}
                  placeholder="https://hub.example.com"
                  className="h-10 pr-9"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleConnect();
                  }}
                />
                <Autocomplete.Trigger
                  aria-label="Show suggested hubs"
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground"
                >
                  <ChevronDownIcon className="size-4 opacity-50" />
                </Autocomplete.Trigger>
              </Autocomplete.InputGroup>
              <Autocomplete.Portal>
                <Autocomplete.Positioner sideOffset={4} className="z-50 outline-none">
                  <Autocomplete.Popup className="w-(--anchor-width) rounded-md border border-canvas-border bg-canvas-base p-1 text-sm text-canvas-text shadow-md">
                    <Autocomplete.List>
                      {(origin: string) => (
                        <Autocomplete.Item
                          key={origin}
                          value={origin}
                          className="cursor-pointer select-none rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-canvas-bg-hover"
                        >
                          {origin}
                        </Autocomplete.Item>
                      )}
                    </Autocomplete.List>
                  </Autocomplete.Popup>
                </Autocomplete.Positioner>
              </Autocomplete.Portal>
            </Autocomplete.Root>
            <Button variant="solid" onClick={handleConnect} disabled={!hubUrl.trim()}>
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
