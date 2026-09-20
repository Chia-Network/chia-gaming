import { encodeU64AsClvmHex, normalizeCoinStringHex, normalizeHexString } from '../util';
import { getCurrencyLabels } from '../constants/currency';
import { CoinRecord } from '../types/rpc/CoinRecord';
import { jsonParse, jsonStringify } from '../util/jsonSafe';

import { BLOCKCHAIN_WS_URL } from '../settings';
import {
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
  ConnectionSetup,
  WalletOfferBeginOutcome,
  WalletOfferOperation,
  WalletOfferRequest,
  WalletOfferCancellationOutcome,
  WalletSubmitOutcome,
} from '../types/ChiaGaming';

import { log, diagStack, diagNote } from '../services/log';

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getWebSocketClass(): any {
  if (typeof globalThis.WebSocket !== 'undefined') return globalThis.WebSocket;
  throw new Error('No WebSocket implementation available');
}

export class SimulatorTransportError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SimulatorTransportError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export function classifyFakeBlockchainSubmitResult(result: unknown): WalletSubmitOutcome {
  if (!Array.isArray(result)) {
    return { status: 'rejected', detail: 'Malformed simulator spend response' };
  }
  const status =
    typeof result[0] === 'bigint'
      ? Number(result[0])
      : typeof result[0] === 'number'
        ? result[0]
        : null;
  if (status === 1) {
    return { status: 'acknowledged' };
  }
  if (status !== 3) {
    return {
      status: 'rejected',
      detail:
        status === null
          ? 'Malformed simulator spend response'
          : `Unknown simulator spend status=${status}`,
    };
  }
  const detail =
    typeof result[1] === 'bigint'
      ? Number(result[1])
      : typeof result[1] === 'number'
        ? result[1]
        : null;
  if (detail === null) {
    return { status: 'rejected', detail: 'Malformed simulator spend rejection' };
  }
  const diagnostic = typeof result[2] === 'string' ? result[2] : '';
  const message = `spend rejected: status=[${result[0]},${detail}]${diagnostic ? ' ' + diagnostic : ''}`;
  return { status: 'rejected', detail: message };
}

export function classifyFakeBlockchainSubmitError(error: unknown): WalletSubmitOutcome {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof SimulatorTransportError) {
    return { status: 'unavailable', detail };
  }
  if (
    /\bALREADY_INCLUDING_TRANSACTION\b|\bduplicate transaction\b|\btransaction (?:is |was |has been )?already (?:included|in (?:the )?mempool)\b/i.test(
      detail,
    )
  ) {
    return { status: 'acknowledged', detail };
  }
  return { status: 'rejected', detail: detail || 'Simulator rejected spend' };
}

type SyntheticFeeOfferState = 'reserved' | 'submitted';

function requireCoinHex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Malformed simulator wallet bundle ${label}`);
  }
  return normalizeHexString(value);
}

function requireU64(value: unknown, label: string): bigint {
  const amount =
    typeof value === 'bigint'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? BigInt(value)
        : null;
  if (amount === null || amount < 0n || amount > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`Malformed simulator wallet bundle ${label}`);
  }
  return amount;
}

function walletSpendInputCoinKeys(bundle: unknown): Set<string> {
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) {
    throw new Error('Malformed simulator wallet bundle');
  }
  const coinSpends = (bundle as { coin_spends?: unknown }).coin_spends;
  if (!Array.isArray(coinSpends) || coinSpends.length === 0) {
    throw new Error('Malformed simulator wallet bundle coin_spends');
  }
  const inputCoinKeys = new Set<string>();
  for (const [index, coinSpend] of coinSpends.entries()) {
    if (typeof coinSpend !== 'object' || coinSpend === null || Array.isArray(coinSpend)) {
      throw new Error(`Malformed simulator wallet bundle coin_spends[${index}]`);
    }
    const coin = (coinSpend as { coin?: unknown }).coin;
    if (typeof coin !== 'object' || coin === null || Array.isArray(coin)) {
      throw new Error(`Malformed simulator wallet bundle coin_spends[${index}].coin`);
    }
    const fields = coin as Record<string, unknown>;
    const parent = requireCoinHex(
      fields.parent_coin_info,
      `coin_spends[${index}].coin.parent_coin_info`,
    );
    const puzzleHash = requireCoinHex(fields.puzzle_hash, `coin_spends[${index}].coin.puzzle_hash`);
    const amount = requireU64(fields.amount, `coin_spends[${index}].coin.amount`);
    inputCoinKeys.add(`${parent}:${puzzleHash}:${amount}`);
  }
  return inputCoinKeys;
}

export class SyntheticFeeOfferTracker {
  private readonly offers = new Map<
    string,
    { state: SyntheticFeeOfferState; inputCoinKeys: Set<string> }
  >();

  reserve(tradeId: string, feeBundle: unknown): void {
    if (this.offers.has(tradeId)) {
      throw new Error(`Duplicate simulator fee offer ${tradeId}`);
    }
    const inputCoinKeys = walletSpendInputCoinKeys(feeBundle);
    for (const [existingTradeId, offer] of this.offers) {
      if ([...inputCoinKeys].some((coinKey) => offer.inputCoinKeys.has(coinKey))) {
        throw new Error(
          `Simulator fee offer ${tradeId} reuses an input reserved by ${existingTradeId}`,
        );
      }
    }
    this.offers.set(tradeId, {
      state: 'reserved',
      inputCoinKeys,
    });
  }

  hasOffers(): boolean {
    return this.offers.size > 0;
  }

  markSubmitted(finalizedBundle: unknown): void {
    const finalizedBundleInputCoinKeys = walletSpendInputCoinKeys(finalizedBundle);
    for (const offer of this.offers.values()) {
      if ([...offer.inputCoinKeys].every((coinKey) => finalizedBundleInputCoinKeys.has(coinKey))) {
        offer.state = 'submitted';
      }
    }
  }

  cancel(tradeId: string): SyntheticFeeOfferState | undefined {
    const offer = this.offers.get(tradeId);
    if (!offer) return undefined;
    this.offers.delete(tradeId);
    return offer.state;
  }
}

export class FakeBlockchainInterface implements InternalBlockchainInterface {
  readonly fundingMode = 'offer-settlement' as const;
  blockchainAddressData: BlockchainInboundAddressResult;
  deleted: boolean;

  private ws: any | null = null;
  private wsUrl: string;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private token = '';
  private uniqueId = '';
  private initialBalance: bigint | undefined;
  private connectionListeners = new Set<(connected: boolean) => void>();
  private readinessListeners = new Set<(ready: boolean) => void>();
  private lastConnectedState = false;
  private autoReconnect = false;
  // Firefox serializes WS connects per host:port and can delay a new
  // WebSocket for many seconds after recent failures (e.g. reload interrupt).
  // A short timeout aborts that delayed attempt, counts another failure, and
  // makes the next try even slower — so wait long enough for FF to finish.
  private static readonly CONNECT_TIMEOUT_MS = 30_000;
  // Monotonic backoff: stay out of Firefox's failure queue during cutovers.
  private static readonly RECONNECT_DELAYS = [5000, 10000, 20000, 30000, 60000];
  private reconnectAttempt = 0;
  private connectLoopPromise: Promise<void> | null = null;
  private blockWaiters = new Set<() => void>();
  private setupComplete = false;
  private nextSyntheticTradeId = 0;
  private syntheticFeeOffers = new SyntheticFeeOfferTracker();

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
    this.blockchainAddressData = { puzzleHash: '' };
    this.deleted = false;
  }

  private connect(): Promise<void> {
    if (this.ws && this.ws.readyState === 1) {
      return Promise.resolve();
    }
    const t0 = performance.now();
    log(`[sim-blockchain] connect: opening WebSocket to ${this.wsUrl}`);
    return new Promise<void>((resolve, reject) => {
      const WS = getWebSocketClass();
      const ws = new WS(this.wsUrl);
      let settled = false;
      const connectTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        log(`[sim-blockchain] connect: timeout (${Math.round(performance.now() - t0)}ms)`);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`WebSocket connection to ${this.wsUrl} timed out`));
      }, FakeBlockchainInterface.CONNECT_TIMEOUT_MS);
      ws.onopen = () => {
        if (settled) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        log(`[sim-blockchain] connect: connected (${Math.round(performance.now() - t0)}ms)`);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        log(`[sim-blockchain] connect: error (${Math.round(performance.now() - t0)}ms)`);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`WebSocket connection to ${this.wsUrl} failed`));
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.setupComplete = false;
        this.fireConnectionChange(false);
        if (this.pending.size > 0) {
          diagNote(
            `FakeBlockchain onclose: rejecting ${this.pending.size} pending request(s) with "WebSocket closed" (ids=${[...this.pending.keys()].join(',')})`,
          );
        }
        for (const [, p] of this.pending) {
          p.reject(new SimulatorTransportError('WebSocket closed'));
        }
        this.pending.clear();
        // Fire-and-forget reconnect.  A deliberate shutdown makes runConnectLoop
        // return cleanly (it no longer throws on abort), so this can reject only
        // on a genuine unexpected bug -- which we intentionally let surface as an
        // unhandled rejection rather than swallow.
        void this.startConnectLoop();
      };
      ws.onmessage = (evt: any) => {
        if (this.ws !== ws) return;
        const raw = typeof evt === 'string' ? evt : evt.data;
        let data: any;
        try {
          data = jsonParse(raw);
        } catch (e) {
          diagStack('FakeBlockchain onmessage JSON parse failed', e);
          return;
        }

        if (data.event === 'block') {
          for (const resolve of this.blockWaiters) resolve();
          this.blockWaiters.clear();
          return;
        }

        if (data.id !== undefined) {
          const id = Number(data.id);
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            if (data.error) {
              p.reject(new Error(data.error));
            } else {
              p.resolve(data.result);
            }
          }
        }
      };
    });
  }

  private startConnectLoop(): Promise<void> {
    if (!this.autoReconnect || this.deleted) return Promise.resolve();
    if (this.connectLoopPromise) return this.connectLoopPromise;
    this.connectLoopPromise = this.runConnectLoop();
    return this.connectLoopPromise;
  }

  private async runConnectLoop(): Promise<void> {
    try {
      while (!this.deleted) {
        try {
          await this.connect();
          const regParams: any = { name: this.uniqueId };
          if (this.initialBalance !== undefined) regParams.balance = this.initialBalance;
          const token = await this.sendRequest('register', regParams);
          this.token = token;
          this.blockchainAddressData = { puzzleHash: token };
          await this.sendRequest('get_peak');
          this.setupComplete = true;
          this.fireConnectionChange(true);
          this.reconnectAttempt = 0;
          log('[sim-blockchain] connected and setup complete');
          return;
        } catch (err) {
          if (this.deleted) break;
          if (this.ws) {
            try {
              this.ws.close();
            } catch {
              /* ignore */
            }
            this.ws = null;
          }
          this.setupComplete = false;
          this.fireConnectionChange(false);
          const base =
            FakeBlockchainInterface.RECONNECT_DELAYS[
              Math.min(this.reconnectAttempt, FakeBlockchainInterface.RECONNECT_DELAYS.length - 1)
            ];
          const jitter = Math.round(base * (0.75 + Math.random() * 0.5));
          this.reconnectAttempt++;
          // Expected transient while reconnecting (e.g. sim not up yet); a plain
          // log is enough -- no stack dump, which would bury real signal.
          log(
            `[sim-blockchain] connect failed: ${err}, backoff ${jitter}ms (attempt ${this.reconnectAttempt})`,
          );
          await sleepMs(jitter);
        }
      }
      // The loop exited because we were told to shut down (`deleted` set during
      // teardown/disconnect).  That is a normal, expected termination -- not an
      // error.  Returning cleanly (instead of throwing 'connection aborted')
      // means a fire-and-forget reconnect during teardown no longer rejects,
      // which is what was producing the opaque late unhandled rejection in CI.
      log('[sim-blockchain] reconnect loop stopped (shutting down)');
    } finally {
      this.connectLoopPromise = null;
    }
  }

  private sendRequest(method: string, params?: any): Promise<any> {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new SimulatorTransportError('not connected'));
    }
    const id = this.nextId++;
    const msg = jsonStringify({ id, method, params: params ?? {} });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws!.send(msg);
      } catch (error) {
        this.pending.delete(id);
        reject(new SimulatorTransportError('WebSocket send failed', error));
      }
    });
  }

  async getAddress() {
    return this.blockchainAddressData;
  }

  async startMonitoring() {
    log('[sim-blockchain] startMonitoring');
    this.deleted = false;
    this.autoReconnect = true;
    this.reconnectAttempt = 0;
  }

  async spend(
    blob: string,
    _spendBundle: unknown,
    _changePuzzleHash: string,
    _source?: string,
    _fee?: bigint,
  ): Promise<WalletSubmitOutcome> {
    if (this.syntheticFeeOffers.hasOffers()) {
      try {
        walletSpendInputCoinKeys(_spendBundle);
      } catch (error) {
        return {
          status: 'rejected',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
    try {
      const result = classifyFakeBlockchainSubmitResult(await this.sendRequest('spend', { blob }));
      if (result.status === 'acknowledged') {
        this.syntheticFeeOffers.markSubmitted(_spendBundle);
      }
      if (result.status === 'rejected') console.warn('[blockchain]', result.detail);
      return result;
    } catch (error) {
      return classifyFakeBlockchainSubmitError(error);
    }
  }

  async getBalance(): Promise<bigint> {
    return this.sendRequest('get_balance', { user: this.token });
  }

  async getPuzzleAndSolution(coin: string): Promise<string[] | null> {
    return this.sendRequest('get_puzzle_and_solution', { coin });
  }

  async selectCoins(uniqueId: string, amount: bigint): Promise<string | null> {
    if (!this.token) throw new Error('not set up');
    const response = await this.sendRequest('select_coins', { who: uniqueId, amount });
    if (typeof response !== 'string') return response ?? null;
    return normalizeCoinStringHex(response);
  }

  async getHeightInfo(): Promise<bigint> {
    return this.sendRequest('get_peak');
  }

  async farmBlock(): Promise<bigint> {
    return this.sendRequest('farm_block');
  }

  async replaceChain(rollbackHeight: bigint, targetHeight: bigint): Promise<bigint> {
    return this.sendRequest('replace_chain', {
      rollbackHeight: Number(rollbackHeight),
      targetHeight: Number(targetHeight),
    });
  }

  waitForNextBlock(timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.blockWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(() => {
        this.blockWaiters.delete(finish);
        reject(new Error(`simulator did not emit a block within ${timeoutMs}ms`));
      }, timeoutMs);
      this.blockWaiters.add(finish);
    });
  }

  async beginWalletOffer(
    _operation: WalletOfferOperation,
    request: WalletOfferRequest,
  ): Promise<WalletOfferBeginOutcome> {
    if (request.kind === 'fee') {
      return this.beginFeeOffer(request);
    }
    const params: any = { who: request.uniqueId, offer: request.offer };
    const conditions = [...(request.extraConditions ?? [])];
    const { maxHeight } = request;
    if (maxHeight !== undefined) {
      conditions.push({ opcode: 87n, args: [encodeU64AsClvmHex(maxHeight)] });
    }
    if (conditions.length > 0) params.extraConditions = conditions;
    if (request.coinIds) params.coinIds = request.coinIds;
    const raw = await this.sendRequest('create_offer_for_ids', params);
    if (!raw) return { kind: 'failure', reason: 'simulator could not build a funding offer' };
    return {
      kind: 'created',
      material: { kind: 'bundle', bundle: typeof raw === 'string' ? jsonParse(raw) : raw },
    };
  }

  private async beginFeeOffer(
    request: Extract<WalletOfferRequest, { kind: 'fee' }>,
  ): Promise<WalletOfferBeginOutcome> {
    const { fee, concurrentSpendCoinId } = request;
    if (fee <= 0n) return { kind: 'failure', reason: 'fee must be positive' };
    try {
      const bundle = await this.sendRequest('create_offer_for_ids', {
        who: this.uniqueId,
        offer: { '1': -fee },
        nativeFee: true,
        extraConditions: [
          { opcode: 64n, args: [concurrentSpendCoinId] },
          { opcode: 52n, args: [encodeU64AsClvmHex(fee)] },
        ],
      });
      if (!bundle) return { kind: 'failure', reason: 'simulator could not build a fee offer' };
      const tradeId = `sim-fee-${this.uniqueId}-${this.nextSyntheticTradeId++}`;
      this.syntheticFeeOffers.reserve(tradeId, bundle);
      return { kind: 'created', material: { kind: 'bundle', bundle }, tradeId };
    } catch (error) {
      if (error instanceof SimulatorTransportError) {
        return { kind: 'unavailable', reason: error.message };
      }
      return {
        kind: 'failure',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async releaseWalletOffer(tradeId: string): Promise<WalletOfferCancellationOutcome> {
    const state = this.syntheticFeeOffers.cancel(tradeId);
    if (state === undefined) {
      return { status: 'already-terminal', detail: 'simulator fee offer is not active' };
    }
    return state === 'submitted'
      ? { status: 'already-terminal', detail: 'simulator fee offer was spent' }
      : { status: 'cancelled' };
  }

  async getCoinRecordsByNames(names: string[]): Promise<CoinRecord[]> {
    const result = await this.sendRequest('get_coin_records_by_names', { names });
    return Array.isArray(result) ? result : [];
  }

  async registerCoins(names: string[]): Promise<void> {
    await this.sendRequest('register_remote_coins', { coinIds: names });
  }

  async registerUser(name: string, balance?: bigint): Promise<string> {
    log(`[sim-blockchain] registerUser: name=${name} balance=${balance ?? 'default'}`);
    this.uniqueId = name;
    const params: any = { name };
    if (balance !== undefined) params.balance = balance;
    const result = await this.sendRequest('register', params);
    this.token = result;
    log('[sim-blockchain] registerUser: complete');
    return result;
  }

  close() {
    this.deleted = true;
    this.autoReconnect = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.setupComplete = false;
    this.fireConnectionChange(false);
    for (const [, p] of this.pending) {
      p.reject(new Error('closed'));
    }
    this.pending.clear();
  }

  private fireConnectionChange(connected: boolean) {
    if (connected === this.lastConnectedState) return;
    this.lastConnectedState = connected;
    for (const cb of this.connectionListeners) {
      try {
        cb(connected);
      } catch {
        /* ignore */
      }
    }
    // Simulator has no full-node peer wait: play readiness tracks connectivity.
    for (const cb of this.readinessListeners) {
      try {
        cb(connected);
      } catch {
        /* ignore */
      }
    }
  }

  async beginConnect(uniqueId: string, _fresh = false): Promise<ConnectionSetup> {
    return {
      qrUri: `sim://${this.wsUrl.replace('ws://', '')}/${uniqueId}`,
      title: 'Simulator',
      description: 'Connect to the simulated blockchain',
      fields: {
        balance: {
          type: 'bigint',
          label: `Starting balance (${getCurrencyLabels().mojos})`,
          default: 1_000_000n,
        },
      },
      finalize: async (values?: Record<string, string | bigint>) => {
        log('[sim-blockchain] finalize: start');
        this.uniqueId = uniqueId;
        this.initialBalance = values?.balance === undefined ? undefined : BigInt(values.balance);
        this.deleted = false;
        this.autoReconnect = true;
        this.reconnectAttempt = 0;
        await this.startConnectLoop();
        log('[sim-blockchain] finalize: complete');
      },
    };
  }

  async disconnect(): Promise<void> {
    this.autoReconnect = false;
    this.close();
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === 1 && this.setupComplete;
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

export const fakeBlockchainInfo = new FakeBlockchainInterface(BLOCKCHAIN_WS_URL);
