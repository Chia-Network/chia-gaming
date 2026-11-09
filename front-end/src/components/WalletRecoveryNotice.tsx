import { useEffect, useState } from 'react';

import type { WalletView } from '../lib/wallet/WalletConnection';

export default function WalletRecoveryNotice({ notice }: { notice: WalletView['recoveryNotice'] }) {
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) setDismissedKey(null);
  }, [notice]);

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
