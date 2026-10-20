import type { BusyReason } from '../busyReasons';

export type PlayerStatus = 'waiting' | 'playing' | 'busy';

export interface Player {
  id: string;
  alias: string;
  status: PlayerStatus;
  opponent_alias?: string;
  /**
   * Present only while `status === 'busy'` with a non-empty reason set. Sent
   * only in the owner's own `hub_update` entry; other players never receive it.
   */
  busy_reasons?: BusyReason[];
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
