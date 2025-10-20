import { Coin } from './Coin';

export interface CoinSpend {
  coin: Coin;
  puzzleReveal: string;
  solution: string;
}
