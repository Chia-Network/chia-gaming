import http from 'node:http';

import type { CloudWalletLoginResult } from '../shared/ipc.ts';

export type LoopbackCallback = {
  /** `http://127.0.0.1:<port>/oauth/callback`, bound for this one sign-in. */
  redirectUri: string;
  /** Settles with the matching callback, or with an error on timeout or close. */
  result: Promise<CloudWalletLoginResult>;
  /** The OAuth `state` this sign-in sent; only a callback carrying it settles. */
  expectState: (state: string) => void;
  close: () => void;
};

const CALLBACK_PATH = '/oauth/callback';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family:-apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;text-align:center"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`;
}

/**
 * Read the authorization response from a request to the loopback callback.
 * Null for any other path.
 */
export function parseCallbackRequest(
  requestUrl: string,
): { state: string | null; outcome: CloudWalletLoginResult } | null {
  const url = new URL(requestUrl, 'http://127.0.0.1');
  if (url.pathname !== CALLBACK_PATH) return null;
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description');
    return { state, outcome: { error: description ? `${error}: ${description}` : error } };
  }
  const code = url.searchParams.get('code');
  if (!code || !state) {
    return { state, outcome: { error: 'Missing authorization code or state' } };
  }
  return { state, outcome: { code, state } };
}

/**
 * Listen on an ephemeral 127.0.0.1 port for one OAuth redirect (RFC 8252
 * §7.3). The authorization server accepts any loopback port for a client that
 * registered `http://127.0.0.1/oauth/callback`. Only a callback carrying the
 * expected `state` settles the sign-in, so a stray or forged local request
 * cannot consume it; the listener then closes.
 */
export async function startLoopbackCallback(
  timeoutMs: number,
  onCallback: () => void = () => {},
): Promise<LoopbackCallback> {
  let settle: (result: CloudWalletLoginResult) => void = () => {};
  const result = new Promise<CloudWalletLoginResult>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  let expectedState: string | null = null;
  const server = http.createServer((request, response) => {
    const callback = parseCallbackRequest(request.url ?? '/');
    if (request.method !== 'GET' || callback === null || settled) {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    if (expectedState === null || callback.state !== expectedState) {
      response
        .writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(
          page(
            'Unexpected sign-in response',
            'This is not the Cloud Wallet sign-in Chia Gaming is waiting for.',
          ),
        );
      return;
    }
    const { outcome } = callback;
    const ok = !('error' in outcome);
    response
      .writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(
        ok
          ? page('Signed in to Cloud Wallet', 'You can close this tab and return to Chia Gaming.')
          : page('Cloud Wallet sign-in failed', outcome.error),
      );
    finish(outcome);
    onCallback();
  });

  const timer = setTimeout(() => finish({ error: 'Cloud Wallet sign-in timed out' }), timeoutMs);
  function finish(outcome: CloudWalletLoginResult): void {
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
    expectState: (state) => {
      expectedState = state;
    },
    close: () => finish({ error: 'Cloud Wallet sign-in was cancelled' }),
  };
}
