import { ChiaMethod } from '../constants/wallet-connect';
import {
  CreateOfferForIdsRequest,
  CreateOfferForIdsResponse,
} from '../types/rpc/CreateOfferForIds';
import {
  GetNextAddressRequest,
  GetNextAddressResponse,
} from '../types/rpc/GetNextAddress';
import {
  GetWalletBalanceRequest,
  GetWalletBalanceResponse,
} from '../types/rpc/GetWalletBalance';
import {
  GetHeightInfoRequest,
  GetHeightInfoResponse,
} from '../types/rpc/GetHeightInfo';
import {
  CreateNewRemoteWalletRequest,
  CreateNewRemoteWalletResponse,
} from '../types/rpc/CreateNewRemoteWallet';
import {
  RegisterRemoteCoinsRequest,
  RegisterRemoteCoinsResponse,
} from '../types/rpc/RegisterRemoteCoins';
import {
  GetCoinRecordsByNamesRequest,
  GetCoinRecordsByNamesResponse,
} from '../types/rpc/GetCoinRecordsByNames';
import {
  GetPuzzleAndSolutionRequest,
  GetPuzzleAndSolutionResponse,
} from '../types/rpc/GetPuzzleAndSolution';
import {
  PushTransactionsRequest,
  PushTransactionsResponse,
} from '../types/rpc/PushTransactions';
import {
  SelectCoinsRequest,
  SelectCoinsResponse,
} from '../types/rpc/SelectCoins';
import { log } from '../services/log';
import { jsonStringify } from '../util/jsonSafe';

import {
  AsyncJobQueue,
  AsyncQueueJob,
  AsyncPollingScheduler,
  AsyncPollingTarget,
  clearGapTimer,
  makeGapTimer,
  scheduleGapTimer,
} from '../lib/AsyncScheduler';
import { walletConnectState } from './useWalletConnect';

type Loose = Record<string, unknown>;
type GetWalletsRequest = Loose;
type GetWalletsResponse = Array<{ id: bigint; type: bigint; [key: string]: unknown }>;
const WC_RELAY_CONNECT_TIMEOUT_MS = 15000;
const WC_INTER_REQUEST_MS = 50;
export const WC_CHAIN_POLL_INTERVAL_MS = 10000;
export const WC_BALANCE_POLL_INTERVAL_MS = 60000;

function getErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === 'string') {
      const parts = [obj.message];
      if ('code' in obj) parts.push(`code=${String(obj.code)}`);
      if ('data' in obj && obj.data !== undefined) {
        try { parts.push(`data=${jsonStringify(obj.data)}`); } catch { /* skip */ }
      }
      return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : parts[0];
    }
    try { return jsonStringify(err); } catch { /* fall through */ }
  }
  return String(err);
}

function toDebugJson(value: unknown): string {
  try {
    return jsonStringify(value);
  } catch {
    return String(value);
  }
}

function walletConnectError(method: ChiaMethod, detail: string, cause?: unknown): Error {
  const err = new Error(`WalletConnect RPC ${method} failed: ${detail}`);
  (err as any).cause = cause;
  return err;
}

function shouldLogRpcError(method: ChiaMethod): boolean {
  return method !== ChiaMethod.GetCoinRecordsByNames;
}

function shouldEnqueueAtFront(method: ChiaMethod): boolean {
  return method === ChiaMethod.PushTransactions
    || method === ChiaMethod.SelectCoins
    || method === ChiaMethod.CreateOfferForIds;
}

function isCoinRecordMiss(err: unknown): boolean {
  const text = getErrorText(err).toLowerCase();
  return text.includes('not found')
    || text.includes('coin id') && text.includes('unknown')
    || text.includes('internal error') && text.includes('-32603');
}

function deepNumbersToBigInt(value: unknown): unknown {
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (Array.isArray(value)) return value.map(deepNumbersToBigInt);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepNumbersToBigInt(v);
    }
    return out;
  }
  return value;
}

async function waitForRelayerConnected(): Promise<void> {
  const client = walletConnectState.getClient();
  if (!client) throw new Error('WalletConnect is not initialized');

  const relayer = client.core.relayer;
  if (relayer.connected) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      relayer.off('relayer_connect', onConnect);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onConnect = () => finish();
    const timer = setTimeout(() => {
      fail(new Error(`WalletConnect relayer did not connect after ${WC_RELAY_CONNECT_TIMEOUT_MS}ms`));
    }, WC_RELAY_CONNECT_TIMEOUT_MS);

    relayer.on('relayer_connect', onConnect);
    if (relayer.connected) finish();
  });
}

type PreparedRpc<T> = {
  method: ChiaMethod;
  params: Record<string, unknown>;
  data: object;
  paramKeys: string;
  enqueuedAt: number;
};

type HeightCallbacks = {
  onHeight: (height: bigint, response: GetHeightInfoResponse) => void;
  onError?: (err: unknown) => void;
};

type BalanceCallbacks = {
  onBalance: (balance: bigint, response: GetWalletBalanceResponse) => void;
  onError?: (err: unknown) => void;
};

export type WalletConnectCoinInterest = {
  coin_name: string;
  coin_string: string;
};

type CoinCallbacks = {
  onRecords: (records: GetCoinRecordsByNamesResponse['coinRecords'], registeredNames: Set<string>) => void;
  onError?: (err: unknown) => void;
};

class WalletConnectScheduler {
  private lane = new AsyncJobQueue({
    gapMs: WC_INTER_REQUEST_MS,
    onError: (job, e) => {
      log(`[WC scheduler] job failed label=${job.label}: ${getErrorText(e)}`);
    },
  });
  private height: AsyncPollingScheduler;
  private balance: AsyncPollingScheduler;
  private coinTimer = makeGapTimer(WC_CHAIN_POLL_INTERVAL_MS);
  private coinInterested = false;
  private coinCallbacks: CoinCallbacks | null = null;
  private watchedCoins = new Map<string, WalletConnectCoinInterest>();
  private registeredCoinNames = new Set<string>();
  private coinQueuedNames = new Set<string>();
  private coinInFlightNames = new Set<string>();
  private coinRecords: GetCoinRecordsByNamesResponse['coinRecords'] = [];
  private coinDirty = false;
  private remoteWalletId: bigint | number | undefined;
  private heightCallbacks: HeightCallbacks | null = null;
  private balanceCallbacks: BalanceCallbacks | null = null;

  constructor() {
    const walletConnectHeightPollingTarget: AsyncPollingTarget = {
      runOnce: () => this.runHeightPoll(),
      onError: (e) => this.heightCallbacks?.onError?.(e),
    };
    const walletConnectBalancePollingTarget: AsyncPollingTarget = {
      runOnce: () => this.runBalancePoll(),
      onError: (e) => this.balanceCallbacks?.onError?.(e),
    };

    this.height = new AsyncPollingScheduler(
      {
        label: 'walletconnect-height',
        queue: this.lane,
        intervalMs: WC_CHAIN_POLL_INTERVAL_MS,
      },
      walletConnectHeightPollingTarget,
    );
    this.balance = new AsyncPollingScheduler(
      {
        label: 'walletconnect-balance',
        queue: this.lane,
        intervalMs: WC_BALANCE_POLL_INTERVAL_MS,
      },
      walletConnectBalancePollingTarget,
    );
  }

  request<T, D extends object = object>(method: ChiaMethod, data: D): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let prepared: PreparedRpc<T>;
      try {
        prepared = this.prepareRpc(method, data);
      } catch (e) {
        reject(e);
        return;
      }
      this.enqueue({
        label: String(method),
        run: async () => {
          try {
            const value = await this.runPreparedRpc(prepared);
            resolve(value);
          } catch (e) {
            this.logRpcError(prepared, e);
            reject(walletConnectError(method, getErrorText(e), e));
          }
        },
      });
    });
  }

  setRemoteWalletId(walletId: bigint | number | undefined): void {
    this.remoteWalletId = walletId;
  }

  startHeightInterest(intervalMs: number, callbacks: HeightCallbacks): void {
    this.heightCallbacks = callbacks;
    this.height.start(intervalMs);
  }

  stopHeightInterest(): void {
    this.height.stop();
  }

  startBalanceInterest(intervalMs: number, callbacks: BalanceCallbacks): void {
    this.balanceCallbacks = callbacks;
    this.balance.start(intervalMs);
  }

  stopBalanceInterest(): void {
    this.balance.stop();
  }

  setCoinInterest(
    coins: WalletConnectCoinInterest[],
    intervalMs: number,
    callbacks: CoinCallbacks,
  ): void {
    this.coinCallbacks = callbacks;
    this.coinTimer.intervalMs = intervalMs;
    this.coinInterested = true;
    const previous = this.watchedCoins;
    this.watchedCoins = new Map(coins.map((coin) => [coin.coin_name, coin]));
    const added = coins.some((coin) => !previous.has(coin.coin_name));
    if (this.watchedCoins.size === 0) {
      this.clearCoinTimer();
      return;
    }
    if (added) {
      this.clearCoinTimer();
      this.enqueueCoinSweepOrMarkDirty();
    } else if (!this.coinTimer.timerActive && this.coinQueuedNames.size === 0 && this.coinInFlightNames.size === 0) {
      this.scheduleCoinTimer();
    }
  }

  stopCoinInterest(): void {
    this.coinInterested = false;
    this.watchedCoins.clear();
    this.clearCoinTimer();
  }

  resetForTests(): void {
    this.lane.resetForTests();
    this.height.resetForTests(WC_CHAIN_POLL_INTERVAL_MS);
    this.balance.resetForTests(WC_BALANCE_POLL_INTERVAL_MS);
    this.clearCoinTimer();
    this.coinInterested = false;
    this.coinCallbacks = null;
    this.watchedCoins.clear();
    this.registeredCoinNames.clear();
    this.coinQueuedNames.clear();
    this.coinInFlightNames.clear();
    this.coinRecords = [];
    this.coinDirty = false;
    this.remoteWalletId = undefined;
    this.heightCallbacks = null;
    this.balanceCallbacks = null;
  }

  private prepareRpc<T, D extends object>(
    method: ChiaMethod,
    data: D,
  ): PreparedRpc<T> {
    if (!walletConnectState.getClient()) throw new Error('WalletConnect is not initialized');
    if (!walletConnectState.getSession()) throw new Error('Session is not connected');

    const address = walletConnectState.getAddress();
    if (!address) {
      throw new Error('no fingerprint set in walletconnect');
    }
    const fingerprint = Number.parseInt(address, 10);
    if (!Number.isFinite(fingerprint)) {
      throw new Error('walletconnect fingerprint is not a valid integer');
    }

    const params: Record<string, unknown> = {
      ...data,
      fingerprint,
    };
    const paramKeys = Object.keys(params).join(',');
    const enqueuedAt = Date.now();

    return {
      method,
      params,
      data,
      paramKeys,
      enqueuedAt,
    };
  }

  private async runPreparedRpc<T>(prepared: PreparedRpc<T>): Promise<T> {
    const session = walletConnectState.getSession();
    const client = walletConnectState.getClient();
    if (!session) throw new Error('Session is not connected');
    if (!client) throw new Error('WalletConnect is not initialized');

    await waitForRelayerConnected();

    try {
      const raw = await client.request({
        topic: session.topic,
        chainId: walletConnectState.getChainId(),
        request: { method: prepared.method, params: prepared.params },
      });
      return this.normalizeResult(prepared, raw);
    } catch (e) {
      throw e;
    }
  }

  private normalizeResult<T>(prepared: PreparedRpc<T>, raw: unknown): T {
    const result = deepNumbersToBigInt(raw) as Record<string, unknown> | undefined;
    if (result?.error) {
      const errorText = toDebugJson(result.error);
      const trace = new Error().stack?.split('\n').slice(1, 6).join('\n') ?? '';
      if (shouldLogRpcError(prepared.method)) {
        console.error(`[WC RPC rejected] method=${prepared.method} paramKeys=[${prepared.paramKeys}]\n  error: ${errorText}\n${trace}`);
        log(`[WC RPC rejected] method=${prepared.method} paramKeys=[${prepared.paramKeys}] error=${errorText}`);
      }
      throw walletConnectError(prepared.method, errorText, result.error);
    }

    if (result?.data !== undefined) return result.data as T;
    return result as T;
  }

  private logRpcError(prepared: PreparedRpc<unknown>, e: unknown): void {
    const elapsed = Date.now() - prepared.enqueuedAt;
    const errText = getErrorText(e);
    if (shouldLogRpcError(prepared.method)) {
      const knownTopics = walletConnectState.getClient()?.session?.keys ?? [];
      const activeTopicNow = walletConnectState.getSession()?.topic ?? 'none';
      log(
        `[WC RPC error] ${prepared.method} after ${elapsed}ms: ${errText} paramKeys=[${prepared.paramKeys}] active=${activeTopicNow} known=${knownTopics.join(',') || 'none'}`,
      );
      console.error(`[WC RPC error] ${prepared.method} paramKeys=[${prepared.paramKeys}]`, e);
    }
  }

  private enqueue(job: AsyncQueueJob): void {
    if (shouldEnqueueAtFront(job.label as ChiaMethod)) {
      this.lane.enqueueFront(job);
    } else {
      this.lane.enqueue(job);
    }
  }

  private async runHeightPoll(): Promise<void> {
    const prepared = this.prepareRpc<GetHeightInfoResponse, GetHeightInfoRequest>(
      ChiaMethod.GetHeightInfo,
      { usePeakHeight: true },
    );
    try {
      const response = await this.runPreparedRpc(prepared);
      if (this.height.isInterested()) {
        this.heightCallbacks?.onHeight(response.height ?? 0n, response);
      }
    } catch (e) {
      this.logRpcError(prepared, e);
      throw e;
    }
  }

  private async runBalancePoll(): Promise<void> {
    const prepared = this.prepareRpc<GetWalletBalanceResponse, GetWalletBalanceRequest>(
      ChiaMethod.GetWalletBalance,
      { walletId: 1n },
    );
    try {
      const response = await this.runPreparedRpc(prepared);
      if (this.balance.isInterested()) {
        this.balanceCallbacks?.onBalance((response as any)?.confirmedWalletBalance ?? 0n, response);
      }
    } catch (e) {
      this.logRpcError(prepared, e);
      throw e;
    }
  }

  private enqueueCoinSweepOrMarkDirty(): void {
    if (this.coinQueuedNames.size > 0 || this.coinInFlightNames.size > 0) {
      this.coinDirty = true;
      return;
    }
    this.enqueueCoinSweep();
  }

  private enqueueCoinSweep(): void {
    if (!this.coinInterested || this.watchedCoins.size === 0) return;
    this.coinRecords = [];
    const unregistered = [...this.watchedCoins.keys()].filter((name) => !this.registeredCoinNames.has(name));
    if (unregistered.length > 0 && this.remoteWalletId !== undefined) {
      this.enqueueCoinRegistration(unregistered);
    }
    for (const name of this.watchedCoins.keys()) {
      this.enqueueCoinRequest(name);
    }
  }

  private enqueueCoinRegistration(names: string[]): void {
    let prepared: PreparedRpc<RegisterRemoteCoinsResponse>;
    try {
      prepared = this.prepareRpc(
        ChiaMethod.RegisterRemoteCoins,
        { walletId: this.remoteWalletId!, coinIds: names },
      );
    } catch (e) {
      this.coinCallbacks?.onError?.(e);
      return;
    }
    this.enqueue({
      label: 'coin-registration',
      run: async () => {
        if (!this.coinInterested) return;
        try {
          await this.runPreparedRpc(prepared);
          for (const name of names) this.registeredCoinNames.add(name);
        } catch (e) {
          this.logRpcError(prepared, e);
          this.coinCallbacks?.onError?.(e);
        }
      },
    });
  }

  private enqueueCoinRequest(name: string): void {
    if (this.coinQueuedNames.has(name) || this.coinInFlightNames.has(name)) return;
    this.coinQueuedNames.add(name);
    this.enqueue({
      label: `coin:${name}`,
      run: async () => {
        this.coinQueuedNames.delete(name);
        if (!this.coinInterested || !this.watchedCoins.has(name)) {
          this.finishCoinRequest(name);
          return;
        }
        if (!this.registeredCoinNames.has(name)) {
          this.finishCoinRequest(name);
          return;
        }
        let prepared: PreparedRpc<GetCoinRecordsByNamesResponse>;
        try {
          prepared = this.prepareRpc(
            ChiaMethod.GetCoinRecordsByNames,
            { names: [name], includeSpentCoins: true, allowUnsynced: true },
          );
        } catch (e) {
          this.coinCallbacks?.onError?.(e);
          this.finishCoinRequest(name);
          return;
        }
        this.coinInFlightNames.add(name);
        try {
          const response = await this.runPreparedRpc(prepared);
          if ((response as any)?.error) {
            const msg = String((response as any).error);
            if (!msg.includes('not found')) {
              log(`[wc-scheduler] getCoinRecordsByNames daemon error (skipping coin) name=${name}: ${msg}`);
            }
          } else {
            this.coinRecords.push(...(response.coinRecords ?? []));
          }
        } catch (e) {
          if (!isCoinRecordMiss(e)) {
            log(`[wc-scheduler] getCoinRecordsByNames unexpected error (skipping coin) name=${name}: ${getErrorText(e)}`);
          }
        } finally {
          this.finishCoinRequest(name);
        }
      },
    });
  }

  private finishCoinRequest(name: string): void {
    this.coinInFlightNames.delete(name);
    if (this.coinQueuedNames.size > 0 || this.coinInFlightNames.size > 0) return;
    if (this.coinCallbacks && this.coinInterested) {
      this.coinCallbacks.onRecords([...this.coinRecords], new Set(this.registeredCoinNames));
    }
    this.coinRecords = [];
    if (!this.coinInterested || this.watchedCoins.size === 0) return;
    if (this.coinDirty) {
      this.coinDirty = false;
      this.enqueueCoinSweep();
    } else {
      this.scheduleCoinTimer();
    }
  }

  private scheduleCoinTimer(): void {
    scheduleGapTimer(this.coinTimer, () => {
      if (this.coinInterested) this.enqueueCoinSweepOrMarkDirty();
    }, this.coinInterested && this.watchedCoins.size > 0);
  }

  private clearCoinTimer(): void {
    clearGapTimer(this.coinTimer);
  }
}

export const walletConnectScheduler = new WalletConnectScheduler();

async function request<T, D extends object = object>(
  method: ChiaMethod,
  data: D,
): Promise<T> {
  return walletConnectScheduler.request<T, D>(method, data);
}

async function getWallets(data: GetWalletsRequest) {
  return await request<GetWalletsResponse>(ChiaMethod.GetWallets, data);
}

async function getWalletBalance(data: GetWalletBalanceRequest) {
  return await request<GetWalletBalanceResponse>(
    ChiaMethod.GetWalletBalance,
    data,
  );
}

async function getNextAddress(data: GetNextAddressRequest) {
  return await request<GetNextAddressResponse>(
    ChiaMethod.GetNextAddress,
    data,
  );
}

async function selectCoins(data: SelectCoinsRequest) {
  return await request<SelectCoinsResponse>(ChiaMethod.SelectCoins, data);
}

async function getHeightInfo(data: GetHeightInfoRequest) {
  return await request<GetHeightInfoResponse>(ChiaMethod.GetHeightInfo, data);
}

async function createOfferForIds(data: CreateOfferForIdsRequest) {
  return await request<CreateOfferForIdsResponse>(
    ChiaMethod.CreateOfferForIds,
    data,
  );
}

async function pushTransactions(data: PushTransactionsRequest) {
  return await request<PushTransactionsResponse>(ChiaMethod.PushTransactions, data);
}

async function createNewRemoteWallet(data: CreateNewRemoteWalletRequest) {
  return await request<CreateNewRemoteWalletResponse>(
    ChiaMethod.CreateNewRemoteWallet,
    data,
  );
}

async function registerRemoteCoins(data: RegisterRemoteCoinsRequest) {
  return await request<RegisterRemoteCoinsResponse>(
    ChiaMethod.RegisterRemoteCoins,
    data,
  );
}

async function getCoinRecordsByNames(data: GetCoinRecordsByNamesRequest) {
  return await request<GetCoinRecordsByNamesResponse>(
    ChiaMethod.GetCoinRecordsByNames,
    data,
  );
}

async function getPuzzleAndSolution(data: GetPuzzleAndSolutionRequest) {
  return await request<GetPuzzleAndSolutionResponse>(
    ChiaMethod.GetPuzzleAndSolution,
    data,
  );
}

export const rpc = {
  getWallets,
  getWalletBalance,
  getNextAddress,
  selectCoins,
  getHeightInfo,
  createOfferForIds,
  pushTransactions,
  createNewRemoteWallet,
  registerRemoteCoins,
  getCoinRecordsByNames,
  getPuzzleAndSolution,
};
