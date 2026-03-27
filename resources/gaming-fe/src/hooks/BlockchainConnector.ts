import { Subject } from 'rxjs';

import {
  DoInitialSpendResult,
  BlockchainInboundAddressResult,
} from '../types/ChiaGaming';

export interface BlockchainOutboundInitialSpendRequest {
  uniqueId: string;
  target: string;
  amount: bigint;
}

export interface BlockchainOutboundTransactionRequest {
  blob: string;
  spendObject: unknown;
}

export type BlockchainOutboundAddressRequest = boolean;

export type BlockchainOutboundBalanceRequest = boolean;

export interface BlockchainOutboundSelectCoinsRequest {
  uniqueId: string;
  amount: number;
}

export interface BlockchainOutboundCreateOfferRequest {
  uniqueId: string;
  offer: { [walletId: string]: number };
  extraConditions?: Array<{ opcode: number; args: string[] }>;
  coinIds?: string[];
  maxHeight?: number;
}

export interface BlockchainOutboundRequest {
  requestId: number;
  initialSpend?: BlockchainOutboundInitialSpendRequest;
  transaction?: BlockchainOutboundTransactionRequest;
  getAddress?: BlockchainOutboundAddressRequest;
  getBalance?: BlockchainOutboundBalanceRequest;
  getPuzzleAndSolution?: { coin: string };
  selectCoins?: BlockchainOutboundSelectCoinsRequest;
  getHeightInfo?: {};
  createOfferForIds?: BlockchainOutboundCreateOfferRequest;
}

export interface BlockchainInboundReply {
  responseId: number;
  initialSpend?: DoInitialSpendResult;
  transaction?: string;
  getAddress?: BlockchainInboundAddressResult;
  getBalance?: number;
  getPuzzleAndSolution?: string[] | null;
  selectCoins?: string | null;
  getHeightInfo?: number;
  createOfferForIds?: any | null;
  error?: string;
}
class BlockchainRequestConnector {
  outbound: Subject<BlockchainOutboundRequest>;
  inbound: Subject<BlockchainInboundReply>;

  constructor() {
    this.outbound = new Subject<BlockchainOutboundRequest>();
    this.inbound = new Subject<BlockchainInboundReply>();
  }

  getOutbound() {
    return this.outbound;
  }
  getInbound() {
    return this.inbound;
  }

  requestEmitter(r: BlockchainOutboundRequest) {
    this.outbound.next(r);
  }
  replyEmitter(r: BlockchainInboundReply) {
    this.inbound.next(r);
  }
}

export const blockchainConnector = new BlockchainRequestConnector();
