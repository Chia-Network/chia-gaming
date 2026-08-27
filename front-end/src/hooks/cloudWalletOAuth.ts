import { CLOUD_WALLET_OAUTH_CALLBACK_PATH, CLOUD_WALLET_OAUTH_SCOPES } from '../constants/env';
import {
  getCloudWalletApiUrl,
  getCloudWalletClientId,
  getCloudWalletUiUrl,
} from './cloudWalletConfig';
import {
  clearOAuthPending,
  loadOAuthPending,
  saveOAuthPending,
  type CloudWalletAuthState,
} from './cloudWalletAuth';
import { log } from '../services/log';

export const OAUTH_MESSAGE_TYPE = 'chia-gaming/oauth';
export const SIGNATURE_REQUEST_MESSAGE_TYPE = 'chia-cloud-wallet/signature-request';
export const GAMING_CONSENT_MESSAGE_TYPE = 'chia-cloud-wallet/consent';

/** BLS G2 infinity / NIL aggregate signature (96 bytes). */
export const BLS_NIL_SIGNATURE =
  '0xc00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomUrlSafe(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function createPkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toBase64Url(digest);
}

export function oauthRedirectUri(origin = window.location.origin): string {
  return `${origin.replace(/\/$/, '')}${CLOUD_WALLET_OAUTH_CALLBACK_PATH}`;
}

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  apiBase?: string;
}): string {
  const apiBase = (opts.apiBase ?? getCloudWalletApiUrl()).replace(/\/$/, '');
  const url = new URL(`${apiBase}/authorize`);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('scope', opts.scope);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Ask the Cloud Wallet consent screen to post the selected walletId back to this opener.
  url.searchParams.set('chia_gaming_client', 'true');
  return url.toString();
}

export function signatureRequestApproveUrl(
  signatureRequestId: string,
  uiBase = getCloudWalletUiUrl(),
): string {
  const base = uiBase.replace(/\/$/, '');
  const id = signatureRequestId.startsWith('SignatureRequest_')
    ? signatureRequestId
    : signatureRequestId.includes(':') || signatureRequestId.includes('_')
      ? signatureRequestId
      : `SignatureRequest_${signatureRequestId}`;
  // Cloud Wallet route uses the Relay global id segment.
  return `${base}/signature-requests/${encodeURIComponent(id)}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const apiBase = getCloudWalletApiUrl().replace(/\/$/, '');
  const res = await fetch(`${apiBase}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Cloud Wallet token endpoint returned non-JSON (${res.status})`);
  }
  if (!res.ok || !json.access_token) {
    const msg =
      json.error_description ||
      json.error ||
      json.message ||
      `token exchange failed (${res.status})`;
    throw new Error(String(msg));
  }
  return json as TokenResponse;
}

export async function exchangeAuthorizationCode(opts: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId?: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const clientId = opts.clientId || getCloudWalletClientId();
  if (!clientId) {
    throw new Error('CLOUD_WALLET_CLIENT_ID is not configured');
  }
  const token = await postToken({
    grant_type: 'authorization_code',
    client_id: clientId,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
  if (!token.refresh_token) {
    throw new Error('Cloud Wallet token response missing refresh_token (request offline_access)');
  }
  const expiresIn = typeof token.expires_in === 'number' ? token.expires_in : 3600;
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId = getCloudWalletClientId(),
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}> {
  if (!clientId) {
    throw new Error('CLOUD_WALLET_CLIENT_ID is not configured');
  }
  const token = await postToken({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });
  const expiresIn = typeof token.expires_in === 'number' ? token.expires_in : 3600;
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export function openOAuthPopup(authorizeUrl: string): Window | null {
  const width = 480;
  const height = 720;
  const left = Math.max(0, Math.floor(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.floor(window.screenY + (window.outerHeight - height) / 2));
  return window.open(
    authorizeUrl,
    'chia-gaming-cloud-wallet-oauth',
    `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
  );
}

let warnedConsentOriginMismatch = false;

/** Log once (dev) when a consent-shaped message arrives from an unexpected origin. */
function warnConsentOriginMismatchOnce(actual: string, expected: string) {
  if (warnedConsentOriginMismatch) return;
  warnedConsentOriginMismatch = true;
  log(
    `[cloud-wallet] ignoring consent message from unexpected origin ${actual} (expected ${expected}); check CLOUD_WALLET_UI_URL`,
  );
}

/**
 * Wait for the Cloud Wallet consent screen to post the selected walletId to this opener.
 *
 * The consent message can race with the OAuth code redirect: Cloud Wallet may
 * post the walletId just before the popup navigates or closes. Rather than
 * resolving `undefined` the instant the popup closes (or the auth code arrives),
 * we start a short grace period and only give up if no consent message lands
 * within it. A late message during the grace period still resolves normally.
 *
 * Returns a handle so the caller can start the grace period once it has the auth
 * code (`notifyCodeReceived`), in addition to the popup-close trigger handled here.
 */
export function waitForGamingConsentWalletId(
  popup: Window | null,
  timeoutMs = 5 * 60 * 1000,
  graceMs = 700,
): { promise: Promise<string | undefined>; notifyCodeReceived: () => void } {
  let startGrace = () => {};
  const uiOrigin = new URL(getCloudWalletUiUrl()).origin;

  const promise = new Promise<string | undefined>((resolve) => {
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      clearInterval(closePoll);
      window.removeEventListener('message', onMessage);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => resolve(undefined));
    }, timeoutMs);

    startGrace = () => {
      if (settled || graceTimer) return;
      // Stop polling for popup close; a late consent message can still resolve
      // during the grace window via onMessage.
      clearInterval(closePoll);
      graceTimer = setTimeout(() => {
        finish(() => resolve(undefined));
      }, graceMs);
    };

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      const looksLikeConsent = !!data && data.type === GAMING_CONSENT_MESSAGE_TYPE;
      if (event.origin !== uiOrigin) {
        if (looksLikeConsent) warnConsentOriginMismatchOnce(event.origin, uiOrigin);
        return;
      }
      if (!looksLikeConsent) return;
      if (typeof data.walletId !== 'string') return;
      finish(() => resolve(data.walletId));
    };

    window.addEventListener('message', onMessage);

    const closePoll = setInterval(() => {
      if (popup && popup.closed) {
        startGrace();
      }
    }, 400);
  });

  return { promise, notifyCodeReceived: () => startGrace() };
}

/**
 * Wait for OAuth callback postMessage from /oauth/callback.
 *
 * The callback page posts the authorization code then auto-closes after a short
 * delay. Across windows (especially Electron IPC), `popup.closed` can become
 * true before the opener receives that message. Rather than rejecting the
 * instant the popup reports closed, we start a short grace period so a late
 * postMessage can still resolve — the same race the consent waiter already
 * covers.
 */
export function waitForOAuthCode(
  expectedState: string,
  popup: Window | null,
  timeoutMs = 5 * 60 * 1000,
  graceMs = 700,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      clearInterval(closePoll);
      window.removeEventListener('message', onMessage);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error('Cloud Wallet OAuth timed out')));
    }, timeoutMs);

    const startGrace = () => {
      if (settled || graceTimer) return;
      // Stop polling for popup close; a late code message can still resolve
      // during the grace window via onMessage.
      clearInterval(closePoll);
      graceTimer = setTimeout(() => {
        finish(() => reject(new Error('Cloud Wallet OAuth popup was closed')));
      }, graceMs);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.type !== OAUTH_MESSAGE_TYPE) return;
      if (typeof data.state === 'string' && data.state !== expectedState) return;
      if (data.error) {
        finish(() => reject(new Error(String(data.error))));
        return;
      }
      if (typeof data.code !== 'string' || !data.code) {
        finish(() => reject(new Error('OAuth callback missing authorization code')));
        return;
      }
      finish(() => resolve(data.code));
    };

    window.addEventListener('message', onMessage);

    const closePoll = setInterval(() => {
      if (popup && popup.closed) {
        startGrace();
      }
    }, 400);
  });
}

export async function beginOAuthPopupLogin(): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  walletId: string;
}> {
  const clientId = getCloudWalletClientId();
  if (!clientId) {
    throw new Error('CLOUD_WALLET_CLIENT_ID is not configured');
  }
  const state = randomUrlSafe(16);
  const codeVerifier = randomUrlSafe(32);
  const codeChallenge = await createPkceChallenge(codeVerifier);
  const redirectUri = oauthRedirectUri();
  saveOAuthPending({ state, codeVerifier, createdAtMs: Date.now() });

  const authorizeUrl = buildAuthorizeUrl({
    clientId,
    redirectUri,
    scope: CLOUD_WALLET_OAUTH_SCOPES,
    state,
    codeChallenge,
  });

  const popup = openOAuthPopup(authorizeUrl);
  if (!popup) {
    clearOAuthPending();
    throw new Error('Popup blocked — allow popups for Cloud Wallet login');
  }

  try {
    const consent = waitForGamingConsentWalletId(popup);
    const code = await waitForOAuthCode(state, popup);
    // Code is in hand; give any in-flight consent message a short grace period
    // rather than blocking on the full consent timeout.
    consent.notifyCodeReceived();
    const consentWalletId = await consent.promise;

    const tokens = await exchangeAuthorizationCode({
      code,
      codeVerifier,
      redirectUri,
    });

    let walletId: string;
    if (consentWalletId && consentWalletId !== '*') {
      // Concrete walletId from the consent screen (encode passes Wallet_* through).
      walletId = encodeRelayGlobalId('Wallet', consentWalletId);
    } else {
      // The consent screen was skipped (already consented) or granted a wildcard.
      // Resolve a concrete wallet from the grant; ids are already Wallet_<id>.
      const provider: TokenProvider = { getAccessToken: async () => tokens.accessToken };
      const resolved = await fetchFirstConsentedWalletId(provider);
      if (!resolved) {
        throw new Error(
          'Cloud Wallet returned no consented wallets. Grant access to a specific wallet during consent.',
        );
      }
      walletId = resolved;
    }

    try {
      popup.close();
    } catch {
      // ignore
    }
    return { ...tokens, walletId };
  } finally {
    clearOAuthPending();
  }
}

/** Handle /oauth/callback page: validate state and postMessage to opener. */
export function handleOAuthCallbackPage(): {
  status: 'ok' | 'error';
  message: string;
} {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  const errorDescription = params.get('error_description');
  const pending = loadOAuthPending();

  if (error) {
    const message = errorDescription || error;
    if (window.opener) {
      window.opener.postMessage(
        { type: OAUTH_MESSAGE_TYPE, error: message, state },
        window.location.origin,
      );
    }
    return { status: 'error', message };
  }

  if (!code || !state) {
    const message = 'Missing authorization code or state';
    if (window.opener) {
      window.opener.postMessage(
        { type: OAUTH_MESSAGE_TYPE, error: message, state },
        window.location.origin,
      );
    }
    return { status: 'error', message };
  }

  if (!pending || pending.state !== state) {
    const message = 'OAuth state mismatch — restart Cloud Wallet connect';
    if (window.opener) {
      window.opener.postMessage(
        { type: OAUTH_MESSAGE_TYPE, error: message, state },
        window.location.origin,
      );
    }
    return { status: 'error', message };
  }

  if (window.opener) {
    window.opener.postMessage({ type: OAUTH_MESSAGE_TYPE, code, state }, window.location.origin);
    return {
      status: 'ok',
      message: 'Login complete. You can close this window.',
    };
  }

  return {
    status: 'error',
    message: 'No opener window — open Cloud Wallet connect from the game.',
  };
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

export type TokenProvider = {
  getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string>;
};

export function createAuthTokenProvider(
  getState: () => CloudWalletAuthState | null,
  setState: (next: CloudWalletAuthState) => void,
): TokenProvider {
  let refreshPromise: Promise<string> | null = null;

  const doRefresh = async (state: CloudWalletAuthState): Promise<string> => {
    if (!refreshPromise) {
      refreshPromise = refreshAccessToken(state.refreshToken)
        .then((tokens) => {
          const next: CloudWalletAuthState = {
            ...state,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
          };
          setState(next);
          return tokens.accessToken;
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
    return refreshPromise;
  };

  return {
    async getAccessToken(opts) {
      const state = getState();
      if (!state) throw new Error('Cloud Wallet is not authenticated');
      if (!opts?.forceRefresh && Date.now() < state.expiresAt - 60_000) {
        return state.accessToken;
      }
      return doRefresh(state);
    },
  };
}

export async function graphqlRequest<T>(
  query: string,
  variables: Record<string, unknown> | undefined,
  tokenProvider: TokenProvider,
  apiBase = getCloudWalletApiUrl(),
): Promise<T> {
  const run = async (accessToken: string) => {
    const res = await fetch(`${apiBase.replace(/\/$/, '')}/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    return res;
  };

  let accessToken = await tokenProvider.getAccessToken();
  let res = await run(accessToken);

  if (res.status === 401) {
    accessToken = await tokenProvider.getAccessToken({ forceRefresh: true });
    res = await run(accessToken);
  }

  const text = await res.text();
  let payload: GraphQLResponse<T>;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Cloud Wallet GraphQL returned non-JSON (${res.status})`);
  }

  if (!res.ok || payload.errors?.length) {
    const msg =
      payload.errors
        ?.map((e) => e.message)
        .filter(Boolean)
        .join('; ') || `GraphQL request failed (${res.status})`;
    throw new Error(msg);
  }
  if (payload.data === undefined) {
    throw new Error('Cloud Wallet GraphQL response missing data');
  }
  return payload.data;
}

/**
 * Query the wallets this OAuth grant has consented to and return the first id.
 *
 * Cloud Wallet returns ids already in `Wallet_<id>` form, so callers must use
 * the value as-is (no `encodeRelayGlobalId`). Returns undefined when the grant
 * has no consented wallets.
 */
export async function fetchFirstConsentedWalletId(
  tokenProvider: TokenProvider,
): Promise<string | undefined> {
  const data = await graphqlRequest<{ oauthConsentedWallets: Array<{ id: string }> | null }>(
    `query OAuthConsentedWallets { oauthConsentedWallets { id } }`,
    undefined,
    tokenProvider,
  );
  return data.oauthConsentedWallets?.[0]?.id;
}

export function encodeRelayGlobalId(typename: string, id: string): string {
  // Cloud Wallet already emits global ids as `Typename_xxx` (e.g. Wallet_abc).
  // Pass those through untouched rather than re-encoding them as base64.
  if (id.startsWith(`${typename}_`)) return id;
  // Already a Relay id?
  if (id.includes(':') === false && /^[A-Za-z0-9+/=]+$/.test(id)) {
    try {
      const decoded = atob(id);
      if (decoded.startsWith(`${typename}:`)) return id;
    } catch {
      // fall through
    }
  }
  if (id.startsWith(`${typename}:`)) {
    return btoa(id);
  }
  return btoa(`${typename}:${id}`);
}

export function normalizeHex(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') {
    return value.trim().toLowerCase().replace(/^0x/, '');
  }
  if (
    typeof value === 'object' &&
    value &&
    (value as any).type === 'Buffer' &&
    Array.isArray((value as any).data)
  ) {
    return Array.from((value as any).data as number[], (b) =>
      (b & 0xff).toString(16).padStart(2, '0'),
    ).join('');
  }
  return String(value).toLowerCase().replace(/^0x/, '');
}

export function with0x(hex: string): string {
  const n = normalizeHex(hex);
  return n ? `0x${n}` : '0x';
}

export {
  getCloudWalletApiUrl,
  getCloudWalletClientId,
  getCloudWalletUiUrl,
} from './cloudWalletConfig';
