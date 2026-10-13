import { useEffect, useState } from 'react';

import { channelFundingRuntime } from '../lib/session/channelFundingRuntime';
import { walletRecoveryNotice } from '../lib/session/channelFundingSelectors';
import { storageRepository } from '../lib/session/storageRepository';

function readNotice() {
  return walletRecoveryNotice(
    [...storageRepository.channelFundingOperations(), ...storageRepository.feeAttachments()],
    channelFundingRuntime.providerScopeKeys(),
  );
}

export default function WalletRecoveryNotice() {
  const [notice, setNotice] = useState(readNotice);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => {
      const next = readNotice();
      setNotice((previous) =>
        previous?.key === next?.key && previous?.message === next?.message ? previous : next,
      );
      if (!next) setDismissedKey(null);
    };
    const unsubscribeOperations = storageRepository.onWalletOperationsChange(refresh);
    const unsubscribeProviders = channelFundingRuntime.subscribe(refresh);
    const unsubscribeLifecycle = storageRepository.onLifecycle(refresh);
    refresh();
    return () => {
      unsubscribeOperations();
      unsubscribeProviders();
      unsubscribeLifecycle();
    };
  }, []);

  if (!notice || notice.key === dismissedKey) return null;
  return (
    <div
      role="status"
      className="mb-4 flex w-full max-w-md items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-900 dark:text-amber-200"
    >
      <p className="flex-1">{notice.message}</p>
      <button
        type="button"
        className="shrink-0 underline"
        aria-label="Dismiss wallet cleanup notice"
        onClick={() => setDismissedKey(notice.key)}
      >
        Dismiss
      </button>
    </div>
  );
}
