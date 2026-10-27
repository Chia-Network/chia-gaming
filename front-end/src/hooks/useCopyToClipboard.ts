import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Copy text to the clipboard and report the outcome as transient UI state.
 *
 * The browser may refuse a clipboard write (denied permission, unfocused page,
 * insecure context where `navigator.clipboard` is undefined). That is an
 * environment condition, not an app bug, so it is reported as `failed` instead
 * of surfacing as an unhandled rejection.
 */
export function useCopyToClipboard(resetMs = 1500): {
  state: CopyState;
  copy: (text: string) => Promise<void>;
} {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string) => {
      let next: CopyState = 'copied';
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        console.error('[useCopyToClipboard] write failed', err);
        next = 'failed';
      }
      setState(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), resetMs);
    },
    [resetMs],
  );

  return { state, copy };
}
