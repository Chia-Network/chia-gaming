import { CoinSpend } from './CoinSpend';

export interface SpendBundle {
    coinSpends: CoinSpend[];
    aggregatedSignature: string;
}
