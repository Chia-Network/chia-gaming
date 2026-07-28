import {
  CLOUD_WALLET_API_URL,
  CLOUD_WALLET_CLIENT_ID,
  CLOUD_WALLET_OAUTH_CALLBACK_PATH,
  CLOUD_WALLET_OAUTH_SCOPES,
  CLOUD_WALLET_UI_URL,
} from '../constants/env';
import {
  clearOAuthPending,
  loadOAuthPending,
  saveOAuthPending,
  type CloudWalletAuthState,
} from './cloudWalletAuth';

export const OAUTH_MESSAGE_TYPE = 'chia-gaming/oauth';
export const SIGNATURE_REQUEST_MESSAGE_TYPE = 'chia-cloud-wallet/signature-request';

/** BLS G2 infinity / NIL aggregate signature (96 bytes). */
export const BLS_NIL_SIGNATURE =
  '0xc0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

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
  const apiBase = (opts.apiBase ?? CLOUD_WALLET_API_URL).replace(/\/$/, '');
  const url = new URL(`${apiBase}/authorize`);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('scope', opts.scope);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export function signatureRequestApproveUrl(signatureRequestId: string, uiBase = CLOUD_WALLET_UI_URL): string {
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
  const apiBase = CLOUD_WALLET_API_URL.replace(/\/$/, '');
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
    const msg = json.error_description || json.error || json.message || `token exchange failed (${res.status})`;
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
  const clientId = opts.clientId || CLOUD_WALLET_CLIENT_ID;
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

export async function refreshAccessToken(refreshToken: string, clientId = CLOUD_WALLET_CLIENT_ID): Promise<{
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

/** Wait for OAuth callback postMessage from /oauth/callback. */
export function waitForOAuthCode(expectedState: string, popup: Window | null, timeoutMs = 5 * 60 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(closePoll);
      window.removeEventListener('message', onMessage);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error('Cloud Wallet OAuth timed out')));
    }, timeoutMs);

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
        finish(() => reject(new Error('Cloud Wallet OAuth popup was closed')));
      }
    }, 400);
  });
}

export async function beginOAuthPopupLogin(): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}> {
  if (!CLOUD_WALLET_CLIENT_ID) {
    throw new Error('CLOUD_WALLET_CLIENT_ID is not configured');
  }
  const state = randomUrlSafe(16);
  const codeVerifier = randomUrlSafe(32);
  const codeChallenge = await createPkceChallenge(codeVerifier);
  const redirectUri = oauthRedirectUri();
  saveOAuthPending({ state, codeVerifier, createdAtMs: Date.now() });

  const authorizeUrl = buildAuthorizeUrl({
    clientId: CLOUD_WALLET_CLIENT_ID,
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
    const code = await waitForOAuthCode(state, popup);
    const tokens = await exchangeAuthorizationCode({ code, codeVerifier, redirectUri });
    try {
      popup.close();
    } catch {
      // ignore
    }
    return tokens;
  } finally {
    clearOAuthPending();
  }
}

/** Handle /oauth/callback page: validate state and postMessage to opener. */
export function handleOAuthCallbackPage(): { status: 'ok' | 'error'; message: string } {
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
      window.opener.postMessage({ type: OAUTH_MESSAGE_TYPE, error: message, state }, window.location.origin);
    }
    return { status: 'error', message };
  }

  if (!pending || pending.state !== state) {
    const message = 'OAuth state mismatch — restart Cloud Wallet connect';
    if (window.opener) {
      window.opener.postMessage({ type: OAUTH_MESSAGE_TYPE, error: message, state }, window.location.origin);
    }
    return { status: 'error', message };
  }

  if (window.opener) {
    window.opener.postMessage({ type: OAUTH_MESSAGE_TYPE, code, state }, window.location.origin);
    return { status: 'ok', message: 'Login complete. You can close this window.' };
  }

  return { status: 'error', message: 'No opener window — open Cloud Wallet connect from the game.' };
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
  apiBase = CLOUD_WALLET_API_URL,
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
    const msg = payload.errors?.map((e) => e.message).filter(Boolean).join('; ')
      || `GraphQL request failed (${res.status})`;
    throw new Error(msg);
  }
  if (payload.data === undefined) {
    throw new Error('Cloud Wallet GraphQL response missing data');
  }
  return payload.data;
}

export function encodeRelayGlobalId(typename: string, id: string): string {
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
  if (typeof value === 'object' && value && (value as any).type === 'Buffer' && Array.isArray((value as any).data)) {
    return Array.from((value as any).data as number[], (b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
  }
  return String(value).toLowerCase().replace(/^0x/, '');
}

export function with0x(hex: string): string {
  const n = normalizeHex(hex);
  return n ? `0x${n}` : '0x';
}

export { CLOUD_WALLET_UI_URL, CLOUD_WALLET_API_URL, CLOUD_WALLET_CLIENT_ID };
