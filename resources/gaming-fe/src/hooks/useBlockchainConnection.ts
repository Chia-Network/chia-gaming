import { blockchainConnector } from './BlockchainConnector';
import { blockchainDataEmitter } from './BlockchainInfo';
import {
  PARENT_FRAME_BLOCKCHAIN_ID,
  parentFrameBlockchainInfo,
} from './ParentFrameBlockchainInfo';
import { blobSingleton } from './blobSingleton';

// This lives in the child frame.
export function setupBlockchainConnection(uniqueId: string) {
  // We'll connect the required signals.
  const windowListener = (evt: any) => {
    const key = evt.message ? 'message' : 'data';
    const data = evt[key];
    if (data.blockchain_reply) {
      if (evt.origin !== window.location.origin) {
        if (data.blockchain_reply.getBalance) {
          // This origin should be in the list of games that's advertising to us.
          fetch('/lobby/tracking').then(res => res.json()).then((tracking) => {
            const matchingTracked = tracking.map((t: string) => {
              const u = new URL(t);
              return u.origin == evt.origin;
            });
            if (matchingTracked.length !== 0) {
              blockchainConnector.getInbound().next(data.blockchain_reply);
            }
          });

          return;
        } else if (data.type === 'walletBalance') {
            blobSingleton.setGameConnectionState("starting", ["Blockchain up. Got Wallet Balance. Getting address ..."],
              [
                {id: "blockchain", long_name: "Blockchain", initialized: true},
                {id: "get_address", long_name: "Get Address", initialized: false}
              ]
            );
        }

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
  };

  window.addEventListener('message', windowListener);

  const connectorSubscription = blockchainConnector.getOutbound().subscribe({
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

  return () => {
    window.removeEventListener('message', windowListener);
    connectorSubscription.unsubscribe();
  };
}
