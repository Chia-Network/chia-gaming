import { useMemo, useState } from 'react';
import type { GamePreference } from '@games/host';
import { storageRepository } from '../lib/session/storageRepository';

export function useCardDeckPreference(): GamePreference {
  const [value, setValue] = useState(() => storageRepository.query('cardDeck'));
  return useMemo(
    () => ({
      value,
      set: (next) => {
        storageRepository.updatePreference({ key: 'cardDeck', value: next });
        setValue(next);
      },
    }),
    [value],
  );
}
