import {
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
  ConnectionSetup,
} from '../types/ChiaGaming';
import { CoinRecord } from '../types/rpc/CoinRecord';
import { WalletSpendBundle } from '../types/rpc/PushTransactions';
import { log } from '../services/log';
import { normalizeHexString, toUint8, toHexString } from '../util';
import { jsonStringify } from '../util/jsonSafe';
import {
  beginOAuthPopupLogin,
  CloudWalletAuthError,
  createAuthTokenProvider,
  fetchFirstConsentedWalletId,
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
import { getDefaultFee, setDefaultFee } from './save';
import {
  absAmountFromOffer,
  coinSpendsToWalletBundle,
  conditionsForGraphql,
  jsonSafeVariables,
  selectCoinStringForAmount,
  coinSpendsFromSignatureRequest,
} from './cloudWalletHelpers';

export {
  absAmountFromOffer,
  coinSpendsToWalletBundle,
  conditionsForGraphql,
  jsonSafeVariables,
  selectCoinStringForAmount,
  coinSpendsFromSignatureRequest,
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

  /**
   * Fee applied to the Cloud Wallet funding spend, in mojos. Read from the
   * global preference at call time: this interface is a module-level singleton,
   * so caching would miss later edits from the Wallet tab or connect modal.
   */
  private getFee(): bigint {
    return getDefaultFee();
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
      // A failed read is not an answer about this wallet, so it propagates
      // rather than falling through: substituting the grant's first wallet on a
      // blip would persist it over the selected one and send later funding
      // spends to a wallet the user never chose.
      const data = await this.gql<{ wallet: { id: string } | null }>(
        `query($id: ID!) { wallet(id: $id) { id } }`,
        { id: stored },
      );
      if (data.wallet?.id) return data.wallet.id;
      log(`[cloud-blockchain] stored walletId ${stored} is not in this grant`);
    }

    // There was no stored id, or the grant read back no such wallet. Ask the
    // grant which wallets it covers, exactly as the initial OAuth login does. A
    // transient failure here propagates as itself rather than as a verdict on
    // the grant.
    const resolved = await fetchFirstConsentedWalletId(this.tokenProvider);
    if (resolved) return resolved;

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
    // The funding spend pins this coin via coinIds, and the Cloud Wallet API
    // rejects pinned coins whose total is below amount + fee (it supplements
    // only the unpinned path). Pick a coin large enough to also cover the fee.
    const requiredAmount = amount + this.getFee();
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
    const coinString = selectCoinStringForAmount(unspent, requiredAmount);
    if (!coinString) {
      log(`[cloud-blockchain] selectCoins: no coin >= ${requiredAmount}`);
      return null;
    }
    log(
      `[cloud-blockchain] selectCoins amount=${amount} fee=${this.getFee()} required=${requiredAmount} coinStringLen=${coinString.length}`,
    );
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

      const records: CoinRecord[] = [];
      for (const r of data.coinRecordsByNames ?? []) {
        const spentHeight = r.spentBlockHeight == null ? 0n : BigInt(r.spentBlockHeight);
        const confirmed = r.createdBlockHeight == null ? 0n : BigInt(r.createdBlockHeight);
        // parentCoinName is the parent coin id; CoinRecord expects parentCoinInfo.
        const parent = normalizeHex(r.parentCoinName);
        const puzzleHash = normalizeHex(r.puzzleHash);
        if (parent.length !== 64 || puzzleHash.length !== 64) {
          log(
            `[cloud-blockchain] getCoinRecordsByNames skipping record with incomplete coin identity name=${normalizeHex(r.name)} parentLen=${parent.length} phLen=${puzzleHash.length}`,
          );
          continue;
        }
        records.push({
          coin: {
            parentCoinInfo: parent,
            puzzleHash,
            amount: BigInt(r.amount),
          },
          confirmedBlockIndex: confirmed,
          spentBlockIndex: spentHeight,
          spent: spentHeight > 0n,
          coinbase: false,
          timestamp: 0n,
        });
      }
      return records;
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
          aggregatedSignature: string | null;
          signedSpendBundle: {
            aggregatedSignature: string;
            coinSpends: any[];
          } | null;
        } | null;
      }>(
        `query($id: ID!) {
          signatureRequest(id: $id) {
            id
            status
            aggregatedSignature
            signedSpendBundle {
              aggregatedSignature
              coinSpends {
                coin { parentCoinInfo puzzleHash amount }
                puzzleReveal
                solution
              }
            }
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
      log(`[cloud-blockchain] signatureRequest id=${sr.id} status=${status}`);
      if (status === 'SIGNED') {
        return sr;
      }
      if (status === 'SUBMITTED' || status === 'PROCESSING') {
        log(
          `[cloud-blockchain] signatureRequest already ${status}; approval may have broadcast a 2-spend that will conflict with the combined funding bundle`,
        );
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
    const fee = this.getFee();

    log(
      `[cloud-blockchain] createSpendWithExtraConditions amount=${amount} fee=${fee} conditions=${jsonStringify(conditions)}`,
    );

    const created = await this.gql<{
      createSpendWithExtraConditions: {
        signatureRequest: { id: string; status: string };
      };
    }>(
      `mutation($input: CreateSpendWithExtraConditionsInput!) {
        createSpendWithExtraConditions(input: $input) {
          signatureRequest { id status }
        }
      }`,
      {
        input: {
          walletId,
          amount,
          fee: fee > 0n ? fee : undefined,
          coinIds: coinIds?.map((id) => normalizeHex(id)),
          extraConditions: conditions.length ? conditions : undefined,
          autoSubmit: false,
        },
      },
    );

    const srId = created.createSpendWithExtraConditions?.signatureRequest?.id;
    if (!srId) {
      throw new Error('createSpendWithExtraConditions did not return a signatureRequest');
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

    // Prefer the complete signedSpendBundle: for vault wallets it includes the custody
    // (singleton) coin spend. signatureRequest.coinSpends omits that spend (clear-signing);
    // using it alone is rejected by the full node with MESSAGE_NOT_SENT_OR_RECEIVED.
    const signed = sr.signedSpendBundle;
    const coinSpends = coinSpendsFromSignatureRequest(sr);

    // Use the vault's real aggregated signature from the signed request. Without it the wasm cradle
    // rejects the bundle (StrErr("bad aggsig length")) and the funding spend would be invalid; the
    // NIL fallback inside coinSpendsToWalletBundle only applies when the wallet cannot supply one.
    const aggregatedSignature = signed?.aggregatedSignature ?? sr.aggregatedSignature;
    const bundle = coinSpendsToWalletBundle(coinSpends, aggregatedSignature);
    // Attach a synthetic name for logging / WC parity. Use the BigInt-safe serializer because the
    // bundle carries coin amounts as bigint, which a raw JSON.stringify cannot serialize.
    const nameBytes = new TextEncoder().encode(jsonStringify(bundle));
    const hashBuf = await crypto.subtle.digest('SHA-256', nameBytes);
    const name = toHexString(new Uint8Array(hashBuf));
    log(
      `[cloud-blockchain] createOfferForIds signed bundle name=${name} spends=${bundle.coin_spends.length} aggsig=${aggregatedSignature ? 'real' : 'nil'} source=signedSpendBundle srStatus=${sr.status}`,
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
            // Only a dead grant costs the durable refresh token. A network blip
            // or GraphQL failure during silent resume must stay retryable, or a
            // momentary outage forces the user back through a popup login.
            if (e instanceof CloudWalletAuthError) {
              clearCloudWalletAuth();
              this.auth = null;
            }
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
        fee: {
          type: 'bigint',
          label: 'Transaction fee (mojos)',
          default: getDefaultFee(),
        },
      },
      finalize: async (values?: Record<string, string | bigint>) => {
        const clientId = String(values?.clientId ?? getCloudWalletClientId()).trim();
        const apiUrl = String(values?.apiUrl ?? getCloudWalletApiUrl()).trim();
        const uiUrl = String(values?.uiUrl ?? getCloudWalletUiUrl()).trim();
        if (!clientId) {
          throw new Error('Cloud Wallet OAuth client ID is required');
        }
        const feeValue = values?.fee;
        if (feeValue !== undefined) {
          const fee = typeof feeValue === 'bigint' ? feeValue : BigInt(feeValue);
          if (fee < 0n) {
            throw new Error('Transaction fee must be zero or positive');
          }
          setDefaultFee(fee);
        }
        saveCloudWalletConfig({ clientId, apiUrl, uiUrl });

        const tokens = await beginOAuthPopupLogin();
        this.auth = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          walletId: tokens.walletId,
        };
        // Persist the id that actually resolved: the consent screen's choice can
        // differ from what the grant will read back, and monitoring uses this id.
        const walletId = await this.resolveWalletId();
        this.persistAuth({ ...tokens, walletId });
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
