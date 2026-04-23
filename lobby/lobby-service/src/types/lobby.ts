export type PlayerStatus = 'waiting' | 'playing';

export interface Player {
  id: string;
  alias: string;
  session_id: string;
  walletAddress?: string;
  status: PlayerStatus;
  opponent_alias?: string;
  parameters: any;
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
