import {
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
  ConnectionSetup,
} from '../types/ChiaGaming';
import { CoinRecord } from '../types/rpc/CoinRecord';
import { WalletSpendBundle } from '../types/rpc/PushTransactions';
import { log } from '../services/log';
import { normalizeHexString, toUint8, toHexString } from '../util';
import {
  beginOAuthPopupLogin,
  createAuthTokenProvider,
  graphqlRequest,
  normalizeHex,
  signatureRequestApproveUrl,
  SIGNATURE_REQUEST_MESSAGE_TYPE,
  type TokenProvider,
} from './cloudWalletOAuth';
import {
  getCloudWalletApiUrl,
  getCloudWalletClientId,
  getCloudWalletUiUrl,
  loadCloudWalletConfig,
  saveCloudWalletConfig,
} from './cloudWalletConfig';
import {
  clearCloudWalletAuth,
  loadCloudWalletAuth,
  saveCloudWalletAuth,
  type CloudWalletAuthState,
} from './cloudWalletAuth';
import {
  absAmountFromOffer,
  coinSpendsToWalletBundle,
  conditionsForGraphql,
  jsonSafeVariables,
  selectCoinStringForAmount,
} from './cloudWalletHelpers';

export {
  absAmountFromOffer,
  coinSpendsToWalletBundle,
  conditionsForGraphql,
  jsonSafeVariables,
  selectCoinStringForAmount,
} from './cloudWalletHelpers';

const APPROVE_TIMEOUT_MS = 10 * 60 * 1000;
const SR_POLL_MS = 1500;

export class CloudBlockchainInterface implements InternalBlockchainInterface {
  blockchainAddressData: BlockchainInboundAddressResult = { puzzleHash: '' };

  private auth: CloudWalletAuthState | null = null;
  private connectionListeners = new Set<(connected: boolean) => void>();
  private readinessListeners = new Set<(ready: boolean) => void>();
  private lastConnectedState = false;
  private monitoringReady = false;
  private tokenProvider: TokenProvider;

  constructor() {
    this.auth = loadCloudWalletAuth();
    this.tokenProvider = createAuthTokenProvider(
      () => this.auth,
      (next) => {
        this.auth = next;
        saveCloudWalletAuth(next);
      },
    );
  }

  private requireWalletId(): string {
    if (!this.auth?.walletId) {
      throw new Error('Cloud Wallet walletId is not set');
    }
    return this.auth.walletId;
  }

  private async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const safe = variables ? (jsonSafeVariables(variables) as Record<string, unknown>) : undefined;
    return graphqlRequest<T>(query, safe, this.tokenProvider);
  }

  private fireConnectionChange(connected: boolean) {
    if (this.lastConnectedState === connected) return;
    this.lastConnectedState = connected;
    for (const cb of this.connectionListeners) {
      try {
        cb(connected);
      } catch {
        // ignore
      }
    }
    // Cloud Wallet has no full-node peer wait: play readiness tracks connectivity.
    for (const cb of this.readinessListeners) {
      try {
        cb(connected);
      } catch {
        // ignore
      }
    }
  }

  private persistAuth(
    partial: Partial<CloudWalletAuthState> &
      Pick<CloudWalletAuthState, 'accessToken' | 'refreshToken' | 'expiresAt'>,
  ) {
    const walletId = partial.walletId ?? this.auth?.walletId ?? '';
    if (!walletId) {
      throw new Error('Cloud Wallet walletId is required before persisting auth');
    }
    this.auth = {
      accessToken: partial.accessToken,
      refreshToken: partial.refreshToken,
      expiresAt: partial.expiresAt,
      walletId,
    };
    saveCloudWalletAuth(this.auth);
  }

  private async resolveWalletId(): Promise<string> {
    const stored = this.auth?.walletId;
    if (stored) {
      try {
        const data = await this.gql<{ wallet: { id: string } | null }>(
          `query($id: ID!) { wallet(id: $id) { id } }`,
          { id: stored },
        );
        if (data.wallet?.id) return data.wallet.id;
      } catch (e) {
        log(`[cloud-blockchain] stored walletId not readable: ${String(e)}`);
      }
    }

    throw new Error(
      'No Cloud Wallet walletId available. Reconnect and ensure OAuth consent selects a wallet resource.',
    );
  }

  async getAddress(): Promise<BlockchainInboundAddressResult> {
    return this.blockchainAddressData;
  }

  async startMonitoring(): Promise<void> {
    const walletId = this.requireWalletId();
    const data = await this.gql<{
      wallet: {
        id: string;
        address: { puzzleHash: string } | null;
      } | null;
    }>(
      `query($id: ID!) {
        wallet(id: $id) {
          id
          address { puzzleHash }
        }
      }`,
      { id: walletId },
    );
    if (!data.wallet) {
      throw new Error('Cloud Wallet wallet not found');
    }
    const ph = normalizeHex(data.wallet.address?.puzzleHash);
    if (!ph || ph.length !== 64) {
      throw new Error(`Cloud Wallet wallet has no address puzzle hash (walletId=${walletId})`);
    }
    this.blockchainAddressData = { puzzleHash: ph };
    this.monitoringReady = true;
    this.fireConnectionChange(true);
    log(`[cloud-blockchain] monitoring ready wallet=${walletId} ph=${ph}`);
  }

  async getBalance(): Promise<bigint> {
    const walletId = this.requireWalletId();
    const data = await this.gql<{
      wallet: { balance: string | number | bigint } | null;
    }>(`query($id: ID!) { wallet(id: $id) { balance } }`, { id: walletId });
    if (!data.wallet || data.wallet.balance == null) {
      throw new Error('Cloud Wallet balance unavailable');
    }
    return BigInt(data.wallet.balance);
  }

  async selectCoins(_uniqueId: string, amount: bigint): Promise<string | null> {
    const walletId = this.requireWalletId();
    const data = await this.gql<{
      coins: {
        edges: Array<{
          node: {
            name: string;
            amount: string | number | bigint;
            puzzleHash: string;
            parentCoinName?: string;
            parentCoinInfo?: string;
          };
        }>;
      };
    }>(
      `query($walletId: ID!, $first: Int!) {
        coins(walletId: $walletId, first: $first) {
          edges {
            node {
              name
              amount
              puzzleHash
            }
          }
        }
      }`,
      { walletId, first: 50 },
    );

    const nodes = data.coins?.edges?.map((e) => e.node) ?? [];
    // coins connection may not expose parentCoinInfo; resolve via coinRecordsByNames.
    const names = nodes.map((n) => normalizeHex(n.name)).filter((n) => n.length === 64);
    if (names.length === 0) return null;

    const records = await this.getCoinRecordsByNames(names);
    const unspent = records
      .filter((r) => !r.spent)
      .map((r) => ({
        parentCoinInfo: normalizeHexString(r.coin.parentCoinInfo),
        puzzleHash: normalizeHexString(r.coin.puzzleHash),
        amount: r.coin.amount,
      }));
    const coinString = selectCoinStringForAmount(unspent, amount);
    if (!coinString) {
      log(`[cloud-blockchain] selectCoins: no coin >= ${amount}`);
      return null;
    }
    log(`[cloud-blockchain] selectCoins amount=${amount} coinStringLen=${coinString.length}`);
    return coinString;
  }

  async getHeightInfo(): Promise<bigint> {
    const data = await this.gql<{
      blockchainHeight: { height: number | string | bigint };
    }>(`query { blockchainHeight { height } }`);
    if (data.blockchainHeight?.height == null) {
      throw new Error('blockchainHeight missing height');
    }
    return BigInt(data.blockchainHeight.height);
  }

  async getPuzzleAndSolution(coin: string): Promise<string[] | null> {
    try {
      const coinBytes = toUint8(coin);
      const hashBuf = await crypto.subtle.digest('SHA-256', coinBytes);
      const coinName = toHexString(new Uint8Array(hashBuf));
      const walletId = this.requireWalletId();
      const data = await this.gql<{
        puzzleAndSolution: { puzzleReveal: string; solution: string } | null;
      }>(
        `query($walletId: ID!, $coinId: String!) {
          puzzleAndSolution(walletId: $walletId, coinId: $coinId) {
            puzzleReveal
            solution
          }
        }`,
        { walletId, coinId: coinName },
      );
      const payload = data.puzzleAndSolution;
      if (!payload?.puzzleReveal || !payload?.solution) return null;
      return [normalizeHex(payload.puzzleReveal), normalizeHex(payload.solution)];
    } catch (e) {
      log(`[cloud-blockchain] getPuzzleAndSolution error: ${String(e)}`);
      return null;
    }
  }

  async getCoinRecordsByNames(names: string[]): Promise<CoinRecord[]> {
    const uniqueNames = [...new Set(names.map((n) => normalizeHex(n)).filter(Boolean))];
    if (uniqueNames.length === 0) return [];
    const walletId = this.requireWalletId();
    try {
      const data = await this.gql<{
        coinRecordsByNames: Array<{
          name: string;
          amount: string | number | bigint;
          puzzleHash: string;
          parentCoinName?: string;
          createdBlockHeight?: number | null;
          spentBlockHeight?: number | null;
        }>;
      }>(
        `query($walletId: ID!, $names: [String!]!) {
          coinRecordsByNames(walletId: $walletId, names: $names) {
            name
            amount
            puzzleHash
            parentCoinName
            createdBlockHeight
            spentBlockHeight
          }
        }`,
        { walletId, names: uniqueNames },
      );

      return (data.coinRecordsByNames ?? []).map((r) => {
        const spentHeight = r.spentBlockHeight == null ? 0n : BigInt(r.spentBlockHeight);
        const confirmed = r.createdBlockHeight == null ? 0n : BigInt(r.createdBlockHeight);
        // parentCoinName may be the parent coin id; CoinRecord expects parentCoinInfo.
        const parent = normalizeHex(r.parentCoinName);
        return {
          coin: {
            parentCoinInfo: parent || '0'.repeat(64),
            puzzleHash: normalizeHex(r.puzzleHash),
            amount: BigInt(r.amount),
          },
          confirmedBlockIndex: confirmed,
          spentBlockIndex: spentHeight,
          spent: spentHeight > 0n,
          coinbase: false,
          timestamp: 0n,
        };
      });
    } catch (e) {
      log(`[cloud-blockchain] getCoinRecordsByNames error: ${String(e)}`);
      return [];
    }
  }

  async registerCoins(_names: string[]): Promise<void> {
    // Cloud indexing replaces remote-wallet registration.
  }

  async rememberLocalRemovals(_spendBundle: unknown): Promise<void> {
    // No WC pushTransactions metadata needed for Cloud broadcast.
  }

  async spend(
    _blob: string,
    spendBundle: unknown,
    _changePuzzleHash: string,
    source?: string,
    fee?: bigint,
  ): Promise<string> {
    const feeValue = fee || 0n;
    if (feeValue !== 0n) {
      throw new Error('Cloud Wallet v1 does not support nonzero external fees');
    }
    const walletId = this.requireWalletId();
    const bundle = spendBundle as WalletSpendBundle;
    if (!bundle?.coin_spends?.length) {
      throw new Error('broadcastSpendBundle: empty spend bundle');
    }

    const data = await this.gql<{ broadcastSpendBundle: { status: string } }>(
      `mutation($input: BroadcastSpendBundleInput!) {
        broadcastSpendBundle(input: $input) { status }
      }`,
      {
        input: {
          walletId,
          aggregatedSignature: normalizeHex(bundle.aggregated_signature),
          coinSpends: bundle.coin_spends.map((cs) => ({
            coin: {
              parentCoinInfo: normalizeHex(cs.coin.parent_coin_info),
              puzzleHash: normalizeHex(cs.coin.puzzle_hash),
              amount: cs.coin.amount,
            },
            puzzleReveal: normalizeHex(cs.puzzle_reveal),
            solution: normalizeHex(cs.solution),
          })),
        },
      },
    );
    const status = data.broadcastSpendBundle?.status ?? 'unknown';
    log(`[cloud-blockchain] broadcastSpendBundle from=${source ?? 'unknown'} status=${status}`);
    return status;
  }

  private openApprovePopup(signatureRequestId: string): Window | null {
    const url = signatureRequestApproveUrl(signatureRequestId);
    const width = 520;
    const height = 720;
    const left = Math.max(0, Math.floor(window.screenX + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.floor(window.screenY + (window.outerHeight - height) / 2));
    return window.open(
      url,
      'chia-gaming-cloud-wallet-approve',
      `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
    );
  }

  private waitForSignatureApproval(signatureRequestId: string): Promise<'approved'> {
    const uiOrigin = new URL(getCloudWalletUiUrl()).origin;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error('Timed out waiting for Cloud Wallet funding approval')));
      }, APPROVE_TIMEOUT_MS);

      const onMessage = (event: MessageEvent) => {
        if (event.origin !== uiOrigin) return;
        const data = event.data;
        if (!data || data.type !== SIGNATURE_REQUEST_MESSAGE_TYPE) return;
        const msgId = String(data.signatureRequestId ?? '');
        if (
          msgId &&
          msgId !== signatureRequestId &&
          !signatureRequestId.endsWith(msgId) &&
          !msgId.endsWith(signatureRequestId)
        ) {
          return;
        }
        if (data.status === 'approved') {
          finish(() => resolve('approved'));
          return;
        }
        if (data.status === 'rejected') {
          finish(() => reject(new Error('Cloud Wallet funding approval was rejected')));
          return;
        }
        if (data.status === 'error') {
          finish(() => reject(new Error(data.message || 'Cloud Wallet funding approval failed')));
        }
      };

      window.addEventListener('message', onMessage);
    });
  }

  private async pollSignatureRequestSigned(signatureRequestId: string): Promise<any> {
    const started = Date.now();
    while (Date.now() - started < APPROVE_TIMEOUT_MS) {
      const data = await this.gql<{
        signatureRequest: {
          id: string;
          status: string;
          coinSpends: any[] | null;
        } | null;
      }>(
        `query($id: ID!) {
          signatureRequest(id: $id) {
            id
            status
            coinSpends {
              coin { parentCoinInfo puzzleHash amount }
              puzzleReveal
              solution
            }
          }
        }`,
        { id: signatureRequestId },
      );
      const sr = data.signatureRequest;
      if (!sr) {
        throw new Error('signatureRequest not found');
      }
      const status = sr.status;
      if (status === 'SIGNED' || status === 'SUBMITTED' || status === 'PROCESSING') {
        return sr;
      }
      if (status === 'CANCELLED') {
        throw new Error('Cloud Wallet signature request was cancelled');
      }
      await new Promise((r) => setTimeout(r, SR_POLL_MS));
    }
    throw new Error('Timed out polling Cloud Wallet signature request');
  }

  async createOfferForIds(
    _uniqueId: string,
    offer: { [walletId: string]: bigint },
    extraConditions?: Array<{ opcode: bigint; args: string[] }>,
    coinIds?: string[],
    maxHeight?: bigint,
  ): Promise<any | null> {
    const walletId = this.requireWalletId();
    const amount = absAmountFromOffer(offer);
    const conditions = conditionsForGraphql(extraConditions, maxHeight);

    log(
      `[cloud-blockchain] createGamingFundingSpend amount=${amount} conditions=${conditions.length}`,
    );

    const created = await this.gql<{
      createGamingFundingSpend: {
        signatureRequest: { id: string; status: string };
      };
    }>(
      `mutation($input: CreateGamingFundingSpendInput!) {
        createGamingFundingSpend(input: $input) {
          signatureRequest { id status }
        }
      }`,
      {
        input: {
          walletId,
          amount,
          coinIds: coinIds?.map((id) => normalizeHex(id)),
          extraConditions: conditions.length ? conditions : undefined,
          autoSubmit: false,
        },
      },
    );

    const srId = created.createGamingFundingSpend?.signatureRequest?.id;
    if (!srId) {
      throw new Error('createGamingFundingSpend did not return a signatureRequest');
    }

    const popup = this.openApprovePopup(srId);
    if (!popup) {
      throw new Error('Popup blocked — allow popups to approve Cloud Wallet funding');
    }

    // Poll until SIGNED; fail fast on postMessage rejected/error (ignore message timeout).
    const approvalFailure = new Promise<never>((_resolve, reject) => {
      void this.waitForSignatureApproval(srId).catch((e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        if (!/timed out/i.test(err.message)) {
          reject(err);
        }
      });
    });

    let sr: any;
    try {
      sr = await Promise.race([this.pollSignatureRequestSigned(srId), approvalFailure]);
    } finally {
      try {
        popup.close();
      } catch {
        // ignore
      }
    }

    const coinSpends = sr.coinSpends;
    if (!Array.isArray(coinSpends) || coinSpends.length === 0) {
      throw new Error(
        'Cloud Wallet signature request is signed but returned no coinSpends. Vault-less wallets may need a Cloud Wallet API fix.',
      );
    }

    const bundle = coinSpendsToWalletBundle(coinSpends);
    // Attach a synthetic name for logging / WC parity.
    const nameBytes = new TextEncoder().encode(JSON.stringify(bundle));
    const hashBuf = await crypto.subtle.digest('SHA-256', nameBytes);
    const name = toHexString(new Uint8Array(hashBuf));
    log(
      `[cloud-blockchain] createOfferForIds signed bundle name=${name} spends=${bundle.coin_spends.length}`,
    );
    return bundle;
  }

  async beginConnect(_uniqueId: string, fresh = false): Promise<ConnectionSetup> {
    if (fresh) {
      clearCloudWalletAuth();
      this.auth = null;
      this.monitoringReady = false;
      this.fireConnectionChange(false);
    }

    const existing = loadCloudWalletAuth();
    if (existing && !fresh) {
      this.auth = existing;
      return {
        qrUri: 'cloud-wallet://session',
        skipQr: true,
        finalize: async () => {
          try {
            // Refresh if needed via token provider, then resolve wallet + monitor.
            await this.tokenProvider.getAccessToken();
            const walletId = await this.resolveWalletId();
            this.persistAuth({ ...this.auth!, walletId });
            await this.startMonitoring();
          } catch (e) {
            clearCloudWalletAuth();
            this.auth = null;
            this.monitoringReady = false;
            this.fireConnectionChange(false);
            throw e;
          }
        },
      };
    }

    const stored = loadCloudWalletConfig();
    return {
      qrUri: 'cloud-wallet://oauth',
      skipQr: true,
      title: 'Cloud Wallet',
      description: 'Enter your Cloud Wallet OAuth settings, then sign in via the popup.',
      fields: {
        clientId: {
          type: 'string',
          label: 'OAuth client ID',
          default: stored?.clientId ?? getCloudWalletClientId(),
        },
        apiUrl: {
          type: 'string',
          label: 'Cloud Wallet API URL',
          default: getCloudWalletApiUrl(),
        },
        uiUrl: {
          type: 'string',
          label: 'Cloud Wallet UI URL',
          default: getCloudWalletUiUrl(),
        },
      },
      finalize: async (values?: Record<string, string | bigint>) => {
        const clientId = String(values?.clientId ?? getCloudWalletClientId()).trim();
        const apiUrl = String(values?.apiUrl ?? getCloudWalletApiUrl()).trim();
        const uiUrl = String(values?.uiUrl ?? getCloudWalletUiUrl()).trim();
        if (!clientId) {
          throw new Error('Cloud Wallet OAuth client ID is required');
        }
        saveCloudWalletConfig({ clientId, apiUrl, uiUrl });

        const tokens = await beginOAuthPopupLogin();
        this.auth = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          walletId: tokens.walletId,
        };
        await this.resolveWalletId();
        this.persistAuth(tokens);
        await this.startMonitoring();
      },
    };
  }

  async disconnect(): Promise<void> {
    clearCloudWalletAuth();
    this.auth = null;
    this.monitoringReady = false;
    this.blockchainAddressData = { puzzleHash: '' };
    this.fireConnectionChange(false);
  }

  isConnected(): boolean {
    return this.monitoringReady && !!this.auth?.walletId;
  }

  onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.connectionListeners.add(cb);
    return () => {
      this.connectionListeners.delete(cb);
    };
  }

  isReadyForPlay(): boolean {
    return this.lastConnectedState;
  }

  onPlayReadinessChange(cb: (ready: boolean) => void): () => void {
    this.readinessListeners.add(cb);
    return () => {
      this.readinessListeners.delete(cb);
    };
  }
}

export const cloudBlockchainInfo = new CloudBlockchainInterface();
