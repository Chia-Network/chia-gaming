import {
  StartConnectResult,
  walletConnectState,
} from '../hooks/useWalletConnect';
import { QRCodeModal } from './QRCodeModal';
import { InfoRounded } from '@mui/icons-material';

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
    <div className="px-2 sm:px-3 max-w-full sm:max-w-[400px] md:max-w-[480px] lg:max-w-full mx-auto">
      <QRCodeModal open={showQRModal} uri={connectionUri} onClose={dismiss} />

      {!initialized ? (
        <div className="flex flex-col gap-2 sm:gap-3">
          <h5 className="text-[1.2rem] sm:text-[1.5rem] font-semibold">
            Initializing WalletConnect...
          </h5>
          <p className="mt-2 text-[0.95rem]">
            Please wait while we set up the connection.
          </p>
        </div>
      ) : !haveClient ? (
        <div className="flex flex-col gap-2 sm:gap-3">
          <h5 className="text-[1.2rem] sm:text-[1.5rem] font-semibold text-(--color-alert-text)">
            WalletConnect Failed to Initialize
          </h5>
          <p className="mt-2">
            Please check your environment configuration and try refreshing the
            page.
          </p>
          <p className="mt-1 text-[0.85rem] text-(--color-canvas-text)">
            Make sure you have a .env file with VITE_PROJECT_ID, VITE_RELAY_URL,
            and VITE_CHAIN_ID.
          </p>
        </div>
      ) : !haveSession ? (
        <div className="flex flex-col gap-2 sm:gap-3">
          <div className="flex md:flex-row flex-col justify-between gap-2 mt-4">
            <button
              onClick={onConnect}
              className="md:w-full w-auto bg-(--color-secondary-solid) text-(--color-secondary-on-secondary) p-4 font-semibold tracking-wider uppercase rounded-md py-[1.2em] shadow-[0px_4px_8px_rgba(66,79,109,0.85)] hover:bg-(--color-secondary-solid-hover) hover:shadow-[0px_6px_12px_rgba(66,79,109,0.35)] transition-all"
            >
              Link Wallet
            </button>

            <button
              onClick={() => {
                localStorage.clear();
                window.location.href = '';
              }}
              className="md:w-full w-auto border-2 border-(--color-alert-border) text-(--color-alert-text) p-4 font-semibold shadow-[0px_4px_8px_rgba(66,79,109,0.85)] rounded-md hover:bg-(--color-alert-bg-hover) transition-all"
            >
              Reset Storage
            </button>
          </div>

          <div className="bg-(--color-secondary-bg-subtle) rounded-lg p-4 flex gap-2 mt-3 text-(--color-canvas-text-contrast)">
            <div className="p-1 bg-(--color-secondary-bg) rounded-full shrink-0 flex items-center justify-center h-fit">
              <InfoRounded sx={{ color: 'var(--color-secondary-solid)', fontSize: '1.25rem' }} />
            </div>
            <div>
              <p className="mt-2 text-[0.95rem]">
                Before you can test out WalletConnect, you need to link your
                Chia wallet. Download the latest wallet from the{' '}
                <a
                  className="text-(--color-secondary-text) underline hover:text-(--color-secondary-text-contrast) transition-colors"
                  href="https://www.chia.net/downloads"
                  target="_blank"
                  rel="noopener"
                >
                  official download page
                </a>
                .
              </p>

              <p className="mt-2 text-[0.95rem]">
                Once the wallet is synced, use the WalletConnect menu on the top
                right to link it to this site. Then click the button below to
                begin.
              </p>
              {!haveSession && haveClient && (
                <p className="mt-1 text-[0.9rem]">
                  Ready to connect. Click "Link Wallet" to start.
                </p>
              )}
            </div>
          </div>

          {haveClient && (
            <p className="mt-1 text-[0.85rem] text-(--color-canvas-text)">
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
