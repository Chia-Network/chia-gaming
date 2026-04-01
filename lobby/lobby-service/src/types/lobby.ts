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
