import { Subject } from 'rxjs';

import {
  DoInitialSpendResult,
  BlockchainInboundAddressResult,
} from '../types/ChiaGaming';
import { GetCoinRecordsByNamesResponse } from '../types/rpc/GetCoinRecordsByNames';
import { CreateNewRemoteWalletResponse } from '../types/rpc/CreateNewRemoteWallet';
import { GetHeightInfoResponse } from '../types/rpc/GetHeightInfo';
import { RegisterRemoteCoinsResponse } from '../types/rpc/RegisterRemoteCoins';
import { GetWalletsResponse } from '../types/rpc/GetWallets';

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

export interface BlockchainOutboundGetWalletsRequest {
  includeData: boolean;
}

export interface BlockchainOutboundGetHeightInfoRequest {
  _placeholder?: never;
}

export interface BlockchainOutboundGetCoinRecordsByNamesRequest {
  names: string[];
  startHeight?: number;
  endHeight?: number;
  includeSpentCoins?: boolean;
}

export interface BlockchainOutboundCreateNewRemoteWalletRequest {
  _placeholder?: never;
}

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
  getWallets?: BlockchainOutboundGetWalletsRequest;
  getHeightInfo?: BlockchainOutboundGetHeightInfoRequest;
  getCoinRecordsByNames?: BlockchainOutboundGetCoinRecordsByNamesRequest;
  createNewRemoteWallet?: BlockchainOutboundCreateNewRemoteWalletRequest;
  registerRemoteCoins?: BlockchainOutboundRegisterRemoteCoinsRequest;
}

export interface BlockchainInboundReply {
  responseId: number;
  initialSpend?: DoInitialSpendResult;
  transaction?: string;
  getAddress?: BlockchainInboundAddressResult;
  getBalance?: number;
  getWallets?: GetWalletsResponse;
  getHeightInfo?: GetHeightInfoResponse;
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
