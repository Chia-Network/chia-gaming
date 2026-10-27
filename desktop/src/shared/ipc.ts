/**
 * IPC channel names, shared by the main process and the preload so they cannot
 * drift between them. This one asks the user to allow a hub origin.
 */
export const HUB_TRUST_CHANNEL = 'chia-gaming:request-hub-trust';

/**
 * - `trusted`  already on the allowlist; connect straight away.
 * - `granted`  just added to it; the renderer must reload to pick up the widened
 *              CSP before the hub becomes reachable.
 * - `invalid`  malformed origin, or a request from somewhere that may not ask.
 * - `persist-failed` valid origin that could not be saved for the required reload.
 */
export type HubTrustOutcome = 'trusted' | 'granted' | 'invalid' | 'persist-failed';

/**
 * Cloud Wallet passkeys need the system browser, which Electron cannot stand in
 * for. Begin binds a loopback OAuth callback and returns its redirect URI.
 */
export const CLOUD_WALLET_BEGIN_LOGIN_CHANNEL = 'chia-gaming:cloud-wallet-begin-login';

/** Opens the authorize URL in the system browser and waits for the callback. */
export const CLOUD_WALLET_COMPLETE_LOGIN_CHANNEL = 'chia-gaming:cloud-wallet-complete-login';

/** Ends a pending sign-in, e.g. when the user cancels in the app. */
export const CLOUD_WALLET_CANCEL_LOGIN_CHANNEL = 'chia-gaming:cloud-wallet-cancel-login';

/** Opens a Cloud Wallet page (signature approval) in the system browser. */
export const CLOUD_WALLET_OPEN_CHANNEL = 'chia-gaming:cloud-wallet-open';

export type CloudWalletLoginFlow = { flowId: string; redirectUri: string };

export type CloudWalletLoginResult = { code: string; state: string } | { error: string };

/**
 * Token requests (code exchange, refresh) from main: the token endpoint only
 * allows CORS from http(s) client origins, and the player runs on `chiagaming:`.
 */
export const CLOUD_WALLET_TOKEN_CHANNEL = 'chia-gaming:cloud-wallet-token';

export type CloudWalletTokenResponse =
  | { status: number; text: string }
  | { transportError: string };
