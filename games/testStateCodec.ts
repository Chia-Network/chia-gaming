import type { PersistedGameState } from './host';

export function testStateCodec<T>(gameType: string) {
  return {
    gameType,
    encode: (state: T): PersistedGameState<T> => ({ gameType, state }),
    decode: (value: PersistedGameState | null): T | null =>
      value?.gameType === gameType ? (value.state as T) : null,
  };
}
