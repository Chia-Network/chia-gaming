import { Subject } from 'rxjs';

import {
  DoInitialSpendResult,
  BlockchainInboundAddressResult,
} from '../types/ChiaGaming';
import { CreateNewRemoteWalletResponse } from '../types/rpc/CreateNewRemoteWallet';
import { GetCoinRecordsByNamesResponse } from '../types/rpc/GetCoinRecordsByNames';
import { RegisterRemoteCoinsResponse } from '../types/rpc/RegisterRemoteCoins';

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

export interface BlockchainOutboundCoinRecordsByNamesRequest {
  names: string[];
  startHeight?: number;
  endHeight?: number;
  includeSpentCoins?: boolean;
}

export type BlockchainOutboundCreateNewRemoteWalletRequest = boolean;

export interface BlockchainOutboundRegisterRemoteCoinsRequest {
  walletId: number;
  coinIds: string[];
}

export interface BlockchainOutboundRequest {
  requestId: number;
  initialSpend?: BlockchainOutboundInitialSpendRequest;
  transaction?: BlockchainOutboundTransactionRequest;
  getAddress?: BlockchainOutboundAddressRequest;
  getBalance?: BlockchainOutboundBalanceRequest;
  getCoinRecordsByNames?: BlockchainOutboundCoinRecordsByNamesRequest;
  createNewRemoteWallet?: BlockchainOutboundCreateNewRemoteWalletRequest;
  registerRemoteCoins?: BlockchainOutboundRegisterRemoteCoinsRequest;
}

export interface BlockchainInboundReply {
  responseId: number;
  initialSpend?: DoInitialSpendResult;
  transaction?: string;
  getAddress?: BlockchainInboundAddressResult;
  getBalance?: number;
  getCoinRecordsByNames?: GetCoinRecordsByNamesResponse;
  createNewRemoteWallet?: CreateNewRemoteWalletResponse;
  registerRemoteCoins?: RegisterRemoteCoinsResponse;
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
