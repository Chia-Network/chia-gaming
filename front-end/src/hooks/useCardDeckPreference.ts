import { useMemo, useSyncExternalStore } from 'react';

export interface CardDeckPreference {
  readonly value: string | undefined;
  set(value: string): void;
}

const listeners = new Set<() => void>();
// Keeps the choice for this page when storage is blocked or full.
const unsaved = new Map<string, string>();

/** Each game keeps its own deck, since their decks differ. */
const storageKey = (gameType: string) => `chia-gaming:card-deck:${gameType}`;

function read(key: string): string | undefined {
  try {
    return unsaved.get(key) ?? localStorage.getItem(key) ?? undefined;
  } catch {
    return unsaved.get(key);
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    unsaved.delete(key);
  } catch {
    unsaved.set(key, value);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  // Other tabs report their changes through storage events.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(storageKey(''))) listener();
  };
  listeners.add(listener);
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The card deck is only a look, so it lives in localStorage, outside saved state. */
export function useCardDeckPreference(gameType: string): CardDeckPreference {
  const key = storageKey(gameType);
  const snapshot = () => read(key);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => ({ value, set: (next: string) => write(key, next) }), [key, value]);
}
