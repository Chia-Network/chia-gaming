import { filter, take } from 'rxjs';

import {
  DoInitialSpendResult,
  BlockchainInboundAddressResult,
} from '../types/ChiaGaming';

import {
  blockchainConnector,
  BlockchainInboundReply,
  BlockchainOutboundRequest,
} from './BlockchainConnector';
import { blockchainDataEmitter } from './BlockchainInfo';
import { FAKE_BLOCKCHAIN_ID, fakeBlockchainInfo } from './FakeBlockchainInterface';
import { REAL_BLOCKCHAIN_ID, realBlockchainInfo } from './RealBlockchainInterface';
import { debugLog } from '../services/debugLog';

let requestNumber = 1;

function performTransaction<T>(
  checkReply: (reply: BlockchainInboundReply) => T | undefined | null,
  requestId: number,
  request: BlockchainOutboundRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const thisRequestChannel = blockchainConnector.getInbound().pipe(
      filter((e: BlockchainInboundReply) => e.responseId === requestId),
      take(1),
    );
    thisRequestChannel.subscribe({
      next: (e: BlockchainInboundReply) => {
        if (e.error) {
          console.error('returning error in transaction', e);
          debugLog(`[blockchain] request ${requestId} failed: ${String(e.error)}`);
          reject(e.error);
          return;
        }

        const replyObject = checkReply(e);
        if (replyObject === undefined || replyObject === null) {
          console.error('no reply in transaction', e);
          debugLog(`[blockchain] request ${requestId} returned no reply data`);
          reject(`no reply data in reply for request ${JSON.stringify(e)}`);
          return;
        }

        resolve(replyObject);
      },
    });

    blockchainConnector.requestEmitter(request);
  });
}

function performNullableTransaction(
  checkReply: (reply: any) => any,
  requestId: number,
  request: any,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const thisRequestChannel = blockchainConnector.getInbound().pipe(
      filter((e: BlockchainInboundReply) => e.responseId === requestId),
      take(1),
    );
    thisRequestChannel.subscribe({
      next: (e: BlockchainInboundReply) => {
        if (e.error) {
          debugLog(`[blockchain] request ${requestId} failed: ${String(e.error)}`);
          reject(e.error);
          return;
        }
        resolve(checkReply(e));
      },
    });
    blockchainConnector.requestEmitter(request);
  });
}

export class ChildFrameBlockchainInterface {
  do_initial_spend(
    uniqueId: string,
    target: string,
    amount: bigint,
  ): Promise<DoInitialSpendResult> {
    const requestId = requestNumber++;
    const request = {
      requestId,
      initialSpend: { uniqueId, target, amount },
    };

    return performTransaction((e) => e.initialSpend, requestId, request);
  }

  spend(cvt: (blob: string) => unknown, spend: string): Promise<string> {
    const requestId = requestNumber++;
    const request = {
      requestId,
      transaction: {
        blob: spend,
        spendObject: cvt(spend),
      },
    };

    return performTransaction((e) => e.transaction, requestId, request);
  }

  getAddress(): Promise<BlockchainInboundAddressResult> {
    const requestId = requestNumber++;
    const request = {
      requestId,
      getAddress: true as const,
    };

    return performTransaction((e) => e.getAddress, requestId, request);
  }

  getBalance(): Promise<number> {
    const requestId = requestNumber++;
    const request = {
      requestId,
      getBalance: true as const,
    };

    return performTransaction(
      (e) => e.getBalance,
      requestId,
      request,
    );
  }

  getPuzzleAndSolution(coin: string): Promise<string[] | null> {
    const requestId = requestNumber++;
    const request = { requestId, getPuzzleAndSolution: { coin } };
    return performTransaction((e) => e.getPuzzleAndSolution, requestId, request);
  }

  selectCoins(uniqueId: string, amount: number): Promise<string | null> {
    let requestId = requestNumber++;
    let request = {
      requestId,
      selectCoins: { uniqueId, amount },
    };
    return performNullableTransaction((e: any) => e.selectCoins, requestId, request);
  }

  getHeightInfo(): Promise<number> {
    let requestId = requestNumber++;
    let request = {
      requestId,
      getHeightInfo: {},
    };
    return performTransaction((e: any) => e.getHeightInfo, requestId, request);
  }

  createOfferForIds(
    uniqueId: string,
    offer: { [walletId: string]: number },
    extraConditions?: Array<{ opcode: number; args: string[] }>,
    coinIds?: string[],
    maxHeight?: number,
  ): Promise<any | null> {
    let requestId = requestNumber++;
    let request = {
      requestId,
      createOfferForIds: { uniqueId, offer, extraConditions, coinIds, maxHeight },
    };
    return performTransaction((e: any) => e.createOfferForIds, requestId, request);
  }

  getObservable() {
    return blockchainDataEmitter.getObservable();
  }

  registerCoin(coinName: string, coinString: string) {
    const sel = blockchainDataEmitter.selection;
    if (sel === FAKE_BLOCKCHAIN_ID) {
      fakeBlockchainInfo.registerCoin(coinName, coinString);
    } else if (sel === REAL_BLOCKCHAIN_ID) {
      realBlockchainInfo.registerCoin(coinName, coinString);
    }
  }
}
