import { useEffect, useRef } from 'react';

export function useCheatNerfKeys(handleCheat: () => void, handleNerf: () => void): void {
  const cheatBufRef = useRef('');
  const nerfBufRef = useRef('');
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

      const nerf = nerfBufRef.current + event.key;
      nerfBufRef.current = 'nerf^'.startsWith(nerf) ? nerf : ('nerf^'.startsWith(event.key) ? event.key : '');
      if (nerfBufRef.current === 'nerf^') {
        nerfBufRef.current = '';
        handleNerf();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCheat, handleNerf]);
}
