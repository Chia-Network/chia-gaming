import { useState, useCallback } from 'react';
import { Button } from './button';

const DEV_TRACKER = 'http://localhost:3003';

interface TrackerPickerProps {
  onConnect: (origin: string) => void;
}

export function TrackerPicker({ onConnect }: TrackerPickerProps) {
  const [customUrl, setCustomUrl] = useState('');

  const handleCustomConnect = useCallback(() => {
    const trimmed = customUrl.trim();
    if (!trimmed) return;
    try {
      const url = new URL(trimmed);
      onConnect(url.origin);
    } catch {
      onConnect(trimmed);
    }
  }, [customUrl, onConnect]);

  return (
    <div className='flex flex-col items-center justify-center h-full px-4'>
      <div className='flex flex-col items-center gap-6 w-full max-w-sm'>
        <p className='text-lg font-semibold text-canvas-text-contrast'>Connect to Tracker</p>

        <div className='flex gap-2 w-full'>
          <input
            type='text'
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCustomConnect(); }}
            placeholder='https://tracker.example.com'
            className='flex-1 px-3 py-2 rounded-lg text-sm bg-canvas-bg border border-canvas-border text-canvas-text placeholder:text-canvas-solid outline-none focus:border-primary-border-hover'
          />
          <Button variant='solid' onClick={handleCustomConnect} disabled={!customUrl.trim()}>
            Connect
          </Button>
        </div>

        <button
          type='button'
          onClick={() => onConnect(DEV_TRACKER)}
          className='text-xs text-canvas-solid underline hover:text-canvas-text'
        >
          dev: connect to local tracker (localhost:3003)
        </button>
      </div>
    </div>
  );
}
