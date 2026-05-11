import { Coin } from './Coin';
import { Peer } from './Peer';
import { TradeStatus } from './TradeStatus';
import { TradeSummary } from './TradeSummary';

export interface TradeRecord {
  acceptedAtTime: bigint | null;
  coinsOfInterest: Coin[];
  confirmedAtIndex: bigint;
  createdAtTime: bigint;
  isMyOffer: boolean;
  pending: Record<string, bigint>;
  sent: bigint;
  sentTo: Peer[];
  status: TradeStatus;
  summary: TradeSummary;
  takenOffer: string | null;
  tradeId: string;
  _offerData: string;
}
