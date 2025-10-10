export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly message: string,
    public readonly statusCode: number = 500,
    public readonly details?: any,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const ErrorCodes = {
  AUTH: {
    UNAUTHORIZED: 'AUTH_001',
    INVALID_TOKEN: 'AUTH_002',
    SESSION_EXPIRED: 'AUTH_003',
    INVALID_SIGNATURE: 'AUTH_004',
    WALLET_NOT_CONNECTED: 'AUTH_005',
  },
  LOBBY: {
    ROOM_FULL: 'LOBBY_001',
    ROOM_NOT_FOUND: 'LOBBY_002',
    PLAYER_NOT_FOUND: 'LOBBY_003',
    INVALID_ACTION: 'LOBBY_004',
    GAME_IN_PROGRESS: 'LOBBY_005',
    INSUFFICIENT_PLAYERS: 'LOBBY_006',
    ROOM_EXISTS: 'LOBBY_007',
    PLAYER_NOT_IN_ROOM: 'LOBBY_008',
    MESSAGE_RATE_LIMIT: 'LOBBY_009',
    INVALID_GAME_PARAMS: 'LOBBY_010',
  },
  VALIDATION: {
    INVALID_INPUT: 'VALID_001',
    MISSING_REQUIRED: 'VALID_002',
    INVALID_FORMAT: 'VALID_003',
  },
  GAME: {
    SESSION_NOT_FOUND: 'GAME_001',
    PLAYER_NOT_IN_SESSION: 'GAME_002',
    INVALID_GAME_ACTION: 'GAME_003',
    GAME_ALREADY_ENDED: 'GAME_004',
    INVALID_GAME_STATE: 'GAME_005',
  },
  SYSTEM: {
    NOT_FOUND: 'SYS_001',
    INTERNAL_ERROR: 'SYS_002',
    SERVICE_UNAVAILABLE: 'SYS_003',
    RATE_LIMIT_EXCEEDED: 'SYS_004',
  },
} as const;
