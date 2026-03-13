import { Subject } from 'rxjs';

import {
  DoInitialSpendResult,
  BlockchainInboundAddressResult,
} from '../types/ChiaGaming';

export interface BlockchainOutboundInitialSpendRequest {
  uniqueId: string;
  target: string;
  amount: number;
}

export interface BlockchainOutboundTransactionRequest {
  blob: string;
  spendObject: any;
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
}

export interface BlockchainOutboundRequest {
  requestId: number;
  initialSpend?: BlockchainOutboundInitialSpendRequest;
  transaction?: BlockchainOutboundTransactionRequest;
  getAddress?: BlockchainOutboundAddressRequest;
  getBalance?: BlockchainOutboundBalanceRequest;
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
  selectCoins?: string | null;
  getHeightInfo?: number;
  createOfferForIds?: any | null;
  error?: string;
}

function describeRequest(r: BlockchainOutboundRequest): string {
  if (r.initialSpend) return 'initialSpend';
  if (r.transaction) return 'transaction';
  if (r.getAddress) return 'getAddress';
  if (r.getBalance) return 'getBalance';
  if (r.selectCoins) return 'selectCoins';
  if (r.getHeightInfo) return 'getHeightInfo';
  if (r.createOfferForIds) return 'createOfferForIds';
  return 'unknown';
}

function describeReply(r: BlockchainInboundReply): string {
  if (r.error) return `error: ${r.error}`;
  if (r.initialSpend) return 'initialSpend';
  if (r.transaction) return 'transaction';
  if (r.getAddress) return `getAddress`;
  if (r.getBalance !== undefined) return `getBalance=${r.getBalance}`;
  if (r.selectCoins !== undefined) return `selectCoins`;
  if (r.getHeightInfo !== undefined) return `getHeightInfo=${r.getHeightInfo}`;
  if (r.createOfferForIds !== undefined) return `createOfferForIds`;
  return 'unknown';
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
    console.log(`[BC] >>> req #${r.requestId} ${describeRequest(r)}`);
    this.outbound.next(r);
  }
  replyEmitter(r: BlockchainInboundReply) {
    console.log(`[BC] <<< reply #${r.responseId} ${describeReply(r)}`);
    this.inbound.next(r);
  }
}

export const blockchainConnector = new BlockchainRequestConnector();
