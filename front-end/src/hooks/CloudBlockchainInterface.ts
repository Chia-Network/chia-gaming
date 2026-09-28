import {
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
  ConnectionSetup,
  WalletOfferBeginOutcome,
  WalletOfferCompletion,
  WalletOfferOperation,
  WalletOfferRequest,
  WalletOfferProvider,
  WalletOfferCancellationOutcome,
  WalletOfferCancellationBeginOutcome,
  WalletSubmitOutcome,
} from '../types/ChiaGaming';
import { CoinRecord } from '../types/rpc/CoinRecord';
import { WalletSpendBundle } from '../types/rpc/PushTransactions';
import { log } from '../services/log';
import { toUint8, toHexString } from '../util';
import { jsonStringify } from '../util/jsonSafe';
import { isExactDuplicateTransaction } from '../util/walletSubmit';
import {
  beginOAuthPopupLogin,
  canonicalSignatureRequestId,
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
  loadCloudWalletConfig,
  saveCloudWalletConfig,
} from './cloudWalletConfig';
import {
  clearCloudWalletAuth,
  loadCloudWalletAuth,
  saveCloudWalletAuth,
  type CloudWalletAuthState,
} from './cloudWalletAuth';
import { absAmountFromOffer, conditionsForGraphql, jsonSafeVariables } from './cloudWalletHelpers';

export { serializeClvmCondition } from './cloudWalletHelpers';

export { absAmountFromOffer, conditionsForGraphql, jsonSafeVariables };

const APPROVE_TIMEOUT_MS = 10 * 60 * 1000;
const SR_POLL_MS = 1500;
const MAX_CANCELLATION_ERROR_LENGTH = 512;
const TERMINAL_CANCELLATION_CODES = new Set([
  'ALREADY_CANCELLED',
  'ALREADY_CANCELED',
  'OFFER_ALREADY_CANCELLED',
  'OFFER_ALREADY_CANCELED',
  'OFFER_ALREADY_SPENT',
  'OFFER_NOT_FOUND',
  'UNKNOWN_OFFER',
]);
const FAILED_SIGNATURE_REQUEST_STATUSES = new Set(['CANCELLED', 'REJECTED', 'FAILED']);

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

function boundedCancellationDetail(detail: string): string {
  return detail.slice(0, MAX_CANCELLATION_ERROR_LENGTH);
}

class SignatureRequestUnavailableError extends Error {}
class SignatureRequestRejectedError extends Error {}

function cloudCancellationIsAlreadyTerminal(error: unknown, offerId: string): boolean {
  const seen = new Set<unknown>();
  let matchedCode = false;
  let conflictingOfferId = false;
  const visit = (value: unknown) => {
    if (value == null || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Error) {
      visit((value as Error & { cause?: unknown }).cause);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const code =
      typeof record.code === 'string'
        ? record.code
        : typeof record.errorCode === 'string'
          ? record.errorCode
          : undefined;
    if (code && TERMINAL_CANCELLATION_CODES.has(code.toUpperCase())) matchedCode = true;
    for (const key of ['offerId', 'offer_id', 'tradeId', 'trade_id']) {
      if (typeof record[key] === 'string' && record[key] !== offerId) conflictingOfferId = true;
    }
    visit(record.extensions);
    visit(record.data);
    visit(record.error);
  };
  visit(error);
  return matchedCode && !conflictingOfferId;
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
  private walletOfferProvider: WalletOfferProvider | null = null;
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

  getWalletOfferProvider() {
    const walletId = this.auth?.walletId;
    if (!walletId) return null;
    if (
      this.walletOfferProvider?.scope.provider !== 'cloud' ||
      this.walletOfferProvider.scope.walletId !== walletId
    ) {
      this.walletOfferProvider = {
        capability: 'recoverable-after-begin',
        feeMaterial: 'reserved-offer',
        scope: { provider: 'cloud', walletId },
        beginCreation: (operation, request) => this.beginWalletOffer(operation, request),
        reconcileCreation: (operation, request, recoveryId) =>
          this.reconcileWalletOffer(operation, request, recoveryId),
        beginCancellation: (tradeId) => this.beginWalletOfferCancellation(tradeId),
        reconcileCancellation: (tradeId, recoveryId) =>
          this.reconcileWalletOfferCancellation(tradeId, recoveryId),
      };
    }
    return this.walletOfferProvider;
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
    const data = await this.gql<{ coinset: { response: T | null } | null }>(
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
    if (data.coinset?.response == null) {
      throw new CloudWalletTransportError(`Coinset ${endpoint} returned no response`);
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
    if (response.success !== true) {
      throw new Error('Coinset get_puzzle_and_solution failed');
    }
    const payload = response.coin_solution;
    if (!payload?.puzzle_reveal || !payload.solution) return null;
    return [normalizeHex(payload.puzzle_reveal), normalizeHex(payload.solution)];
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
      `chia-gaming-cloud-wallet-approve-${signatureRequestId}`,
      `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
    );
  }

  private waitForSignatureApproval(
    signatureRequestId: string,
    source: string,
    popup: Window,
  ): { promise: Promise<'approved'>; dispose: () => void } {
    const uiOrigin = new URL(getCloudWalletUiUrl()).origin;
    let dispose = () => {};
    const promise = new Promise<'approved'>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new SignatureRequestUnavailableError(
              `Timed out waiting for Cloud Wallet ${source} approval`,
            ),
          ),
        );
      }, APPROVE_TIMEOUT_MS);

      const onMessage = (event: MessageEvent) => {
        if (event.origin !== uiOrigin || event.source !== popup) return;
        const data = event.data;
        if (!data || data.type !== SIGNATURE_REQUEST_MESSAGE_TYPE) return;
        const msgId = typeof data.signatureRequestId === 'string' ? data.signatureRequestId : '';
        if (
          msgId.length === 0 ||
          canonicalSignatureRequestId(msgId) !== canonicalSignatureRequestId(signatureRequestId)
        ) {
          return;
        }
        if (data.status === 'approved') {
          finish(() => resolve('approved'));
          return;
        }
        if (data.status === 'rejected') {
          finish(() =>
            reject(
              new SignatureRequestRejectedError(`Cloud Wallet ${source} approval was rejected`),
            ),
          );
          return;
        }
        if (data.status === 'error') {
          finish(() =>
            reject(
              new SignatureRequestUnavailableError(
                data.message || `Cloud Wallet ${source} approval failed`,
              ),
            ),
          );
        }
      };

      window.addEventListener('message', onMessage);
      dispose = () => finish(() => {});
    });
    return { promise, dispose };
  }

  private async trackSignatureRequest<T>(
    signatureRequestId: string,
    source: string,
    poll: () => Promise<T>,
  ): Promise<T> {
    const popup = this.openApprovePopup(signatureRequestId);
    if (!popup) {
      throw new SignatureRequestUnavailableError(
        `Popup blocked — allow popups to approve Cloud Wallet ${source}`,
      );
    }
    const approval = this.waitForSignatureApproval(signatureRequestId, source, popup);
    const approvalFailure = new Promise<never>((_resolve, reject) => {
      void approval.promise.catch((error: unknown) => {
        if (
          error instanceof SignatureRequestUnavailableError &&
          /^Timed out waiting/.test(error.message)
        ) {
          return;
        }
        reject(error);
      });
    });
    try {
      return await Promise.race([poll(), approvalFailure]);
    } finally {
      approval.dispose();
      try {
        popup.close();
      } catch {
        // ignore
      }
    }
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
      if (!sr || sr.id !== signatureRequestId) {
        throw new SignatureRequestUnavailableError('signatureRequest temporarily not found');
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
        throw new SignatureRequestRejectedError(
          `Cloud Wallet signature request ended with status ${status}`,
        );
      }
      await new Promise((r) => setTimeout(r, SR_POLL_MS));
    }
    throw new SignatureRequestUnavailableError('Timed out polling Cloud Wallet signed offer');
  }

  private async beginCloudOffer(
    input: {
      offered: Array<{ amount: bigint }>;
      requested: Array<{ amount: bigint }>;
      fee?: bigint;
      extraConditions?: string[];
    },
    source = 'funding',
  ): Promise<{ kind: 'pending'; recoveryId: string }> {
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

    const createOffer = created.createOffer;
    if (!createOffer) {
      throw new Error('createOffer mutation returned no result');
    }
    const signatureRequest = createOffer.signatureRequest;
    const srId = signatureRequest?.id;
    if (typeof srId !== 'string' || !srId) {
      throw new SignatureRequestUnavailableError(
        'createOffer succeeded without a signatureRequest ID',
      );
    }

    return { kind: 'pending', recoveryId: srId };
  }

  async beginWalletOffer(
    _operation: WalletOfferOperation,
    request: WalletOfferRequest,
  ): Promise<Exclude<WalletOfferBeginOutcome, { kind: 'created-ephemeral' }>> {
    if (request.kind === 'funding') {
      try {
        const amount = absAmountFromOffer(request.offer);
        const conditions = conditionsForGraphql(request.extraConditions, request.maxHeight);
        return await this.beginCloudOffer({
          offered: [{ amount }],
          requested: [],
          extraConditions: conditions,
        });
      } catch (error) {
        const reason = cloudErrorDetail(error);
        return error instanceof CloudWalletTransportError ||
          error instanceof SignatureRequestUnavailableError
          ? { kind: 'unavailable', reason }
          : { kind: 'failure', reason };
      }
    }
    if (request.fee <= 0n) {
      return { kind: 'failure', reason: 'fee must be positive' };
    }
    const targetCoinId = normalizeHex(request.concurrentSpendCoinId);
    try {
      return await this.beginCloudOffer(
        {
          offered: [],
          requested: [],
          fee: request.fee,
          extraConditions: conditionsForGraphql([{ opcode: 64n, args: [targetCoinId] }], undefined),
        },
        'fee',
      );
    } catch (error) {
      const reason = cloudErrorDetail(error);
      if (
        error instanceof CloudWalletTransportError ||
        error instanceof SignatureRequestUnavailableError
      ) {
        return { kind: 'unavailable', reason };
      }
      return { kind: 'failure', reason };
    }
  }

  async reconcileWalletOffer(
    _operation: WalletOfferOperation,
    request: WalletOfferRequest,
    recoveryId: string,
  ): Promise<Exclude<WalletOfferCompletion, { kind: 'created-ephemeral' }>> {
    try {
      const result = await this.trackSignatureRequest(recoveryId, request.kind, () =>
        this.pollSignatureRequestOffer(recoveryId),
      );
      return {
        kind: 'created-reserved',
        material: { kind: 'offer', offer: result.offer },
        tradeId: result.tradeId,
      };
    } catch (error) {
      const reason = cloudErrorDetail(error);
      return error instanceof SignatureRequestRejectedError
        ? { kind: 'failure', reason }
        : { kind: 'unavailable', reason };
    }
  }

  private async pollCancellationSignatureRequest(
    signatureRequestId: string,
  ): Promise<WalletOfferCancellationOutcome> {
    const started = Date.now();
    while (Date.now() - started < APPROVE_TIMEOUT_MS) {
      const data = await this.gql<{
        signatureRequest: { id: string; status: string } | null;
      }>(
        `query($id: ID!) {
          signatureRequest(id: $id) {
            id
            status
          }
        }`,
        { id: signatureRequestId },
      );
      const request = data.signatureRequest;
      if (!request || request.id !== signatureRequestId) {
        throw new SignatureRequestUnavailableError(
          'Cloud Wallet cancellation signatureRequest is temporarily unavailable',
        );
      }
      if (
        typeof request.status !== 'string' ||
        request.status.length === 0 ||
        request.status.length > 64
      ) {
        throw new SignatureRequestUnavailableError(
          'Cloud Wallet returned an incomplete cancellation signatureRequest',
        );
      }
      const status = request.status.toUpperCase();
      log(`[cloud-blockchain] cancellation signatureRequest id=${request.id} status=${status}`);
      if (status === 'SUBMITTED') {
        return { status: 'cancelled', detail: status };
      }
      if (FAILED_SIGNATURE_REQUEST_STATUSES.has(status)) {
        return {
          status: 'rejected',
          detail: `Cloud Wallet cancellation ended with status ${status}`,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, SR_POLL_MS));
    }
    return {
      status: 'unavailable',
      detail: 'Timed out polling Cloud Wallet cancellation',
    };
  }

  async beginWalletOfferCancellation(
    offerId: string,
  ): Promise<WalletOfferCancellationBeginOutcome> {
    try {
      const data = await this.gql<{
        cancelOffer: { signatureRequest: { id: string; status: string } | null } | null;
      }>(
        `mutation($input: CancelOfferInput!) {
          cancelOffer(input: $input) {
            signatureRequest { id status }
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
      const request = data.cancelOffer?.signatureRequest;
      if (
        !request ||
        typeof request.id !== 'string' ||
        request.id.length === 0 ||
        request.id.length > MAX_CANCELLATION_ERROR_LENGTH ||
        typeof request.status !== 'string' ||
        request.status.length === 0 ||
        request.status.length > 64
      ) {
        return {
          status: 'rejected',
          detail: 'Cloud Wallet cancelOffer returned an invalid signatureRequest',
        };
      }
      const initialStatus = request.status.toUpperCase();
      if (initialStatus === 'SUBMITTED') {
        return { status: 'cancelled', detail: initialStatus };
      }
      if (FAILED_SIGNATURE_REQUEST_STATUSES.has(initialStatus)) {
        return {
          status: 'rejected',
          detail: `Cloud Wallet cancellation ended with status ${initialStatus}`,
        };
      }
      return { status: 'pending', recoveryId: request.id };
    } catch (error) {
      const detail = boundedCancellationDetail(cloudErrorDetail(error));
      if (cloudCancellationIsAlreadyTerminal(error, offerId)) {
        return { status: 'already-terminal', detail };
      }
      if (
        error instanceof CloudWalletTransportError ||
        error instanceof SignatureRequestUnavailableError
      ) {
        return { status: 'unavailable', detail };
      }
      return { status: 'rejected', detail };
    }
  }

  async reconcileWalletOfferCancellation(
    _offerId: string,
    recoveryId: string,
  ): Promise<WalletOfferCancellationOutcome> {
    try {
      return await this.trackSignatureRequest(recoveryId, 'offer cancellation', () =>
        this.pollCancellationSignatureRequest(recoveryId),
      );
    } catch (error) {
      const detail = boundedCancellationDetail(cloudErrorDetail(error));
      return error instanceof SignatureRequestRejectedError
        ? { status: 'rejected', detail }
        : { status: 'unavailable', detail };
    }
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
      },
      finalize: async (values) => {
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
    this.walletOfferProvider = null;
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
