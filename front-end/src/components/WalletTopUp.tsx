import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';

import { getCurrencyLabels } from '../constants/currency';
import { desktopCloudWalletBridge } from '../hooks/cloudWalletOAuth';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { WalletTopUpOptions } from '../types/ChiaGaming';
import { Button } from './button';

const BUY_ORDER_MESSAGE_TYPE = 'chia-cloud-wallet/buy-order';

/**
 * Mojos the wallet is short of funding `buyIn` plus the opening `fee`, or 0n
 * when it is enough. An unknown balance is never reported as short.
 */
export function fundingShortfall(balance: bigint | undefined, buyIn: string, fee: bigint): bigint {
  if (balance === undefined) return 0n;
  const needed = BigInt(buyIn) + fee;
  return balance < needed ? needed - balance : 0n;
}

/**
 * True for the purchase page's "order placed" message from the popup this
 * window opened. Any other window can post messages here, so both the sender
 * origin and the sending window must match.
 */
export function isBuyOrderSubmitted(
  event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  buyOrigin: string,
  popup: Window | null,
): boolean {
  if (popup === null || event.source !== popup || event.origin !== buyOrigin) return false;
  const data: unknown = event.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === BUY_ORDER_MESSAGE_TYPE &&
    (data as { status?: unknown }).status === 'submitted'
  );
}

function formatXch(mojos: bigint): string {
  const s = mojos.toString().padStart(13, '0');
  const whole = s.slice(0, -12).replace(/^0+/, '') || '0';
  const frac = s.slice(-12).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

// Sized for the purchase wizard; the sign-in and approval popups are narrower.
function openBuyPopup(url: string): Window | null {
  const width = 1000;
  const height = 800;
  const left = Math.max(0, Math.floor(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.floor(window.screenY + (window.outerHeight - height) / 2));
  return window.open(
    url,
    'chia-gaming-cloud-wallet-buy',
    `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
  );
}

type BuyState = 'idle' | 'in-browser' | 'placed' | 'popup-blocked' | 'browser-failed';

export type WalletTopUpProps = {
  options: WalletTopUpOptions | null;
  /** Mojos still needed; 0n renders the plain top-up actions. */
  shortfall: bigint;
};

export function WalletTopUp(props: WalletTopUpProps) {
  const { options, shortfall } = props;
  const currency = getCurrencyLabels();
  const [showDeposit, setShowDeposit] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [buyState, setBuyState] = useState<BuyState>('idle');
  const popupRef = useRef<Window | null>(null);
  const { state: copyState, copy } = useCopyToClipboard();
  const depositAddress = options?.depositAddress ?? null;
  const buyUrl = options?.buyUrl ?? null;

  useEffect(() => {
    if (!buyUrl) return;
    const buyOrigin = new URL(buyUrl).origin;
    const onMessage = (event: MessageEvent) => {
      if (isBuyOrderSubmitted(event, buyOrigin, popupRef.current)) setBuyState('placed');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [buyUrl]);

  useEffect(() => {
    if (!showDeposit || !depositAddress) {
      setQrDataUrl('');
      return;
    }
    let cancelled = false;
    const darkNow = document.documentElement.classList.contains('dark');
    QRCode.toDataURL(depositAddress, {
      width: 180,
      margin: 2,
      color: { dark: darkNow ? '#FFFFFF' : '#000000', light: darkNow ? '#121212' : '#FFFFFF' },
      errorCorrectionLevel: 'M' as const,
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      // The address stays visible and copyable without the QR image.
      .catch((err: unknown) => console.error('[WalletTopUp] QR generation failed', err));
    return () => {
      cancelled = true;
    };
  }, [showDeposit, depositAddress]);

  const openBuy = async (url: string) => {
    // Desktop has no popups and no passkeys, so the purchase runs in the
    // system browser and only the balance poll reports the result.
    const desktop = desktopCloudWalletBridge();
    if (desktop) {
      try {
        setBuyState((await desktop.openInBrowser(url)) ? 'in-browser' : 'browser-failed');
      } catch (err) {
        console.error('[WalletTopUp] opening the browser failed', err);
        setBuyState('browser-failed');
      }
      return;
    }
    const popup = openBuyPopup(url);
    popupRef.current = popup;
    setBuyState(popup ? 'idle' : 'popup-blocked');
  };

  if (!buyUrl && !depositAddress) {
    return shortfall > 0n ? (
      <p className="text-sm text-alert-text">
        Add {formatXch(shortfall)} {currency.xch} to your wallet to play.
      </p>
    ) : null;
  }

  return (
    <div className="flex flex-col items-center gap-3 w-full">
      {shortfall > 0n && (
        <p className="text-sm text-canvas-text-contrast">
          You need{' '}
          <strong>
            {formatXch(shortfall)} {currency.xch}
          </strong>{' '}
          more to play.
        </p>
      )}
      <div className="flex gap-2 justify-center">
        {buyUrl && (
          <Button variant="solid" color="primary" size="sm" onClick={() => void openBuy(buyUrl)}>
            Buy {currency.xch}
          </Button>
        )}
        {depositAddress && (
          <Button
            variant="outline"
            color="neutral"
            size="sm"
            aria-expanded={showDeposit}
            onClick={() => setShowDeposit((v) => !v)}
          >
            Deposit
          </Button>
        )}
      </div>
      {buyState === 'placed' && (
        <p className="text-sm text-canvas-text-contrast">
          Purchase placed. Your balance updates when the {currency.xch} becomes available.
        </p>
      )}
      {buyState === 'in-browser' && (
        <p className="text-sm text-canvas-text">
          Finish the purchase in your browser. Your balance updates when the {currency.xch} becomes
          available.
        </p>
      )}
      {buyState === 'popup-blocked' && (
        <p className="text-sm text-alert-text">
          Your browser blocked the Cloud Wallet window. Allow popups for this site and try again.
        </p>
      )}
      {buyState === 'browser-failed' && (
        <p className="text-sm text-alert-text">Could not open your browser. Try again.</p>
      )}
      {showDeposit && depositAddress && (
        <div className="flex flex-col items-center gap-2 w-full">
          {qrDataUrl && (
            <img src={qrDataUrl} alt="Deposit address QR code" width={180} height={180} />
          )}
          <code className="text-xs break-all text-canvas-text">{depositAddress}</code>
          <Button
            variant="outline"
            color="neutral"
            size="sm"
            onClick={() => void copy(depositAddress)}
          >
            {copyState === 'copied'
              ? 'Copied'
              : copyState === 'failed'
                ? 'Copy failed'
                : 'Copy address'}
          </Button>
        </div>
      )}
      {shortfall > 0n && (
        <p className="text-xs text-canvas-text">
          This updates automatically when the funds arrive.
        </p>
      )}
    </div>
  );
}
