import http from 'node:http';

/** Outcome of one browser login, as reported by the authorization server's redirect. */
export type LoopbackCallbackResult = { code: string; state: string } | { error: string };

export type LoopbackCallback = {
  /** `http://127.0.0.1:<port>/oauth/callback`, bound for this one login. */
  redirectUri: string;
  /** Settles with the first callback, or with an error on timeout or close. */
  result: Promise<LoopbackCallbackResult>;
  close: () => void;
};

const CALLBACK_PATH = '/oauth/callback';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family:-apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;text-align:center"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`;
}

/** Read the authorization response from a request to the loopback callback. */
export function parseCallbackRequest(requestUrl: string): LoopbackCallbackResult | null {
  const url = new URL(requestUrl, 'http://127.0.0.1');
  if (url.pathname !== CALLBACK_PATH) return null;
  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description');
    return { error: description ? `${error}: ${description}` : error };
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return { error: 'Missing authorization code or state' };
  return { code, state };
}

/**
 * True when `authorizeUrl` is on an allowed Cloud Wallet origin and redirects
 * back to exactly this login's loopback callback.
 */
export function isAuthorizeUrlForCallback(
  authorizeUrl: string,
  redirectUri: string,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  let url: URL;
  try {
    url = new URL(authorizeUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    allowedOrigins.has(url.origin) &&
    url.searchParams.get('redirect_uri') === redirectUri
  );
}

/**
 * Listen on an ephemeral 127.0.0.1 port for one OAuth redirect (RFC 8252
 * §7.3). The authorization server accepts any loopback port for a client that
 * registered `http://127.0.0.1/oauth/callback`. The listener serves a single
 * callback and then closes.
 */
export async function startLoopbackCallback(
  timeoutMs: number,
  onCallback: () => void = () => {},
): Promise<LoopbackCallback> {
  let settle: (result: LoopbackCallbackResult) => void = () => {};
  const result = new Promise<LoopbackCallbackResult>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const server = http.createServer((request, response) => {
    const callback = parseCallbackRequest(request.url ?? '/');
    if (request.method !== 'GET' || callback === null || settled) {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ok = !('error' in callback);
    response
      .writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(
        ok
          ? page('Signed in to Cloud Wallet', 'You can close this tab and return to Chia Gaming.')
          : page('Cloud Wallet sign-in failed', callback.error),
      );
    finish(callback);
    onCallback();
  });

  const timer = setTimeout(() => finish({ error: 'Cloud Wallet sign-in timed out' }), timeoutMs);
  function finish(outcome: LoopbackCallbackResult): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server.close();
    settle(outcome);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    finish({ error: 'Loopback listener has no port' });
    throw new Error('Loopback listener has no port');
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    result,
    close: () => finish({ error: 'Cloud Wallet sign-in was cancelled' }),
  };
}

/** True for exactly the `/token` endpoint of an allowed Cloud Wallet origin. */
export function isCloudWalletTokenUrl(
  tokenUrl: string,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  let url: URL;
  try {
    url = new URL(tokenUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    allowedOrigins.has(url.origin) &&
    url.pathname === '/token' &&
    url.search === '' &&
    url.hash === ''
  );
}
