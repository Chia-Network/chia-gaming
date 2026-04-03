import { Coin } from './Coin';
import { Peer } from './Peer';
import { SpendBundle } from './SpendBundle';
import { TransactionType } from './TransactionType';

export interface TransactionRecord {
  additions: Coin[];
  amount: number;
  confirmed: boolean;
  confirmedAtHeight: number;
  createdAtTime: number;
  feeAmount: number;
  memos: Record<string, string>;
  name: string;
  removals: Coin[];
  sent: number;
  sentTo: Peer[];
  spendBundle: SpendBundle | null;
  toAddress: string;
  toPuzzleHash: string;
  tradeId: string | null;
  type: TransactionType;
  walletId: number;
}
