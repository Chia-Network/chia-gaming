export interface PersistedGameState<T = unknown> {
  gameType: string;
  version: bigint;
  state: T;
}

export interface GameStateCodec<T> {
  readonly gameType: string;
  readonly version: bigint;
  readonly canRemountFinished: boolean;
  isState(value: unknown): value is T;
  gameIds(state: T): readonly string[];
  encode(state: T): PersistedGameState<T>;
  decode(value: unknown): T | null;
}

export function defineGameStateCodec<T>(definition: {
  gameType: string;
  version: bigint;
  canRemountFinished: boolean;
  isState(value: unknown): value is T;
  gameIds?: (state: T) => readonly string[];
}): GameStateCodec<T> {
  const { gameType, version, canRemountFinished, isState, gameIds = () => [] } = definition;
  return {
    gameType,
    version,
    canRemountFinished,
    isState,
    gameIds,
    encode: (state) => ({ gameType, version, state }),
    decode: (value) => {
      if (typeof value !== 'object' || value === null) return null;
      const persisted = value as Partial<PersistedGameState>;
      return persisted.gameType === gameType &&
        persisted.version === version &&
        isState(persisted.state)
        ? persisted.state
        : null;
    },
  };
}
