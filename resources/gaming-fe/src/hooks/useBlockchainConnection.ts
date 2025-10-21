import { blockchainConnector } from './BlockchainConnector';
import { blockchainDataEmitter } from './BlockchainInfo';
import {
  PARENT_FRAME_BLOCKCHAIN_ID,
  parentFrameBlockchainInfo,
} from './ParentFrameBlockchainInfo';

// This lives in the child frame.
export function setupBlockchainConnection(uniqueId: string) {
  // We'll connect the required signals.
  window.addEventListener('message', (evt: any) => {
    const key = evt.message ? 'message' : 'data';
    const data = evt[key];
    if (data.blockchain_reply) {
      if (
        evt.origin != window.location.origin &&
        !data.blockchain_reply.getBalance
      ) {
        throw new Error(`wrong origin for child event: ${JSON.stringify(evt)}`);
      }
      blockchainConnector.getInbound().next(data.blockchain_reply);
    }

    if (data.blockchain_info) {
      if (evt.origin != window.location.origin) {
        throw new Error(`wrong origin for child event: ${JSON.stringify(evt)}`);
      }
      parentFrameBlockchainInfo.next(data.blockchain_info);
    }
  });

  blockchainConnector.getOutbound().subscribe({
    next: (evt: any) => {
      window.parent.postMessage(
        {
          blockchain_request: evt,
        },
        window.location.origin,
      );
    },
  });
  blockchainDataEmitter.select({
    selection: PARENT_FRAME_BLOCKCHAIN_ID,
    uniqueId,
  });
}
