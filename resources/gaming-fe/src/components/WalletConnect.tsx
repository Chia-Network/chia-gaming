import { Info } from 'lucide-react';
import {
  StartConnectResult,
  walletConnectState,
} from '../hooks/useWalletConnect';
import { QRCodeModal } from './QRCodeModal';

import { Button } from './button';
interface ShowWalletConnectState {
  initialized: boolean;
  haveClient: boolean;
  haveSession: boolean;
  sessions: number;
  showQRModal: boolean;
  connectionUri: string | undefined;
  onConnect: () => void;
  dismiss: () => void;
}

export const WalletConnectDialog: React.FC<ShowWalletConnectState> = ({
  initialized,
  haveClient,
  haveSession,
  sessions,
  showQRModal,
  connectionUri,
  onConnect,
  dismiss,
}) => {
  return (
    <div className='px-2 sm:px-3 max-w-full sm:max-w-[400px] md:max-w-[480px] lg:max-w-full mx-auto'>
      <QRCodeModal open={showQRModal} uri={connectionUri} onClose={dismiss} />

      {!initialized ? (
        <div className='flex flex-col gap-2 sm:gap-3'>
          <h5 className='text-[1.2rem] sm:text-[1.5rem] font-semibold'>
            Initializing WalletConnect...
          </h5>
          <p className='mt-2 text-base'>
            Please wait while we set up the connection.
          </p>
        </div>
      ) : !haveClient ? (
        <div className='flex flex-col gap-2 sm:gap-3'>
          <h5 className='text-[1.2rem] sm:text-[1.5rem] font-semibold text-(--color-alert-text)'>
            WalletConnect Failed to Initialize
          </h5>
          <p className='mt-2'>
            Please check your environment configuration and try refreshing the
            page.
          </p>
          <p className='mt-1 text-[0.85rem] text-(--color-canvas-text)'>
            Make sure you have a .env file with VITE_PROJECT_ID, VITE_RELAY_URL,
            and VITE_CHAIN_ID.
          </p>
        </div>
      ) : !haveSession ? (
        <div className='flex flex-col gap-2 sm:gap-3'>
          <div className='flex md:flex-row flex-col justify-between gap-2 mt-4'>
            <Button onClick={onConnect} variant={'solid'} color={'secondary'} fullWidth>
              Link Wallet
            </Button>

            <Button
              variant={'destructive'}
              fullWidth
              onClick={() => {
                localStorage.clear();
                window.location.href = '';
              }}
            >
              Reset Storage
            </Button>
          </div>

          <div className='bg-(--color-info-bg-subtle) rounded-lg p-4 flex gap-2 mt-3 text-(--color-info-text-contrast)'>
            <div className='p-1 bg-(--color-info-bg) rounded-full shrink-0 flex items-center justify-center h-fit'>
              <Info
                style={{ color: 'var(--color-info-solid)', fontSize: '1.25rem' }}
              />
            </div>
            <div>
              <p className='mt-2 text-[0.95rem]'>
                Before you can test out WalletConnect, you need to link your
                Chia wallet. Download the latest wallet from the{' '}
                <a
                  className='text-(--color-info-solid) underline hover:text-(--color-info-solid-hover) transition-colors'
                  href='https://www.chia.net/downloads'
                  target='_blank'
                  rel='noopener'
                >
                  official download page
                </a>
                .
              </p>

              <p className='mt-2 text-base'>
                Once the wallet is synced, use the WalletConnect menu on the top
                right to link it to this site. Then click the button below to
                begin.
              </p>
              {!haveSession && haveClient && (
                <p className='mt-1 text-[0.9rem]'>
                  Ready to connect. Click "Link Wallet" to start.
                </p>
              )}
            </div>
          </div>

          {haveClient && (
            <p className='mt-1 text-[0.85rem] text-(--color-canvas-text)'>
              Client Status: {haveClient ? 'Ready' : 'Not Ready'} | Sessions:{' '}
              {sessions} | Connected: {haveSession ? 'Yes' : 'No'}
            </p>
          )}
        </div>
      ) : (
        <div />
      )}
    </div>
  );
};

export const doConnectWallet = (
  setShowQRModal: (s: boolean) => void,
  setConnectionUri: (s: string) => void,
  _startConnect: () => Promise<StartConnectResult>,
  setComplete: () => void,
  signalError: (s: string) => void,
) => {
  setShowQRModal(true);
  walletConnectState
    .startConnect()
    .then((result) => {
      setConnectionUri(result.uri);
      return walletConnectState.connect(result.approval);
    })
    .then(() => {
      setShowQRModal(false);
      setComplete();
    })
    .catch((e) => signalError(e.toString()));
};
