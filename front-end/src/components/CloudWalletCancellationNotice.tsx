import { useSyncExternalStore } from 'react';

import { cloudBlockchainInfo } from '../lib/wallet/CloudBlockchainInterface';
import { Button } from './button';

function subscribe(listener: () => void) {
  return cloudBlockchainInfo.onRefusedCancellationsChange(listener);
}

function snapshot() {
  return cloudBlockchainInfo.getRefusedCancellations();
}

export default function CloudWalletCancellationNotice() {
  const next = useSyncExternalStore(subscribe, snapshot)[0];

  if (!next) return null;
  return (
    <div
      role="alert"
      className="flex w-full flex-wrap items-center gap-3 border-b border-canvas-border bg-canvas-bg-subtle px-4 py-2 text-sm text-alert-text"
    >
      <p className="min-w-0 flex-1 break-words">
        {`Cloud Wallet would not cancel offer ${next.offerId}, so its coins stay reserved. Cloud Wallet said: ${next.detail}. Cancel the offer in Cloud Wallet to release them.`}
      </p>
      <Button
        variant="outline"
        color="neutral"
        size="sm"
        aria-label="Dismiss refused cancellation"
        onClick={() => cloudBlockchainInfo.dismissRefusedCancellation(next.offerId)}
      >
        Dismiss
      </Button>
    </div>
  );
}
