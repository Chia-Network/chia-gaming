import type { PersistedGameState } from '@games/host';

function codec<T>(gameType: string) {
  return {
    gameType,
    encode: (state: T): PersistedGameState<T> => ({ gameType, state }),
    decode: (value: PersistedGameState | null): T | null =>
      value?.gameType === gameType ? (value.state as T) : null,
  };
}

export const calpokerStateCodec = codec<any>('calpoker');
export const spacepokerStateCodec = codec<any>('spacepoker');
export const krunkStateCodec = codec<any>('krunk');
