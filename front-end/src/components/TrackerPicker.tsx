import { useState, useCallback } from 'react';
import { Button } from './button';

const DEV_TRACKER = 'http://127.0.0.1:3003';

function parseTrackerUrl(raw: string): string | null {
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

interface TrackerPickerProps {
  onConnect: (origin: string) => void;
}

export function TrackerPicker({ onConnect }: TrackerPickerProps) {
  const [customUrl, setCustomUrl] = useState('');
  const [error, setError] = useState('');

  const handleCustomConnect = useCallback(() => {
    const origin = parseTrackerUrl(customUrl);
    if (origin) {
      setError('');
      onConnect(origin);
    } else {
      setError('Enter a valid URL (e.g. https://tracker.example.com)');
    }
  }, [customUrl, onConnect]);

  return (
    <div className='flex flex-col items-center justify-center h-full px-4'>
      <div className='flex flex-col items-center gap-6 w-full max-w-sm'>
        <p className='text-lg font-semibold text-canvas-text-contrast'>Connect to Tracker</p>

        <div className='flex flex-col gap-1 w-full'>
          <div className='flex gap-2 w-full'>
            <input
              type='text'
              value={customUrl}
              onChange={(e) => { setCustomUrl(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCustomConnect(); }}
              placeholder='https://tracker.example.com'
              className={
                'flex-1 px-3 py-2 rounded-lg text-sm bg-canvas-bg border text-canvas-text placeholder:text-canvas-solid outline-none ' +
                (error ? 'border-alert-border' : 'border-canvas-border focus:border-primary-border-hover')
              }
            />
            <Button variant='solid' onClick={handleCustomConnect} disabled={!customUrl.trim()}>
              Connect
            </Button>
          </div>
          {error && <p className='text-xs text-alert-text'>{error}</p>}
        </div>

        <button
          type='button'
          onClick={() => onConnect(DEV_TRACKER)}
          className='text-xs text-canvas-solid underline hover:text-canvas-text'
        >
          dev: connect to local tracker (127.0.0.1:3003)
        </button>
      </div>
    </div>
  );
}
