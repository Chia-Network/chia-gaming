import { WasmInitFn, WasmConnection } from './types/ChiaGaming';

declare global {
  interface Window {
    loadWasm?: (init: WasmInitFn, cg: WasmConnection) => void;
    __chiaDistribution?: string;
    /** Exposed by the desktop preload in the top-level frame only. */
    __chiaHub?: {
      requestTrust: (
        origin: string,
      ) => Promise<'trusted' | 'granted' | 'invalid' | 'persist-failed'>;
    };
    /**
     * Exposed by the desktop preload in the top-level frame only: Cloud Wallet
     * sign-in and approval in the system browser, and token requests from main.
     */
    __chiaCloudWallet?: {
      beginBrowserLogin(): Promise<{ flowId: string; redirectUri: string } | null>;
      completeBrowserLogin(
        flowId: string,
        authorizeUrl: string,
      ): Promise<{ code: string; state: string } | { error: string }>;
      cancelBrowserLogin(flowId: string): Promise<void>;
      openInBrowser(url: string): Promise<boolean>;
      postToken(
        tokenUrl: string,
        body: string,
      ): Promise<{ status: number; text: string } | { transportError: string }>;
    };
  }
}
