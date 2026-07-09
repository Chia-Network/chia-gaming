import { useEffect, useRef } from 'react';

// Hidden developer easter eggs shared across game UIs: typing "cheat^" triggers
// a cheat move (to exercise slash handling) and "nerf^" stops local transaction
// publishing. Keeping the sequence matcher in one place ensures every game
// behaves identically. Modified keystrokes and typing into text inputs are
// ignored so the eggs never fire while the user is editing a field.
export function useCheatNerfKeys(handleCheat: () => void, handleNerf: () => void): void {
  const cheatBufRef = useRef('');
  const nerfBufRef = useRef('');
  useEffect(() => {
    const CHEAT_SEQ = 'cheat^';
    const NERF_SEQ = 'nerf^';
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key.length !== 1) return;

      const cheatBuf = cheatBufRef.current + e.key;
      if (CHEAT_SEQ.startsWith(cheatBuf)) {
        cheatBufRef.current = cheatBuf;
        if (cheatBuf === CHEAT_SEQ) {
          cheatBufRef.current = '';
          handleCheat();
        }
      } else {
        cheatBufRef.current = CHEAT_SEQ.startsWith(e.key) ? e.key : '';
      }

      const nerfBuf = nerfBufRef.current + e.key;
      if (NERF_SEQ.startsWith(nerfBuf)) {
        nerfBufRef.current = nerfBuf;
        if (nerfBuf === NERF_SEQ) {
          nerfBufRef.current = '';
          handleNerf();
        }
      } else {
        nerfBufRef.current = NERF_SEQ.startsWith(e.key) ? e.key : '';
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCheat, handleNerf]);
}
