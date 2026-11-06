import { log } from '../../services/log';
import { CoinsetClient } from './coinsetClient';
import {
  BlockchainInboundAddressResult,
  ConnectionSetup,
  InternalBlockchainInterface,
  WalletOfferBeginOutcome,
  WalletOfferCancellationBeginOutcome,
  WalletOfferCancellationOutcome,
  WalletOfferCompletion,
  WalletOfferOperation,
  WalletOfferProvider,
  WalletOfferRequest,
  WalletSubmitOutcome,
} from '../../types/ChiaGaming';
import { CoinRecord } from '../../types/rpc/CoinRecord';
import { WalletSpendBundle } from '../../types/rpc/PushTransactions';
import { jsonStringify } from '../../util/jsonSafe';
import { isExactDuplicateTransaction } from '../../util/walletSubmit';
import {
  clearCloudWalletAuth,
  loadCloudWalletAuth,
  saveCloudWalletAuth,
  type CloudWalletAuthState,
} from './cloudWalletAuth';
import { getCloudWalletUiUrl } from './cloudWalletConfig';
import { absAmountFromOffer, conditionsForGraphql, jsonSafeVariables } from './cloudWalletHelpers';
import {
  beginOAuthLogin,
  canonicalSignatureRequestId,
  CLOUD_WALLET_LOGIN_CANCELLED,
  CloudWalletAuthError,
  CloudWalletResponseError,
  CloudWalletTransportError,
  createAuthTokenProvider,
  desktopCloudWalletBridge,
  fetchFirstConsentedWalletId,
  graphqlRequest,
  normalizeHex,
  SIGNATURE_REQUEST_MESSAGE_TYPE,
  signatureRequestApproveUrl,
  type TokenProvider,
} from './cloudWalletOAuth';

export { serializeClvmCondition } from './cloudWalletHelpers';

export { absAmountFromOffer, conditionsForGraphql, jsonSafeVariables };

const APPROVE_TIMEOUT_MS = 10 * 60 * 1000;
const SR_POLL_MS = 1500;
/** Shorter than the approval window: a blocked fee holds back a possibly deadline-bound spend. */
const BLOCKED_FEE_POPUP_WAIT_MS = 60 * 1000;
const POPUP_CLOSED_POLL_MS = 500;
const MAX_CANCELLATION_ERROR_LENGTH = 512;
// The wallet's off-chain cancel refusals share BAD_USER_INPUT, so only the message identifies them.
const TERMINAL_CANCELLATION_MESSAGE =
  /^Offer with id ([0-9a-f]+) (?:must be open to cancel off-chain|is not tracked by this wallet|not found|has already been settled)$/;
// An on-chain cancel can still drop from the mempool, so its coins are not released yet.
const ACTIVE_ON_CHAIN_CANCELLATION_MESSAGE = / has an active on-chain transaction$/;
const FAILED_SIGNATURE_REQUEST_STATUSES = new Set(['CANCELLED', 'REJECTED', 'FAILED']);

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
      // A structured cause, such as GraphQL's errors, is already in the message.
      if (typeof current === 'string') parts.push(current);
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

function classifyCancellationError(
  error: unknown,
  offerId: string,
): 'terminal' | 'active-on-chain' | 'refused' | null {
  if (!(error instanceof CloudWalletResponseError)) return null;
  const cause = (error as Error & { cause?: unknown }).cause;
  const walletError = (Array.isArray(cause) ? cause[0] : undefined) as
    { message?: unknown; extensions?: { code?: unknown } } | undefined;
  const code = walletError?.extensions?.code;
  if (code === 'UNAUTHORIZED') return 'refused';
  if (code !== 'BAD_USER_INPUT' || typeof walletError?.message !== 'string') return null;
  const terminal = TERMINAL_CANCELLATION_MESSAGE.exec(walletError.message);
  if (terminal?.[1] === normalizeHex(offerId.replace(/^Offer_/, ''))) return 'terminal';
  return ACTIVE_ON_CHAIN_CANCELLATION_MESSAGE.test(walletError.message)
    ? 'active-on-chain'
    : 'refused';
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

export interface BlockedCloudWalletApproval {
  signatureRequestId: string;
  source: string;
  reason: 'blocked' | 'closed';
  attach: (popup: Window) => void;
}

export interface RefusedCloudCancellation {
  offerId: string;
  detail: string;
}

export class CloudBlockchainInterface implements InternalBlockchainInterface {
  readonly fundingMode = 'offer-settlement' as const;
  blockchainAddressData: BlockchainInboundAddressResult = { puzzleHash: '' };

  private auth: CloudWalletAuthState | null = null;
  private authEpoch = 0;
  private walletOfferProvider: WalletOfferProvider | null = null;
  private readonly approvalsOpenedInBrowser = new Set<string>();
  // Waiters for one signature request share its named window.
  private readonly approvalWindowWaiters = new Map<Window, number>();
  private blockedApprovals: readonly BlockedCloudWalletApproval[] = [];
  private readonly blockedApprovalListeners = new Set<() => void>();
  private refusedCancellations: readonly RefusedCloudCancellation[] = [];
  private readonly refusedCancellationListeners = new Set<() => void>();
  private connectionListeners = new Set<(connected: boolean) => void>();
  private readinessListeners = new Set<(ready: boolean) => void>();
  private lastConnectedState = false;
  private monitoringReady = false;
  /** The fresh or restored sign-in in progress; Cancel aborts either. */
  private loginAbort: AbortController | null = null;
  private tokenProvider: TokenProvider;
  private readonly chain = new CoinsetClient(
    (endpoint, request) => this.coinset(endpoint, request),
    '[cloud-blockchain]',
  );

  constructor() {
    this.auth = loadCloudWalletAuth();
    this.tokenProvider = createAuthTokenProvider(
      () => this.auth,
      (next) => {
        this.auth = next;
        saveCloudWalletAuth(next);
      },
      () => this.authEpoch,
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

  private clearAuth(): void {
    ++this.authEpoch;
    clearCloudWalletAuth();
    this.auth = null;
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

  /** `beforeReady` runs once the wallet is fetched and may throw to stop. */
  async startMonitoring(beforeReady: () => void = () => {}): Promise<void> {
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
    beforeReady();
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
    return this.chain.getHeightInfo();
  }

  async getPuzzleAndSolution(coin: string): Promise<string[] | null> {
    return this.chain.getPuzzleAndSolution(coin);
  }

  async getCoinRecordsByNames(names: string[]): Promise<CoinRecord[]> {
    return this.chain.getCoinRecordsByNames(names);
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
      return await this.chain.pushTx(spendBundle as WalletSpendBundle, source, fee || 0n);
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

  getBlockedApprovals(): readonly BlockedCloudWalletApproval[] {
    return this.blockedApprovals;
  }

  onBlockedApprovalsChange(cb: () => void): () => void {
    this.blockedApprovalListeners.add(cb);
    return () => {
      this.blockedApprovalListeners.delete(cb);
    };
  }

  private setBlockedApprovals(next: readonly BlockedCloudWalletApproval[]): void {
    this.blockedApprovals = next;
    for (const cb of this.blockedApprovalListeners) cb();
  }

  getRefusedCancellations(): readonly RefusedCloudCancellation[] {
    return this.refusedCancellations;
  }

  onRefusedCancellationsChange(cb: () => void): () => void {
    this.refusedCancellationListeners.add(cb);
    return () => {
      this.refusedCancellationListeners.delete(cb);
    };
  }

  dismissRefusedCancellation(offerId: string): void {
    if (!this.refusedCancellations.some((entry) => entry.offerId === offerId)) return;
    this.setRefusedCancellations(
      this.refusedCancellations.filter((entry) => entry.offerId !== offerId),
    );
  }

  private setRefusedCancellations(next: readonly RefusedCloudCancellation[]): void {
    this.refusedCancellations = next;
    for (const cb of this.refusedCancellationListeners) cb();
  }

  /** Call from a click handler: browsers allow one popup per recent user gesture. */
  openBlockedApproval(): boolean {
    const next = this.blockedApprovals[0];
    if (!next) return true;
    const popup = this.openApprovePopup(next.signatureRequestId);
    if (!popup) return false;
    const requestId = next.signatureRequestId;
    const reopened = this.blockedApprovals.filter(
      (entry) => entry.signatureRequestId === requestId,
    );
    this.setBlockedApprovals(
      this.blockedApprovals.filter((entry) => entry.signatureRequestId !== requestId),
    );
    for (const entry of reopened) entry.attach(popup);
    return true;
  }

  private claimApprovalWindow(popup: Window): void {
    this.approvalWindowWaiters.set(popup, (this.approvalWindowWaiters.get(popup) ?? 0) + 1);
  }

  private releaseApprovalWindow(popup: Window): void {
    const remaining = (this.approvalWindowWaiters.get(popup) ?? 1) - 1;
    if (remaining > 0) {
      this.approvalWindowWaiters.set(popup, remaining);
      return;
    }
    this.approvalWindowWaiters.delete(popup);
    try {
      popup.close();
    } catch {
      // ignore
    }
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
    poll: (signal: AbortSignal) => Promise<T>,
    blockedPopupWaitMs = APPROVE_TIMEOUT_MS,
  ): Promise<T> {
    const polling = new AbortController();
    const desktop = desktopCloudWalletBridge();
    if (desktop) {
      // Approval needs a passkey, so it runs in the system browser; polling
      // observes the outcome, including rejection. Reconciliation retries this
      // on every readiness epoch, so each request opens a browser tab once per
      // run rather than on every retry.
      const id = canonicalSignatureRequestId(signatureRequestId);
      if (!this.approvalsOpenedInBrowser.has(id)) {
        const opened = await desktop.openInBrowser(signatureRequestApproveUrl(signatureRequestId));
        if (!opened) {
          throw new SignatureRequestUnavailableError(
            `Could not open the browser to approve Cloud Wallet ${source}`,
          );
        }
        this.approvalsOpenedInBrowser.add(id);
      }
      return poll(polling.signal);
    }
    let openPopup: Window | null = null;
    let disposeApproval = () => {};
    let blockedApproval: BlockedCloudWalletApproval | null = null;
    let blockedTimer: ReturnType<typeof setTimeout> | undefined;
    let closedWatch: ReturnType<typeof setInterval> | undefined;
    const approvalFailure = new Promise<never>((_resolve, reject) => {
      const attach = (popup: Window) => {
        clearTimeout(blockedTimer);
        openPopup = popup;
        this.claimApprovalWindow(popup);
        const approval = this.waitForSignatureApproval(signatureRequestId, source, popup);
        disposeApproval = approval.dispose;
        closedWatch = setInterval(() => {
          if (!popup.closed) return;
          clearInterval(closedWatch);
          approval.dispose();
          this.releaseApprovalWindow(popup);
          openPopup = null;
          promptToOpen('closed');
        }, POPUP_CLOSED_POLL_MS);
        void approval.promise.then(
          // The wallet may close its own window once it has approved.
          () => clearInterval(closedWatch),
          (error: unknown) => {
            if (
              error instanceof SignatureRequestUnavailableError &&
              /^Timed out waiting/.test(error.message)
            ) {
              return;
            }
            reject(error);
          },
        );
      };
      const promptToOpen = (reason: BlockedCloudWalletApproval['reason']) => {
        blockedApproval = { signatureRequestId, source, reason, attach };
        this.setBlockedApprovals([...this.blockedApprovals, blockedApproval]);
        blockedTimer = setTimeout(() => {
          reject(
            new SignatureRequestUnavailableError(
              reason === 'blocked'
                ? `Popup blocked — allow popups to approve Cloud Wallet ${source}`
                : `Cloud Wallet ${source} approval window was closed`,
            ),
          );
        }, blockedPopupWaitMs);
      };
      const popup = this.openApprovePopup(signatureRequestId);
      if (popup) {
        attach(popup);
      } else {
        promptToOpen('blocked');
      }
    });
    try {
      return await Promise.race([poll(polling.signal), approvalFailure]);
    } finally {
      polling.abort();
      clearTimeout(blockedTimer);
      clearInterval(closedWatch);
      disposeApproval();
      if (blockedApproval && this.blockedApprovals.includes(blockedApproval)) {
        this.setBlockedApprovals(
          this.blockedApprovals.filter((entry) => entry !== blockedApproval),
        );
      }
      const popup = openPopup as Window | null;
      if (popup) this.releaseApprovalWindow(popup);
    }
  }

  private async pollSignatureRequestOffer(
    signatureRequestId: string,
    signal: AbortSignal,
  ): Promise<{ offer: string; tradeId: string }> {
    const started = Date.now();
    while (!signal.aborted && Date.now() - started < APPROVE_TIMEOUT_MS) {
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
      const result = await this.trackSignatureRequest(
        recoveryId,
        request.kind,
        (signal) => this.pollSignatureRequestOffer(recoveryId, signal),
        request.kind === 'fee' ? BLOCKED_FEE_POPUP_WAIT_MS : undefined,
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
    signal: AbortSignal,
  ): Promise<WalletOfferCancellationOutcome> {
    const started = Date.now();
    while (!signal.aborted && Date.now() - started < APPROVE_TIMEOUT_MS) {
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
    this.dismissRefusedCancellation(offerId);
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
      if (request === null) return { status: 'cancelled' };
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
      const classified = classifyCancellationError(error, offerId);
      if (classified === 'terminal') return { status: 'already-terminal', detail };
      if (classified === 'refused') {
        this.setRefusedCancellations([...this.refusedCancellations, { offerId, detail }]);
      }
      return { status: 'unavailable', detail };
    }
  }

  async reconcileWalletOfferCancellation(
    _offerId: string,
    recoveryId: string,
  ): Promise<WalletOfferCancellationOutcome> {
    try {
      return await this.trackSignatureRequest(recoveryId, 'offer cancellation', (signal) =>
        this.pollCancellationSignatureRequest(recoveryId, signal),
      );
    } catch (error) {
      const detail = boundedCancellationDetail(cloudErrorDetail(error));
      return error instanceof SignatureRequestRejectedError
        ? { status: 'rejected', detail }
        : { status: 'unavailable', detail };
    }
  }

  async beginConnect(_uniqueId: string, fresh = false): Promise<ConnectionSetup> {
    this.loginAbort?.abort();
    this.loginAbort = null;
    if (fresh) {
      this.clearAuth();
      this.monitoringReady = false;
      this.fireConnectionChange(false);
    }

    const existing = loadCloudWalletAuth();
    if (existing && !fresh) {
      // Reloading the same grant must share its pending token refresh.
      if (this.auth?.refreshToken !== existing.refreshToken) ++this.authEpoch;
      this.auth = existing;
      return {
        qrUri: 'cloud-wallet://session',
        skipQr: true,
        finalize: async () => {
          this.loginAbort?.abort();
          const loginAbort = new AbortController();
          this.loginAbort = loginAbort;
          const throwIfCancelled = () => {
            if (loginAbort.signal.aborted) throw new Error(CLOUD_WALLET_LOGIN_CANCELLED);
          };
          try {
            // Refresh if needed via token provider, then resolve wallet + monitor.
            await this.tokenProvider.getAccessToken();
            throwIfCancelled();
            const walletId = await this.resolveWalletId();
            throwIfCancelled();
            this.persistAuth({ ...this.auth!, walletId });
            await this.startMonitoring(throwIfCancelled);
          } catch (e) {
            // A late failure belongs to the old login, not a replacement login.
            throwIfCancelled();
            // Only a dead grant costs the durable refresh token. A network blip
            // or GraphQL failure during silent resume must stay retryable, or a
            // momentary outage forces the user back through a popup login.
            if (e instanceof CloudWalletAuthError) {
              this.clearAuth();
            }
            this.monitoringReady = false;
            this.fireConnectionChange(false);
            throw e;
          } finally {
            if (this.loginAbort === loginAbort) this.loginAbort = null;
          }
        },
      };
    }

    return {
      qrUri: 'cloud-wallet://oauth',
      skipQr: true,
      title: 'Cloud Wallet',
      description: desktopCloudWalletBridge()
        ? 'Sign in to Cloud Wallet in your browser.'
        : 'Sign in to Cloud Wallet via the popup.',
      // Empty but present: the modal's Connect click is the user gesture that
      // lets the OAuth popup open (or the browser, on desktop), and it keeps
      // silent resume from finalizing.
      fields: {},
      finalize: async () => {
        this.loginAbort?.abort();
        const loginAbort = new AbortController();
        this.loginAbort = loginAbort;
        // Cancel can land during any await below; nothing may be stored after it.
        const throwIfCancelled = () => {
          if (loginAbort.signal.aborted) throw new Error(CLOUD_WALLET_LOGIN_CANCELLED);
        };
        try {
          const tokens = await beginOAuthLogin(loginAbort.signal);
          throwIfCancelled();
          ++this.authEpoch;
          this.auth = {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            walletId: tokens.walletId,
          };
          // Persist the id that actually resolved: the consent screen's choice can
          // differ from what the grant will read back, and monitoring uses this id.
          const walletId = await this.resolveWalletId();
          throwIfCancelled();
          this.persistAuth({ ...tokens, walletId });
          await this.startMonitoring(throwIfCancelled);
        } finally {
          if (this.loginAbort === loginAbort) this.loginAbort = null;
        }
      },
    };
  }

  async disconnect(): Promise<void> {
    this.loginAbort?.abort();
    this.loginAbort = null;
    this.clearAuth();
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
