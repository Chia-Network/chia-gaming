import { Subject } from 'rxjs';
import { DoInitialSpendResult } from '../types/ChiaGaming';
import { blockchainDataEmitter } from './BlockchainInfo';
import { blockchainConnector, BlockchainInboundReply, BlockchainOutboundRequest } from './BlockchainConnector';
import { fakeBlockchainInfo } from './FakeBlockchainInterface';

let requestNumber = 1;

function performTransaction(
  checkReply: (reply: any) => any,
  requestId: number,
  request: any
): Promise<any> {
  return new Promise((resolve, reject) => {
    let subscription = blockchainConnector.getInbound().subscribe({
      next: (e: BlockchainInboundReply) => {
        if (e.responseId !== requestId) {
          return;
        }

        try {
            subscription.unsubscribe();
        } catch (err) {
            console.error('child rpc error unsubscribing', e, err);
        }

        if (e.error) {
          console.error('returning error in transaction', e);
          reject(e.error);
          return;
        }

        const replyObject = checkReply(e);
        if (replyObject === undefined || replyObject === null) {
          console.error('no reply in transaction', e);
          reject(`no reply data in reply for request ${JSON.stringify(e)}`);
          return;
        }

        resolve(replyObject);
      }
    });

    blockchainConnector.requestEmitter(request);
  });
}

export class ChildFrameBlockchainInterface {
  do_initial_spend(uniqueId: string, target: string, amount: number): Promise<DoInitialSpendResult> {
    let requestId = requestNumber++;
    let request = {
      requestId,
      initialSpend: { uniqueId, target, amount }
    };

    return performTransaction(
      (e: any) => e.initialSpend,
      requestId,
      request
    );
}

  spend(cvt: (blob: string) => any, spend: string): Promise<string> {
    let requestId = requestNumber++;
    let request = {
      requestId,
      transaction: {
        blob: spend,
        spendObject: cvt(spend)
      }
    };

    return performTransaction(
      (e: any) => e.transaction,
      requestId,
      request
    );
  }

  getObservable() {
    return blockchainDataEmitter.getObservable();
  }
}
