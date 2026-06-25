export type PlayerStatus = 'waiting' | 'playing' | 'busy';

export interface Player {
  id: string;
  alias: string;
  walletAddress?: string;
  status: PlayerStatus;
  opponent_alias?: string;
  parameters: any;
}

export interface Challenge {
  id: string;
  from_id: string;
  target_id: string;
  amount: string;
  channel_timeout?: string;
  unroll_timeout?: string;
}

export interface Pairing {
  playerA_id: string;
  playerB_id: string;
  token: string;
  amount: string;
  channel_timeout?: string;
  unroll_timeout?: string;
}
