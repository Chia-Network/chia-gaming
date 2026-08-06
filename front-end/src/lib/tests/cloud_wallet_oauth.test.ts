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

setTestGlobal('localStorage', makeStorage());
setTestGlobal('sessionStorage', makeStorage());
setTestGlobal('window', globalThis);

import {
  buildAuthorizeUrl,
  createPkceChallenge,
  encodeRelayGlobalId,
  handleOAuthCallbackPage,
  normalizeHex,
  oauthRedirectUri,
  signatureRequestApproveUrl,
  with0x,
  OAUTH_MESSAGE_TYPE,
} from '../../hooks/cloudWalletOAuth';
import {
  saveOAuthPending,
  clearOAuthPending,
  clearCloudWalletAuth,
} from '../../hooks/cloudWalletAuth';
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
});
