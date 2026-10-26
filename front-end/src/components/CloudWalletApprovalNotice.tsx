import { useEffect, useState, useSyncExternalStore } from 'react';

import { cloudBlockchainInfo } from '../lib/wallet/CloudBlockchainInterface';
import { Button } from './ui/button';

function subscribe(listener: () => void) {
  return cloudBlockchainInfo.onBlockedApprovalsChange(listener);
}

function snapshot() {
  return cloudBlockchainInfo.getBlockedApprovals();
}

export default function CloudWalletApprovalNotice() {
  const blocked = useSyncExternalStore(subscribe, snapshot);
  const [stillBlocked, setStillBlocked] = useState(false);
  const next = blocked[0];

  useEffect(() => setStillBlocked(false), [next?.signatureRequestId]);

  if (!next) return null;
  return (
    <div
      role="alert"
      className="flex w-full flex-wrap items-center gap-3 border-b border-canvas-border bg-canvas-bg-subtle px-4 py-2 text-sm text-alert-text"
    >
      <p className="min-w-0 flex-1">
        {stillBlocked
          ? 'The approval window is still blocked. Allow pop-ups for this site in your browser, then try again.'
          : next.reason === 'closed'
            ? `The Cloud Wallet approval window for the ${next.source} was closed before it finished. Open it again to continue.`
            : `Your browser blocked the Cloud Wallet approval window for the ${next.source}. Allow pop-ups for this site, then open it to continue.`}
      </p>
      <Button
        size="sm"
        onClick={() => setStillBlocked(!cloudBlockchainInfo.openBlockedApproval())}
      >
        Open approval
      </Button>
    </div>
  );
}
