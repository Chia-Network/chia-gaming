import {
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
  ConnectionSetup,
  WalletFeeSourceOutcome,
  WalletSubmitOutcome,
} from '../types/ChiaGaming';
import { CoinRecord } from '../types/rpc/CoinRecord';
import { WalletSpendBundle } from '../types/rpc/PushTransactions';
import { log } from '../services/log';
import { toUint8, toHexString } from '../util';
import { jsonStringify } from '../util/jsonSafe';
import {
  beginOAuthPopupLogin,
  CloudWalletAuthError,
  CloudWalletResponseError,
  CloudWalletTransportError,
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
  saveCloudWalletConfig,
} from './cloudWalletConfig';
import {
  clearCloudWalletAuth,
  loadCloudWalletAuth,
  saveCloudWalletAuth,
  type CloudWalletAuthState,
} from './cloudWalletAuth';
import {
  CLOUD_WALLET_API_URL,
  CLOUD_WALLET_CLIENT_ID,
  CLOUD_WALLET_UI_URL,
} from '../constants/env';
import {
  absAmountFromOffer,
  conditionsForGraphql,
  jsonSafeVariables,
  serializeClvmCondition,
} from './cloudWalletHelpers';

export {
  absAmountFromOffer,
  conditionsForGraphql,
  jsonSafeVariables,
  serializeClvmCondition,
} from './cloudWalletHelpers';

const APPROVE_TIMEOUT_MS = 10 * 60 * 1000;
const SR_POLL_MS = 1500;

const ACCEPTED_BROADCAST_STATUSES = new Set([
  'SUCCESS',
  'SUBMITTED',
  'PENDING',
  'PROCESSING',
  'OK',
]);
const REJECTED_BROADCAST_STATUSES = new Set(['FAILED', 'REJECTED', 'REFUSED']);

type CoinsetCoinRecord = {
  coin?: {
    parent_coin_info?: unknown;
    puzzle_hash?: unknown;
    amount?: unknown;
  };
  confirmed_block_index?: unknown;
  spent_block_index?: unknown;
  spent?: unknown;
  coinbase?: unknown;
  timestamp?: unknown;
};

function coinRecordFromCoinset(record: CoinsetCoinRecord): CoinRecord {
  const parentCoinInfo = normalizeHex(record.coin?.parent_coin_info);
  const puzzleHash = normalizeHex(record.coin?.puzzle_hash);
  if (
    parentCoinInfo.length !== 64 ||
    puzzleHash.length !== 64 ||
    record.coin?.amount == null ||
    record.confirmed_block_index == null ||
    record.spent_block_index == null ||
    typeof record.spent !== 'boolean' ||
    typeof record.coinbase !== 'boolean' ||
    record.timestamp == null
  ) {
    throw new Error('Coinset returned an incomplete coin record');
  }
  return {
    coin: {
      parentCoinInfo,
      puzzleHash,
      amount: BigInt(record.coin.amount as string | number | bigint),
    },
    confirmedBlockIndex: BigInt(record.confirmed_block_index as string | number | bigint),
    spentBlockIndex: BigInt(record.spent_block_index as string | number | bigint),
    spent: record.spent,
    coinbase: record.coinbase,
    timestamp: BigInt(record.timestamp as string | number | bigint),
  };
}

function isExactDuplicateTransaction(detail: string): boolean {
  return (
    /\bALREADY_INCLUDING_TRANSACTION\b/i.test(detail) ||
    /\bduplicate transaction\b/i.test(detail) ||
    /\btransaction (?:is |was |has been )?already (?:included|in (?:the )?mempool)\b/i.test(detail)
  );
}

function cloudErrorDetail(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return [...new Set(parts)].join(': ');
}

export function classifyCloudWalletSubmitError(error: unknown): WalletSubmitOutcome {
  const detail = cloudErrorDetail(error);
  if (error instanceof CloudWalletTransportError) {
    return { status: 'unavailable', detail };
  }
  if (isExactDuplicateTransaction(detail)) {
    return { status: 'acknowledged', detail };
  }
  const fallback =
    error instanceof CloudWalletResponseError
      ? 'Cloud Wallet rejected the submission'
      : 'Cloud Wallet submission failed without a transport origin';
  return { status: 'rejected', detail: detail || fallback };
}

export class CloudBlockchainInterface implements InternalBlockchainInterface {
  readonly fundingMode = 'offer-settlement' as const;
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

  private async coinset<T>(endpoint: string, request: Record<string, unknown>): Promise<T> {
    if (!endpoint || endpoint.includes('/')) {
      throw new Error(`Coinset endpoint must be an unprefixed name: ${endpoint}`);
    }
    if (!request || Array.isArray(request) || typeof request !== 'object') {
      throw new Error('Coinset request must be an object');
    }
    const data = await this.gql<{ coinset: { response: T } | null }>(
      `mutation Coinset($input: CoinsetInput!) {
        coinset(input: $input) { response }
      }`,
      {
        input: {
          walletId: this.requireWalletId(),
          endpoint,
          request,
        },
      },
    );
    if (!data.coinset || data.coinset.response === undefined) {
      throw new Error(`Malformed Coinset ${endpoint} response`);
    }
    return data.coinset.response;
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
    log(`[cloud-blockchain] selectCoins ignored amount=${amount}; createOffer selects its inputs`);
    return null;
  }

  async getHeightInfo(): Promise<bigint> {
    const response = await this.coinset<{
      success?: boolean;
      blockchain_state?: { peak?: { height?: unknown } | null };
    }>('get_blockchain_state', {});
    const height = response.blockchain_state?.peak?.height;
    if (response.success !== true || height == null) {
      throw new Error('Malformed Coinset get_blockchain_state response');
    }
    return BigInt(height as string | number | bigint);
  }

  async getPuzzleAndSolution(coin: string): Promise<string[] | null> {
    try {
      const coinBytes = toUint8(coin);
      const hashBuf = await crypto.subtle.digest('SHA-256', coinBytes);
      const coinName = toHexString(new Uint8Array(hashBuf));
      const recordResponse = await this.coinset<{
        success?: boolean;
        coin_record?: CoinsetCoinRecord | null;
      }>('get_coin_record_by_name', { name: coinName });
      if (recordResponse.success !== true) {
        throw new Error('Coinset get_coin_record_by_name failed');
      }
      if (!recordResponse.coin_record) return null;
      const record = coinRecordFromCoinset(recordResponse.coin_record);
      if (!record.spent || record.spentBlockIndex === 0n) return null;

      const response = await this.coinset<{
        success?: boolean;
        coin_solution?: { puzzle_reveal?: unknown; solution?: unknown } | null;
      }>('get_puzzle_and_solution', {
        coin_id: coinName,
        height: Number(record.spentBlockIndex),
      });
      const payload = response.coin_solution;
      if (response.success !== true || !payload?.puzzle_reveal || !payload.solution) return null;
      return [normalizeHex(payload.puzzle_reveal), normalizeHex(payload.solution)];
    } catch (e) {
      log(`[cloud-blockchain] getPuzzleAndSolution error: ${String(e)}`);
      return null;
    }
  }

  async getCoinRecordsByNames(names: string[]): Promise<CoinRecord[]> {
    const uniqueNames = [...new Set(names.map((n) => normalizeHex(n)).filter(Boolean))];
    if (uniqueNames.length === 0) return [];
    try {
      if (uniqueNames.length === 1) {
        const response = await this.coinset<{
          success?: boolean;
          coin_record?: CoinsetCoinRecord | null;
        }>('get_coin_record_by_name', { name: uniqueNames[0] });
        if (response.success !== true) {
          throw new Error('Coinset get_coin_record_by_name failed');
        }
        return response.coin_record ? [coinRecordFromCoinset(response.coin_record)] : [];
      }

      const response = await this.coinset<{
        success?: boolean;
        coin_records?: CoinsetCoinRecord[];
      }>('get_coin_records_by_names', {
        names: uniqueNames,
        include_spent_coins: true,
      });
      if (response.success !== true || !Array.isArray(response.coin_records)) {
        throw new Error('Malformed Coinset get_coin_records_by_names response');
      }
      return response.coin_records.map(coinRecordFromCoinset);
    } catch (e) {
      const message = `Coinset coin-record batch failed: ${String(e)}`;
      log(`[cloud-blockchain] getCoinRecordsByNames error: ${message}`);
      throw new Error(message, { cause: e });
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
  ): Promise<WalletSubmitOutcome> {
    try {
      const feeValue = fee || 0n;
      const bundle = spendBundle as WalletSpendBundle;
      if (!bundle?.coin_spends?.length) {
        return { status: 'rejected', detail: 'push_tx: empty spend bundle' };
      }

      const response = await this.coinset<{
        success?: unknown;
        status?: unknown;
        error?: unknown;
      }>('push_tx', { spend_bundle: bundle });
      const status = response.status;
      log(
        `[cloud-blockchain] push_tx from=${source ?? 'unknown'} success=${String(response.success)} status=${String(status)} spends=${bundle.coin_spends.length} fee=${feeValue}`,
      );
      const detail =
        typeof response.error === 'string'
          ? response.error
          : typeof status === 'string'
            ? status
            : jsonStringify(response);
      if (response.success === true) {
        return { status: 'acknowledged', detail };
      }
      if (isExactDuplicateTransaction(detail)) {
        return { status: 'acknowledged', detail };
      }
      if (response.success !== false) {
        return {
          status: 'rejected',
          detail: 'Malformed Coinset push_tx response',
        };
      }
      const normalizedStatus = typeof status === 'string' ? status.toUpperCase() : '';
      if (ACCEPTED_BROADCAST_STATUSES.has(normalizedStatus)) {
        return { status: 'acknowledged', detail: normalizedStatus };
      }
      if (REJECTED_BROADCAST_STATUSES.has(normalizedStatus)) {
        return {
          status: 'rejected',
          detail: `Coinset push_tx rejected: status=${detail}`,
        };
      }
      return {
        status: 'rejected',
        detail: `Coinset push_tx rejected: ${detail}`,
      };
    } catch (error) {
      return classifyCloudWalletSubmitError(error);
    }
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

  private async pollSignatureRequestOffer(
    signatureRequestId: string,
  ): Promise<{ offer: string; tradeId: string }> {
    const started = Date.now();
    while (Date.now() - started < APPROVE_TIMEOUT_MS) {
      const data = await this.gql<{
        signatureRequest: {
          id: string;
          status: string;
          transaction: {
            offer: {
              bech32: string;
              offerId: string;
            } | null;
          } | null;
        } | null;
      }>(
        `query($id: ID!) {
          signatureRequest(id: $id) {
            id
            status
            transaction {
              offer { bech32 offerId }
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
      const offer = sr.transaction?.offer?.bech32;
      const offerId = sr.transaction?.offer?.offerId;
      if (
        status === 'SUBMITTED' &&
        typeof offer === 'string' &&
        offer.startsWith('offer') &&
        typeof offerId === 'string' &&
        offerId
      ) {
        return { offer, tradeId: offerId };
      }
      if (status === 'CANCELLED' || status === 'REJECTED' || status === 'FAILED') {
        throw new Error(`Cloud Wallet signature request ended with status ${status}`);
      }
      await new Promise((r) => setTimeout(r, SR_POLL_MS));
    }
    throw new Error('Timed out polling Cloud Wallet signed offer');
  }

  private async createCloudOffer(
    input: {
      offered: Array<{ amount: bigint }>;
      requested: Array<{ amount: bigint }>;
      fee?: bigint;
      extraConditions?: string[];
    },
    source = 'funding',
  ): Promise<{ offer: string; tradeId: string }> {
    const walletId = this.requireWalletId();
    log(`[cloud-blockchain] createOffer source=${source} input=${jsonStringify(input)}`);

    const created = await this.gql<{
      createOffer: {
        signatureRequest: { id: string; status: string };
      };
    }>(
      `mutation($input: CreateOfferInput!) {
        createOffer(input: $input) {
          signatureRequest { id status }
        }
      }`,
      {
        input: {
          walletId,
          offered: input.offered,
          requested: input.requested,
          fee: input.fee,
          extraConditions: input.extraConditions?.length ? input.extraConditions : undefined,
        },
      },
    );

    const srId = created.createOffer?.signatureRequest?.id;
    if (!srId) {
      throw new Error('createOffer did not return a signatureRequest');
    }

    const popup = this.openApprovePopup(srId);
    if (!popup) {
      throw new Error(`Popup blocked — allow popups to approve Cloud Wallet ${source}`);
    }

    // Poll until the signed offer is persisted; fail fast on postMessage
    // rejected/error (ignore its timeout because GraphQL polling is authoritative).
    const approvalFailure = new Promise<never>((_resolve, reject) => {
      void this.waitForSignatureApproval(srId).catch((e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        if (!/timed out/i.test(err.message)) {
          reject(err);
        }
      });
    });

    try {
      return await Promise.race([this.pollSignatureRequestOffer(srId), approvalFailure]);
    } finally {
      try {
        popup.close();
      } catch {
        // ignore
      }
    }
  }

  async createOfferForIds(
    _uniqueId: string,
    offer: { [walletId: string]: bigint },
    extraConditions?: Array<{ opcode: bigint; args: string[] }>,
    _coinIds?: string[],
    maxHeight?: bigint,
    _openingFee = 0n,
  ): Promise<{ offer: string; tradeId: string }> {
    const amount = absAmountFromOffer(offer);
    const conditions = conditionsForGraphql(extraConditions, maxHeight);
    return this.createCloudOffer({
      offered: [{ amount }],
      requested: [],
      extraConditions: conditions,
    });
  }

  async createFeeSpend(
    fee: bigint,
    concurrentSpendCoinId: string,
  ): Promise<WalletFeeSourceOutcome | null> {
    if (fee <= 0n) return null;
    const targetCoinId = normalizeHex(concurrentSpendCoinId);
    try {
      const result = await this.createCloudOffer(
        {
          offered: [],
          requested: [],
          fee,
          extraConditions: conditionsForGraphql([{ opcode: 64n, args: [targetCoinId] }], undefined),
        },
        'fee',
      );
      return { kind: 'offer', ...result };
    } catch (error) {
      const reason = cloudErrorDetail(error);
      if (error instanceof CloudWalletTransportError) {
        return { kind: 'unavailable', reason };
      }
      return { kind: 'failure', reason };
    }
  }

  async cancelOffer(offerId: string): Promise<void> {
    await this.gql<{ cancelOffer: unknown }>(
      `mutation($input: CancelOfferInput!) {
        cancelOffer(input: $input) {
          signatureRequest { id }
        }
      }`,
      {
        input: {
          walletId: this.requireWalletId(),
          offerId,
          fee: 0n,
          cancelOffChain: true,
        },
      },
    );
  }

  async beginConnect(_uniqueId: string, fresh = false): Promise<ConnectionSetup> {
    if (fresh) {
      clearCloudWalletAuth();
      this.auth = null;
      this.monitoringReady = false;
      this.fireConnectionChange(false);
      saveCloudWalletConfig({
        clientId: CLOUD_WALLET_CLIENT_ID,
        apiUrl: CLOUD_WALLET_API_URL,
        uiUrl: CLOUD_WALLET_UI_URL,
      });
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

    return {
      qrUri: 'cloud-wallet://oauth',
      skipQr: true,
      title: 'Cloud Wallet',
      description: 'Sign in through the Cloud Wallet popup.',
      finalize: async () => {
        const clientId = getCloudWalletClientId();
        if (!clientId) {
          throw new Error('Cloud Wallet OAuth client ID is required');
        }

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
