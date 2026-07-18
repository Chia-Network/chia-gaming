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
  challenger_amount: string;
  target_amount: string;
  channel_timeout?: string;
  unroll_timeout?: string;
}
