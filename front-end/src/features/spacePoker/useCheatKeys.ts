import { useEffect, useRef } from 'react';

export function useCheatKeys(handleCheat: () => void): void {
  const cheatBufRef = useRef('');
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
        || event.key.length !== 1
      ) return;

      const cheat = cheatBufRef.current + event.key;
      cheatBufRef.current = 'cheat^'.startsWith(cheat) ? cheat : ('cheat^'.startsWith(event.key) ? event.key : '');
      if (cheatBufRef.current === 'cheat^') {
        cheatBufRef.current = '';
        handleCheat();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCheat]);
}
