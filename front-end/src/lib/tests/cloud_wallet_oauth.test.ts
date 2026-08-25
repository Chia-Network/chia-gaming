function makeStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key(i: number) {
      return [...map.keys()][i] ?? null;
    },
    getItem(k: string) {
      return map.has(k) ? map.get(k)! : null;
    },
    setItem(k: string, v: string) {
      map.set(k, String(v));
    },
    removeItem(k: string) {
      map.delete(k);
    },
    clear() {
      map.clear();
    },
  };
}

function setTestGlobal(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

/** Minimal window stand-in that lets tests dispatch `message` events manually. */
function makeFakeWindow() {
  const handlers: Record<string, Array<(e: unknown) => void>> = {};
  return {
    addEventListener(type: string, cb: (e: unknown) => void) {
      (handlers[type] ||= []).push(cb);
    },
    removeEventListener(type: string, cb: (e: unknown) => void) {
      handlers[type] = (handlers[type] || []).filter((f) => f !== cb);
    },
    emit(type: string, event: unknown) {
      (handlers[type] || []).slice().forEach((cb) => cb(event));
    },
  };
}

setTestGlobal('localStorage', makeStorage());
setTestGlobal('sessionStorage', makeStorage());
setTestGlobal('window', globalThis);

import {
  buildAuthorizeUrl,
  createPkceChallenge,
  encodeRelayGlobalId,
  fetchFirstConsentedWalletId,
  handleOAuthCallbackPage,
  normalizeHex,
  oauthRedirectUri,
  signatureRequestApproveUrl,
  waitForGamingConsentWalletId,
  waitForOAuthCode,
  with0x,
  GAMING_CONSENT_MESSAGE_TYPE,
  OAUTH_MESSAGE_TYPE,
} from '../../hooks/cloudWalletOAuth';
import {
  saveOAuthPending,
  clearOAuthPending,
  clearCloudWalletAuth,
  saveCloudWalletAuth,
} from '../../hooks/cloudWalletAuth';
import {
  clearCloudWalletConfig,
  getCloudWalletApiUrl,
  getCloudWalletClientId,
  getCloudWalletUiUrl,
  loadCloudWalletConfig,
  saveCloudWalletConfig,
} from '../../hooks/cloudWalletConfig';
import { CloudBlockchainInterface } from '../../hooks/CloudBlockchainInterface';
import {
  conditionsForGraphql,
  jsonSafeVariables,
  selectCoinStringForAmount,
} from '../../hooks/cloudWalletHelpers';
import { encodeU64AsClvmHex } from '../../util';

describe('cloudWalletOAuth helpers', () => {
  beforeEach(() => {
    setTestGlobal('localStorage', makeStorage());
    setTestGlobal('sessionStorage', makeStorage());
    clearOAuthPending();
    clearCloudWalletAuth();
  });

  it('createPkceChallenge is stable S256 base64url', async () => {
    const challenge = await createPkceChallenge('test-verifier-value');
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain('+');
    expect(challenge).not.toContain('/');
    expect(await createPkceChallenge('test-verifier-value')).toBe(challenge);
  });

  it('buildAuthorizeUrl includes PKCE and scopes', () => {
    const url = buildAuthorizeUrl({
      clientId: 'client-1',
      redirectUri: 'http://127.0.0.1:8080/oauth/callback',
      scope: 'wallet.read offline_access',
      state: 'state123',
      codeChallenge: 'challengeABC',
      apiBase: 'http://api.example',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('http://api.example/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('client-1');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBe('challengeABC');
    expect(parsed.searchParams.get('scope')).toBe('wallet.read offline_access');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8080/oauth/callback');
    expect(parsed.searchParams.get('chia_gaming_client')).toBe('true');
  });

  it('oauthRedirectUri appends callback path', () => {
    expect(oauthRedirectUri('https://game.example/')).toBe('https://game.example/oauth/callback');
  });

  it('signatureRequestApproveUrl builds UI path', () => {
    expect(signatureRequestApproveUrl('SignatureRequest_abc', 'https://ui.example')).toBe(
      'https://ui.example/signature-requests/SignatureRequest_abc',
    );
  });

  it('normalizeHex and with0x strip/add prefixes', () => {
    expect(normalizeHex('0xAaBb')).toBe('aabb');
    expect(with0x('Aa')).toBe('0xaa');
  });

  it('encodeRelayGlobalId prefixes Wallet typename', () => {
    const id = encodeRelayGlobalId('Wallet', 'wal_1');
    expect(atob(id)).toBe('Wallet:wal_1');
    expect(encodeRelayGlobalId('Wallet', id)).toBe(id);
  });

  it('encodeRelayGlobalId passes through Cloud Wallet global ids unchanged', () => {
    // Cloud Wallet emits `Typename_xxx` ids; these must not be re-encoded.
    expect(encodeRelayGlobalId('Wallet', 'Wallet_abc123')).toBe('Wallet_abc123');
    // A non-matching prefix still gets the base64 `Typename:id` treatment.
    expect(atob(encodeRelayGlobalId('Wallet', 'Other_abc'))).toBe('Wallet:Other_abc');
  });

  it('handleOAuthCallbackPage posts code to opener on success', () => {
    saveOAuthPending({
      state: 'st1',
      codeVerifier: 'v',
      createdAtMs: Date.now(),
    });
    const posted: any[] = [];
    const opener = {
      postMessage: (msg: unknown, origin: string) => posted.push({ msg, origin }),
    };
    (globalThis as any).window = globalThis;
    (globalThis as any).opener = opener;
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: {
        origin: 'http://127.0.0.1',
        search: '?code=authcode&state=st1',
        href: 'http://127.0.0.1/oauth/callback?code=authcode&state=st1',
      },
    });

    const result = handleOAuthCallbackPage();
    expect(result.status).toBe('ok');
    expect(posted[0]?.msg).toEqual({
      type: OAUTH_MESSAGE_TYPE,
      code: 'authcode',
      state: 'st1',
    });
  });

  it('handleOAuthCallbackPage rejects state mismatch', () => {
    saveOAuthPending({
      state: 'expected',
      codeVerifier: 'v',
      createdAtMs: Date.now(),
    });
    const posted: any[] = [];
    (globalThis as any).window = globalThis;
    (globalThis as any).opener = {
      postMessage: (msg: unknown) => posted.push(msg),
    };
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: {
        origin: 'http://127.0.0.1',
        search: '?code=x&state=wrong',
        href: 'http://127.0.0.1/oauth/callback?code=x&state=wrong',
      },
    });

    const result = handleOAuthCallbackPage();
    expect(result.status).toBe('error');
    expect(String((posted[0] as any)?.error)).toMatch(/state mismatch/i);
  });
});

describe('cloudWalletConfig', () => {
  beforeEach(() => {
    setTestGlobal('localStorage', makeStorage());
    clearCloudWalletConfig();
  });

  it('falls back to env defaults when nothing is stored', () => {
    expect(getCloudWalletApiUrl()).toBe('http://127.0.0.1:3001');
    expect(getCloudWalletUiUrl()).toBe('http://127.0.0.1:3000');
    expect(getCloudWalletClientId()).toBe('');
  });

  it('persisted values take precedence and are normalized', () => {
    saveCloudWalletConfig({
      clientId: '  client-1  ',
      apiUrl: 'http://api.local/',
      uiUrl: 'http://ui.local/',
    });
    expect(getCloudWalletClientId()).toBe('client-1');
    expect(getCloudWalletApiUrl()).toBe('http://api.local');
    expect(getCloudWalletUiUrl()).toBe('http://ui.local');
    expect(loadCloudWalletConfig()).toEqual({
      clientId: 'client-1',
      apiUrl: 'http://api.local',
      uiUrl: 'http://ui.local',
    });
  });
});

describe('CloudBlockchainInterface beginConnect', () => {
  beforeEach(() => {
    setTestGlobal('localStorage', makeStorage());
    setTestGlobal('sessionStorage', makeStorage());
    clearCloudWalletConfig();
    clearCloudWalletAuth();
  });

  it('fresh connect exposes skipQr setup fields so Shell prompts instead of silent-finalize', async () => {
    const iface = new CloudBlockchainInterface();
    const setup = await iface.beginConnect('uid', true);
    expect(setup.skipQr).toBe(true);
    expect(setup.title).toBe('Cloud Wallet');
    expect(setup.fields?.clientId?.type).toBe('string');
    expect(setup.fields?.apiUrl?.type).toBe('string');
    expect(setup.fields?.uiUrl?.type).toBe('string');
  });

  it('stored auth skips setup fields so silent reconnect can finalize', async () => {
    saveCloudWalletAuth({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Date.now() + 60_000,
      walletId: 'wallet-1',
    });
    const iface = new CloudBlockchainInterface();
    const setup = await iface.beginConnect('uid');
    expect(setup.skipQr).toBe(true);
    expect(setup.fields).toBeUndefined();
  });

  it('finalize persists config before attempting OAuth', async () => {
    const iface = new CloudBlockchainInterface();
    const setup = await iface.beginConnect('uid', true);
    // OAuth cannot complete in the test environment (no popup), so finalize
    // rejects -- but only after the config has been saved.
    await expect(
      setup.finalize({
        clientId: 'client-xyz',
        apiUrl: 'http://api.local/',
        uiUrl: 'http://ui.local/',
      }),
    ).rejects.toBeTruthy();
    expect(loadCloudWalletConfig()).toEqual({
      clientId: 'client-xyz',
      apiUrl: 'http://api.local',
      uiUrl: 'http://ui.local',
    });
  });

  it('finalize rejects when no client id is available', async () => {
    const iface = new CloudBlockchainInterface();
    const setup = await iface.beginConnect('uid', true);
    await expect(setup.finalize({ clientId: '', apiUrl: '', uiUrl: '' })).rejects.toThrow(
      /client id/i,
    );
  });
});

describe('waitForGamingConsentWalletId grace period', () => {
  let fakeWindow: ReturnType<typeof makeFakeWindow>;

  beforeEach(() => {
    setTestGlobal('localStorage', makeStorage());
    clearCloudWalletConfig();
    jest.useFakeTimers();
    fakeWindow = makeFakeWindow();
    setTestGlobal('window', fakeWindow);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    setTestGlobal('window', globalThis);
  });

  const consentEvent = (walletId: string, origin = 'http://127.0.0.1:3000') => ({
    origin,
    data: { type: GAMING_CONSENT_MESSAGE_TYPE, walletId },
  });

  it('resolves immediately when the consent message arrives', async () => {
    const popup = { closed: false } as unknown as Window;
    const { promise } = waitForGamingConsentWalletId(popup, 60_000, 500);
    fakeWindow.emit('message', consentEvent('Wallet_immediate'));
    await expect(promise).resolves.toBe('Wallet_immediate');
  });

  it('resolves a late walletId posted during the popup-close grace period', async () => {
    const popup = { closed: false } as unknown as Window;
    const { promise } = waitForGamingConsentWalletId(popup, 60_000, 500);
    popup.closed = true;
    jest.advanceTimersByTime(400); // close poll detects close -> grace begins
    fakeWindow.emit('message', consentEvent('Wallet_late'));
    await expect(promise).resolves.toBe('Wallet_late');
  });

  it('resolves undefined only after the grace period elapses with no message', async () => {
    const popup = { closed: false } as unknown as Window;
    const { promise } = waitForGamingConsentWalletId(popup, 60_000, 500);
    popup.closed = true;
    jest.advanceTimersByTime(400); // detect close, start 500ms grace
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    jest.advanceTimersByTime(499);
    await Promise.resolve();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    await expect(promise).resolves.toBeUndefined();
  });

  it('notifyCodeReceived starts the grace period while the popup stays open', async () => {
    const popup = { closed: false } as unknown as Window;
    const { promise, notifyCodeReceived } = waitForGamingConsentWalletId(popup, 60_000, 500);
    notifyCodeReceived();
    // A late message during the grace window still wins over the timeout.
    fakeWindow.emit('message', consentEvent('Wallet_after_code'));
    await expect(promise).resolves.toBe('Wallet_after_code');
  });

  it('ignores consent messages from an unexpected origin', async () => {
    const popup = { closed: false } as unknown as Window;
    const { promise, notifyCodeReceived } = waitForGamingConsentWalletId(popup, 60_000, 500);
    fakeWindow.emit('message', consentEvent('Wallet_evil', 'http://evil.example'));
    notifyCodeReceived();
    jest.advanceTimersByTime(500);
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('waitForOAuthCode grace period', () => {
  const origin = 'http://127.0.0.1';
  let fakeWindow: ReturnType<typeof makeFakeWindow> & { location: { origin: string } };

  beforeEach(() => {
    jest.useFakeTimers();
    fakeWindow = Object.assign(makeFakeWindow(), { location: { origin } });
    setTestGlobal('window', fakeWindow);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    setTestGlobal('window', globalThis);
  });

  const codeEvent = (code: string, state = 'st1', eventOrigin = origin) => ({
    origin: eventOrigin,
    data: { type: OAUTH_MESSAGE_TYPE, code, state },
  });

  it('resolves immediately when the code message arrives', async () => {
    const popup = { closed: false } as unknown as Window;
    const promise = waitForOAuthCode('st1', popup, 60_000, 500);
    fakeWindow.emit('message', codeEvent('authcode'));
    await expect(promise).resolves.toBe('authcode');
  });

  it('resolves a late code posted during the popup-close grace period', async () => {
    const popup = { closed: false } as unknown as Window;
    const promise = waitForOAuthCode('st1', popup, 60_000, 500);
    popup.closed = true;
    jest.advanceTimersByTime(400); // close poll detects close -> grace begins
    fakeWindow.emit('message', codeEvent('late-code'));
    await expect(promise).resolves.toBe('late-code');
  });

  it('rejects only after the grace period elapses with no message', async () => {
    const popup = { closed: false } as unknown as Window;
    const promise = waitForOAuthCode('st1', popup, 60_000, 500);
    popup.closed = true;
    jest.advanceTimersByTime(400); // detect close, start 500ms grace
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    jest.advanceTimersByTime(499);
    await Promise.resolve();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    await expect(promise).rejects.toThrow(/popup was closed/);
  });

  it('ignores code messages from an unexpected origin during grace', async () => {
    const popup = { closed: false } as unknown as Window;
    const promise = waitForOAuthCode('st1', popup, 60_000, 500);
    popup.closed = true;
    jest.advanceTimersByTime(400);
    fakeWindow.emit('message', codeEvent('stolen', 'st1', 'http://evil.example'));
    jest.advanceTimersByTime(500);
    await expect(promise).rejects.toThrow(/popup was closed/);
  });
});

describe('fetchFirstConsentedWalletId', () => {
  const provider = { getAccessToken: async () => 'access-token' };

  beforeEach(() => {
    setTestGlobal('localStorage', makeStorage());
    clearCloudWalletConfig();
  });

  afterEach(() => {
    setTestGlobal('fetch', undefined);
  });

  function mockGraphql(data: unknown) {
    const fetchMock = jest.fn(async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ data }),
    }));
    setTestGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('returns the first consented wallet id unchanged (no base64 re-encode)', async () => {
    mockGraphql({
      oauthConsentedWallets: [{ id: 'Wallet_abc' }, { id: 'Wallet_def' }],
    });
    await expect(fetchFirstConsentedWalletId(provider)).resolves.toBe('Wallet_abc');
  });

  it('returns undefined when there are no consented wallets', async () => {
    mockGraphql({ oauthConsentedWallets: [] });
    await expect(fetchFirstConsentedWalletId(provider)).resolves.toBeUndefined();
  });

  it('returns undefined when oauthConsentedWallets is null', async () => {
    mockGraphql({ oauthConsentedWallets: null });
    await expect(fetchFirstConsentedWalletId(provider)).resolves.toBeUndefined();
  });
});

describe('CloudBlockchainInterface helpers', () => {
  it('conditionsForGraphql maps opcodes and maxHeight', () => {
    const conditions = conditionsForGraphql([{ opcode: 51n, args: ['ph', '64'] }], 100n);
    expect(conditions[0]).toEqual({ opcode: '51', args: ['ph', '64'] });
    expect(conditions[1]).toEqual({
      opcode: '87',
      args: [encodeU64AsClvmHex(100n)],
    });
  });

  it('jsonSafeVariables converts bigint recursively', () => {
    expect(jsonSafeVariables({ amount: 10n, nested: { fee: 0n }, list: [1n] })).toEqual({
      amount: '10',
      nested: { fee: '0' },
      list: ['1'],
    });
  });

  it('selectCoinStringForAmount picks smallest sufficient coin', () => {
    const coin = selectCoinStringForAmount(
      [
        {
          parentCoinInfo: '11'.repeat(32),
          puzzleHash: '22'.repeat(32),
          amount: 50n,
        },
        {
          parentCoinInfo: '33'.repeat(32),
          puzzleHash: '44'.repeat(32),
          amount: 200n,
        },
        {
          parentCoinInfo: '55'.repeat(32),
          puzzleHash: '66'.repeat(32),
          amount: 100n,
        },
      ],
      80n,
    );
    expect(coin).not.toBeNull();
    expect(coin!.startsWith('55'.repeat(32) + '66'.repeat(32))).toBe(true);
  });

  it('selectCoinStringForAmount returns null when none suffice', () => {
    expect(
      selectCoinStringForAmount(
        [
          {
            parentCoinInfo: '11'.repeat(32),
            puzzleHash: '22'.repeat(32),
            amount: 10n,
          },
        ],
        100n,
      ),
    ).toBeNull();
  });

  it('selectCoinStringForAmount returns null when the sufficient coin has no parent', () => {
    expect(
      selectCoinStringForAmount(
        [
          {
            puzzleHash: '22'.repeat(32),
            amount: 100n,
          },
        ],
        50n,
      ),
    ).toBeNull();
  });

  it('selectCoinStringForAmount skips an incomplete coin and picks the next valid one', () => {
    const coin = selectCoinStringForAmount(
      [
        {
          puzzleHash: '22'.repeat(32),
          amount: 80n,
        },
        {
          parentCoinInfo: '33'.repeat(32),
          puzzleHash: '44'.repeat(32),
          amount: 100n,
        },
      ],
      50n,
    );
    expect(coin).not.toBeNull();
    expect(coin!.startsWith('33'.repeat(32) + '44'.repeat(32))).toBe(true);
  });
});

describe('CloudBlockchainInterface coin records', () => {
  beforeEach(() => {
    setTestGlobal('localStorage', makeStorage());
    setTestGlobal('sessionStorage', makeStorage());
    clearCloudWalletAuth();
    saveCloudWalletAuth({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 10 * 60_000,
      walletId: 'Wallet_1',
    });
  });

  afterEach(() => {
    setTestGlobal('fetch', undefined);
  });

  function mockGraphql(handler: (query: string) => unknown) {
    const fetchMock = jest.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ data: handler(body.query ?? '') }),
      };
    });
    setTestGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('getCoinRecordsByNames omits records missing parentCoinName instead of inventing a parent', async () => {
    mockGraphql(() => ({
      coinRecordsByNames: [
        {
          name: 'aa'.repeat(32),
          amount: '100',
          puzzleHash: 'bb'.repeat(32),
        },
        {
          name: 'cc'.repeat(32),
          amount: '200',
          puzzleHash: 'dd'.repeat(32),
          parentCoinName: 'ee'.repeat(32),
        },
      ],
    }));
    const iface = new CloudBlockchainInterface();
    const records = await iface.getCoinRecordsByNames(['aa'.repeat(32), 'cc'.repeat(32)]);
    expect(records).toHaveLength(1);
    expect(records[0].coin.parentCoinInfo).toBe('ee'.repeat(32));
    expect(records[0].coin.puzzleHash).toBe('dd'.repeat(32));
    expect(records[0].coin.amount).toBe(200n);
  });

  it('selectCoins returns null when coin records have no parent identity', async () => {
    mockGraphql((query) => {
      if (query.includes('coinRecordsByNames')) {
        return {
          coinRecordsByNames: [
            {
              name: 'aa'.repeat(32),
              amount: '100',
              puzzleHash: 'bb'.repeat(32),
            },
          ],
        };
      }
      return {
        coins: {
          edges: [
            {
              node: {
                name: 'aa'.repeat(32),
                amount: '100',
                puzzleHash: 'bb'.repeat(32),
              },
            },
          ],
        },
      };
    });
    const iface = new CloudBlockchainInterface();
    await expect(iface.selectCoins('uid', 50n)).resolves.toBeNull();
  });
});
