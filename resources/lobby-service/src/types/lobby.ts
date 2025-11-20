export const GameTypes = {
  CALIFORNIA_POKER: 'california_poker',
  KRUNK: 'krunk',
  EXOTIC_POKER: 'exotic_poker',
};
export type GameType = 'california_poker' | 'krunk' | 'exotic_poker';

export type FragmentData = Record<string, string>;

export interface Player {
  id: string;
  alias: string;
  walletAddress?: string;
  joinedAt: number;
  lastActive: number;
  status: string;
  parameters: any;
}

export interface GameDefinition {
  game: string;
  target: string;
  expiration: number;
}

export interface ChatMessage {
  sender?: string;
  text: string;
  timestamp?: number;
}

export interface ChatEnvelope {
  alias: string;
  content: ChatMessage;
}

export interface GenerateRoomResult {
  secureUrl: string;
  token: string;
}

export interface Room {
  token: string;
  host: string;
  target?: string;
  joiner?: string;
  game: GameType;
  minPlayers: number;
  maxPlayers: number;
  status: 'waiting' | 'in_progress' | 'completed';
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  expiresAt: number;
  parameters: any;
  chat: ChatMessage[];
}

export interface MatchmakingPreferences {
  id: string;
  alias: string;
  game: GameType;
  minPlayers: number;
  maxPlayers: number;
  parameters: any;
}

export interface GameSession {
  id: string;
  roomId: string;
  gameType: GameType;
  host: string;
  joiner: string;
  startedAt: number;
  status: 'active' | 'in_progress' | 'completed';
  winner?: string;
  parameters: string[];
}
