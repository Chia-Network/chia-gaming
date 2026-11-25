import { useMemo, useSyncExternalStore } from 'react';

export interface CardDeckPreference {
  readonly value: string | undefined;
  set(value: string): void;
}

const STORAGE_KEY = 'chia-gaming:card-deck';
const listeners = new Set<() => void>();
// Keeps the choice for this page when storage is blocked or full.
let unsaved: string | undefined;

function read(): string | undefined {
  try {
    return unsaved ?? localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return unsaved;
  }
}

function write(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
    unsaved = undefined;
  } catch {
    unsaved = value;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  // Other tabs report their changes through storage events.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) listener();
  };
  listeners.add(listener);
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The card deck is only a look, so it lives in localStorage, outside saved state. */
export function useCardDeckPreference(): CardDeckPreference {
  const value = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => ({ value, set: write }), [value]);
}
