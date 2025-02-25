import { Coin } from './Coin';
import { Peer } from './Peer';
import { TradeStatus } from './TradeStatus';
import { TradeSummary } from './TradeSummary';

export interface TradeRecord {
    acceptedAtTime: number | null;
    coinsOfInterest: Coin[];
    confirmedAtIndex: number;
    createdAtTime: number;
    isMyOffer: boolean;
    pending: Record<string, number>;
    sent: number;
    sentTo: Peer[];
    status: TradeStatus;
    summary: TradeSummary;
    takenOffer: string | null;
    tradeId: string;
    _offerData: string;
}
