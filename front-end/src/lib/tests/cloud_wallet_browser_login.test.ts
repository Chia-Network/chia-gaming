function setTestGlobal(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

function makeStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

setTestGlobal('localStorage', makeStorage());
setTestGlobal('sessionStorage', makeStorage());
setTestGlobal('window', globalThis);

import {
  beginOAuthLogin,
  CLOUD_WALLET_LOGIN_CANCELLED,
  signatureRequestApproveUrl,
} from '../../hooks/cloudWalletOAuth';
import { CloudBlockchainInterface } from '../../hooks/CloudBlockchainInterface';

const REDIRECT_URI = 'http://127.0.0.1:5555/oauth/callback';

function mockCloudWallet() {
  const requests: Array<{ url: string; body: string }> = [];
  setTestGlobal(
    'fetch',
    jest.fn(async (url: string, init?: { body?: string }) => {
      const body = String(init?.body ?? '');
      requests.push({ url, body });
      const payload = url.endsWith('/token')
        ? { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }
        : { data: { oauthConsentedWallets: [{ id: 'Wallet_abc' }] } };
      return { status: 200, ok: true, text: async () => JSON.stringify(payload) };
    }),
  );
  return requests;
}

describe('desktop Cloud Wallet sign-in through the system browser', () => {
  afterEach(() => {
    setTestGlobal('__chiaCloudWallet', undefined);
    setTestGlobal('fetch', undefined);
  });

  it('authorizes against the loopback redirect and exchanges the code for it', async () => {
    const requests = mockCloudWallet();
    const postToken = jest.fn(async (_url: string, _body: string) => ({
      status: 200,
      text: JSON.stringify({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }),
    }));
    let authorizeUrl = '';
    const openPopup = jest.fn();
    setTestGlobal('open', openPopup);
    setTestGlobal('__chiaCloudWallet', {
      beginBrowserLogin: async () => ({ flowId: 'flow-1', redirectUri: REDIRECT_URI }),
      completeBrowserLogin: async (flowId: string, url: string) => {
        expect(flowId).toBe('flow-1');
        authorizeUrl = url;
        return { code: 'the-code', state: new URL(url).searchParams.get('state')! };
      },
      openInBrowser: async () => true,
      postToken,
    });

    const login = await beginOAuthLogin();

    expect(new URL(authorizeUrl).searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(openPopup).not.toHaveBeenCalled();
    // The token endpoint has no CORS for `chiagaming:`, so main sends it.
    expect(requests.some((r) => r.url.endsWith('/token'))).toBe(false);
    expect(postToken).toHaveBeenCalledTimes(1);
    expect(postToken.mock.calls[0][0]).toMatch(/\/token$/);
    const token = new URLSearchParams(postToken.mock.calls[0][1]);
    expect(token.get('code')).toBe('the-code');
    expect(token.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(login).toMatchObject({
      accessToken: 'access',
      refreshToken: 'refresh',
      walletId: 'Wallet_abc',
    });
  });

  it('rejects a callback whose state does not match this sign-in', async () => {
    const requests = mockCloudWallet();
    setTestGlobal('__chiaCloudWallet', {
      beginBrowserLogin: async () => ({ flowId: 'flow-1', redirectUri: REDIRECT_URI }),
      completeBrowserLogin: async () => ({ code: 'the-code', state: 'someone-else' }),
      openInBrowser: async () => true,
    });

    await expect(beginOAuthLogin()).rejects.toThrow(/unexpected state/);
    expect(requests).toEqual([]);
  });

  it('reports a failed token relay as a transport failure with its cause', async () => {
    mockCloudWallet();
    setTestGlobal('__chiaCloudWallet', {
      beginBrowserLogin: async () => ({ flowId: 'flow-1', redirectUri: REDIRECT_URI }),
      completeBrowserLogin: async (_flowId: string, url: string) => ({
        code: 'the-code',
        state: new URL(url).searchParams.get('state')!,
      }),
      openInBrowser: async () => true,
      postToken: async () => ({ transportError: 'net::ERR_CONNECTION_REFUSED' }),
    });

    await expect(beginOAuthLogin()).rejects.toThrow(
      'Cloud Wallet token transport failed: net::ERR_CONNECTION_REFUSED',
    );
  });

  it('surfaces a sign-in error reported by the browser callback', async () => {
    mockCloudWallet();
    setTestGlobal('__chiaCloudWallet', {
      beginBrowserLogin: async () => ({ flowId: 'flow-1', redirectUri: REDIRECT_URI }),
      completeBrowserLogin: async () => ({ error: 'access_denied: user cancelled' }),
      openInBrowser: async () => true,
    });

    await expect(beginOAuthLogin()).rejects.toThrow('access_denied: user cancelled');
  });

  it('ends a pending sign-in when the user cancels in the app', async () => {
    mockCloudWallet();
    // The browser never calls back (e.g. the user closed the tab); only
    // cancelling the flow in main settles it.
    let settle: (result: { error: string }) => void = () => {};
    let browserOpened: () => void = () => {};
    const waitingForBrowser = new Promise<void>((resolve) => {
      browserOpened = resolve;
    });
    const cancelBrowserLogin = jest.fn(async () => {
      settle({ error: 'Cloud Wallet sign-in was cancelled' });
    });
    setTestGlobal('__chiaCloudWallet', {
      beginBrowserLogin: async () => ({ flowId: 'flow-1', redirectUri: REDIRECT_URI }),
      completeBrowserLogin: () =>
        new Promise((resolve) => {
          settle = resolve;
          browserOpened();
        }),
      cancelBrowserLogin,
      openInBrowser: async () => true,
    });
    const cloud = new CloudBlockchainInterface();
    const setup = await cloud.beginConnect('player', true);

    const finalize = setup.finalize();
    await waitingForBrowser;
    await cloud.disconnect();

    await expect(finalize).rejects.toThrow('Cloud Wallet sign-in was cancelled');
    expect(cancelBrowserLogin).toHaveBeenCalledWith('flow-1');
    expect(cloud.isConnected()).toBe(false);
  });

  it('does not open the browser when cancelled while sign-in is starting', async () => {
    const abort = new AbortController();
    const completeBrowserLogin = jest.fn();
    const cancelBrowserLogin = jest.fn(async () => {});
    setTestGlobal('__chiaCloudWallet', {
      beginBrowserLogin: async () => {
        abort.abort();
        return { flowId: 'flow-1', redirectUri: REDIRECT_URI };
      },
      completeBrowserLogin,
      cancelBrowserLogin,
      openInBrowser: async () => true,
    });

    await expect(beginOAuthLogin(abort.signal)).rejects.toThrow(CLOUD_WALLET_LOGIN_CANCELLED);
    expect(completeBrowserLogin).not.toHaveBeenCalled();
    expect(cancelBrowserLogin).toHaveBeenCalledWith('flow-1');
  });
});

describe('desktop Cloud Wallet signature approval through the system browser', () => {
  afterEach(() => {
    setTestGlobal('__chiaCloudWallet', undefined);
  });

  type Tracker = {
    trackSignatureRequest<T>(id: string, source: string, poll: () => Promise<T>): Promise<T>;
  };

  it('opens the approval page in the browser and returns what polling observes', async () => {
    const openInBrowser = jest.fn(async () => true);
    const openPopup = jest.fn();
    setTestGlobal('open', openPopup);
    setTestGlobal('__chiaCloudWallet', { openInBrowser });
    const cloud = new CloudBlockchainInterface() as unknown as Tracker;

    await expect(
      cloud.trackSignatureRequest('sr-1', 'offer', async () => 'signed-offer'),
    ).resolves.toBe('signed-offer');
    expect(openInBrowser).toHaveBeenCalledWith(signatureRequestApproveUrl('sr-1'));
    expect(openPopup).not.toHaveBeenCalled();
  });

  it('opens each approval once even when reconciliation retries it', async () => {
    const openInBrowser = jest.fn(async () => true);
    setTestGlobal('__chiaCloudWallet', { openInBrowser });
    const cloud = new CloudBlockchainInterface() as unknown as Tracker;

    for (let attempt = 0; attempt < 3; attempt++) {
      await cloud.trackSignatureRequest('sr-1', 'offer', async () => 'signed-offer');
    }
    await cloud.trackSignatureRequest('sr-2', 'offer', async () => 'signed-offer');

    expect(openInBrowser.mock.calls).toEqual([
      [signatureRequestApproveUrl('sr-1')],
      [signatureRequestApproveUrl('sr-2')],
    ]);
  });

  it('does not poll when the browser could not be opened', async () => {
    setTestGlobal('__chiaCloudWallet', { openInBrowser: async () => false });
    const poll = jest.fn(async () => 'signed-offer');
    const cloud = new CloudBlockchainInterface() as unknown as Tracker;

    await expect(cloud.trackSignatureRequest('sr-1', 'offer', poll)).rejects.toThrow(
      /Could not open the browser/,
    );
    expect(poll).not.toHaveBeenCalled();
  });
});
