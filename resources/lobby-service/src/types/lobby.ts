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
  session_id: string;
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

export interface Challenge {
  id: string;
  from_id: string;
  target_id: string;
  game: string;
  amount: string;
  per_game: string;
}

export interface Pairing {
  playerA_id: string;
  playerB_id: string;
  token: string;
  game_type: string;
  amount: string;
  per_game: string;
}
