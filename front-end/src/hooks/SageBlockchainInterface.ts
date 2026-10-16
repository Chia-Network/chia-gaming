import {
  sageRpc,
  WalletConnectTransportError,
  type SageCoin,
  type SageSpendableCoin,
} from './WalletConnectRpc';
import {
  InternalBlockchainInterface,
  BlockchainInboundAddressResult,
  ConnectionSetup,
  WalletOfferCompletion,
  WalletOfferProvider,
  WalletOfferRequest,
  WalletOfferCancellationOutcome,
  WalletSubmitOutcome,
} from '../types/ChiaGaming';
import { CoinRecord } from '../types/rpc/CoinRecord';
import { WalletSpendBundle } from '../types/rpc/PushTransactions';
import { log } from '../services/log';
import { normalizeHexString } from '../util';
import { decodeBech32mPuzzleHash } from '../util/bech32m';
import { jsonParse, jsonStringify } from '../util/jsonSafe';
import { isExactDuplicateTransaction } from '../util/walletSubmit';
import { getChainId } from '../constants/wallet-connect';
import { walletConnectState } from './useWalletConnect';
import { CoinsetClient, CoinsetTransportError, coinsetHttpCall } from './coinsetClient';
import { absAmountFromOffer } from './cloudWalletHelpers';
import { ensureWasmLoaded } from './WasmStateInit';

const COIN_PAGE_SIZE = 100;
const MAX_COIN_PAGES = 20;

type UnsignedWalletSpend = { coin_spends: WalletSpendBundle['coin_spends'] };

function coinKey(coin: { parent_coin_info: unknown; puzzle_hash: unknown; amount: unknown }) {
  return `${normalizeHexString(String(coin.parent_coin_info))}:${normalizeHexString(String(coin.puzzle_hash))}:${BigInt(coin.amount as bigint | string | number)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Coins this page has handed to a signed Sage spend. Sage locks coins only for
 * transactions it submits itself, so without this ledger two concurrent
 * operations could select the same coin. Reserved coins return to selection
 * when their reservation is cancelled; coins in a broadcast bundle stay
 * excluded for the life of the page because they are being spent, and Sage
 * has not recorded that spend if the broadcast fell back to Coinset.
 */
export class SageCoinLedger {
  private nextId = 0;
  private readonly reservations = new Map<string, Set<string>>();
  private readonly broadcast = new Set<string>();

  isAvailable(key: string): boolean {
    if (this.broadcast.has(key)) return false;
    for (const keys of this.reservations.values()) {
      if (keys.has(key)) return false;
    }
    return true;
  }

  reserve(kind: WalletOfferRequest['kind'], keys: Set<string>): string {
    const id = `sage-${kind}-${Date.now()}-${this.nextId++}`;
    this.reservations.set(id, keys);
    return id;
  }

  release(id: string): boolean {
    return this.reservations.delete(id);
  }

  markBroadcast(keys: Iterable<string>): void {
    for (const key of keys) this.broadcast.add(key);
  }
}

/**
 * Sage wallet over WalletConnect CHIP-0002. Sage lists and signs coins; Rust
 * builds the funding and fee spends from that coin list. Every public chain
 * read goes to coinset.org; broadcasts go through Sage so it tracks the
 * pending transaction, with Coinset as the fallback.
 */
export class SageBlockchainInterface implements InternalBlockchainInterface {
  readonly fundingMode = 'offer-settlement' as const;
  blockchainAddressData: BlockchainInboundAddressResult = { puzzleHash: '' };

  private readonly chain = new CoinsetClient(coinsetHttpCall, '[sage-blockchain]');
  private readonly ledger = new SageCoinLedger();
  private walletOfferProvider: WalletOfferProvider | null = null;
  private connectionListeners = new Set<(connected: boolean) => void>();
  private readinessListeners = new Set<(ready: boolean) => void>();
  private lastConnectedState = false;
  private wcSubscription: { unsubscribe: () => void } | null = null;
  private monitoringPromise: Promise<void> | null = null;
  private monitoringEpoch = 0;

  getWalletOfferProvider() {
    const fingerprint = walletConnectState.getAddress();
    const chainId = walletConnectState.getChainId?.() ?? getChainId();
    if (!fingerprint) return null;
    if (
      this.walletOfferProvider?.scope.provider !== 'sage' ||
      this.walletOfferProvider.scope.fingerprint !== fingerprint ||
      this.walletOfferProvider.scope.chainId !== chainId
    ) {
      this.walletOfferProvider = {
        capability: 'terminal',
        scope: { provider: 'sage', fingerprint, chainId },
        beginCreation: (_operation, request) => this.beginWalletSpend(request),
        cancel: (reservationId) => this.cancelReservation(reservationId),
      };
    }
    return this.walletOfferProvider;
  }

  async getAddress() {
    return this.blockchainAddressData;
  }

  async startMonitoring() {
    if (this.monitoringPromise) return this.monitoringPromise;
    const epoch = this.monitoringEpoch;
    this.monitoringPromise = this.doStartMonitoring(epoch).finally(() => {
      this.monitoringPromise = null;
    });
    return this.monitoringPromise;
  }

  private async doStartMonitoring(epoch: number) {
    const { address } = await sageRpc.getAddress();
    const puzzleHash = decodeBech32mPuzzleHash(address);
    if (!puzzleHash) {
      throw new Error(`failed to decode Sage address: ${address}`);
    }
    if (epoch !== this.monitoringEpoch || !walletConnectState.getSession()) return;
    this.blockchainAddressData = { puzzleHash, address };
    log(`[sage-blockchain] address resolved: ${address}`);
    this.fireConnectionChange(true);
  }

  private markDisconnected() {
    this.monitoringEpoch++;
    this.monitoringPromise = null;
    this.fireConnectionChange(false);
  }

  /**
   * Broadcast through Sage so it records the pending transaction and locks
   * its inputs. Sage's answer is final only when a peer reported a mempool
   * status; a thrown error can follow a successful broadcast (Sage records the
   * transaction after peers accept it), and a failure without an error means
   * no peer answered. Those cases fall back to Coinset, which resubmits the
   * exact bytes and reports duplicates as already included.
   */
  async spend(
    _blob: string,
    spendBundle: unknown,
    _changePuzzleHash: string,
    source?: string,
    fee?: bigint,
  ): Promise<WalletSubmitOutcome> {
    const bundle = spendBundle as WalletSpendBundle;
    if (!bundle?.coin_spends?.length) {
      return { status: 'rejected', detail: 'sendTransaction: empty spend bundle' };
    }
    this.ledger.markBroadcast(bundle.coin_spends.map((cs) => coinKey(cs.coin)));
    const from = source ?? 'unknown';
    try {
      const { status, error } = await sageRpc.sendTransaction({
        coin_spends: bundle.coin_spends.map((cs) => ({
          coin: {
            parent_coin_info: cs.coin.parent_coin_info,
            puzzle_hash: cs.coin.puzzle_hash,
            amount: BigInt(cs.coin.amount).toString(),
          },
          puzzle_reveal: cs.puzzle_reveal,
          solution: cs.solution,
        })),
        aggregated_signature: bundle.aggregated_signature,
      });
      log(
        `[sage-blockchain] sendTransaction from=${from} status=${status} error=${error ?? 'none'} spends=${bundle.coin_spends.length} fee=${fee || 0n}`,
      );
      if (status === 1n || status === 2n) {
        return { status: 'acknowledged', detail: status === 1n ? 'SUCCESS' : 'PENDING' };
      }
      if (error) {
        return isExactDuplicateTransaction(error)
          ? { status: 'acknowledged', detail: error }
          : { status: 'rejected', detail: `Sage sendTransaction rejected: ${error}` };
      }
      log(`[sage-blockchain] sendTransaction from=${from} reached no peer; using Coinset`);
    } catch (error) {
      log(
        `[sage-blockchain] sendTransaction from=${from} failed: ${errorText(error)}; using Coinset`,
      );
    }
    try {
      return await this.chain.pushTx(bundle, source, fee || 0n);
    } catch (error) {
      const detail = errorText(error);
      log(`[sage-blockchain] push_tx error from=${from}: ${detail}`);
      return error instanceof CoinsetTransportError
        ? { status: 'unavailable', detail }
        : { status: 'rejected', detail };
    }
  }

  async getBalance(): Promise<bigint> {
    const { spendable } = await sageRpc.getAssetBalance();
    return BigInt(spendable);
  }

  async getPuzzleAndSolution(coin: string): Promise<string[] | null> {
    return this.chain.getPuzzleAndSolution(coin);
  }

  async selectCoins(_uniqueId: string, amount: bigint): Promise<string | null> {
    log(`[sage-blockchain] selectCoins ignored amount=${amount}; Rust selects spend inputs`);
    return null;
  }

  async getHeightInfo(): Promise<bigint> {
    return this.chain.getHeightInfo();
  }

  async getCoinRecordsByNames(names: string[]): Promise<CoinRecord[]> {
    return this.chain.getCoinRecordsByNames(names);
  }

  async registerCoins(_names: string[]): Promise<void> {
    // Coinset is polled by coin name; nothing to register.
  }

  /** Sage's unlocked standard-wallet XCH coins that this page has not committed. */
  private async availableCoins(): Promise<SageSpendableCoin[]> {
    const coins: SageSpendableCoin[] = [];
    for (let page = 0; page < MAX_COIN_PAGES; page++) {
      const batch = await sageRpc.getAssetCoins(page * COIN_PAGE_SIZE, COIN_PAGE_SIZE);
      coins.push(...batch);
      if (batch.length < COIN_PAGE_SIZE) break;
    }
    return coins.filter((coin) => !coin.locked && this.ledger.isAvailable(coinKey(coin.coin)));
  }

  private walletSpendPurpose(request: WalletOfferRequest) {
    if (request.kind === 'fee') {
      return {
        kind: 'fee',
        fee: request.fee.toString(),
        target_coin_id: request.concurrentSpendCoinId,
      };
    }
    return {
      kind: 'funding',
      amount: absAmountFromOffer(request.offer).toString(),
      conditions: (request.extraConditions ?? []).map(({ opcode, args }) => ({
        opcode: Number(opcode),
        args,
      })),
      max_height: request.maxHeight?.toString() ?? null,
    };
  }

  private async beginWalletSpend(
    request: WalletOfferRequest,
  ): Promise<Exclude<WalletOfferCompletion, { kind: 'created-ephemeral' }>> {
    if (request.kind === 'fee' && request.fee <= 0n) {
      return { kind: 'failure', reason: 'fee must be positive' };
    }
    if (request.kind === 'funding' && request.coinIds?.length) {
      return { kind: 'failure', reason: 'Sage funding cannot pin wallet coins' };
    }
    const changePuzzleHash = this.blockchainAddressData.puzzleHash;
    if (!changePuzzleHash) {
      return { kind: 'unavailable', reason: 'Sage address is not resolved yet' };
    }

    let coins: SageSpendableCoin[];
    try {
      coins = await this.availableCoins();
    } catch (error) {
      return this.walletCallFailure('list coins', error);
    }

    let unsigned: UnsignedWalletSpend;
    try {
      const wasm = await ensureWasmLoaded();
      unsigned = jsonParse(
        wasm.build_wallet_spend(
          jsonStringify({
            coins: coins.map(({ coin, puzzle }) => ({
              coin: {
                parent_coin_info: coin.parent_coin_info,
                puzzle_hash: coin.puzzle_hash,
                amount: coin.amount.toString(),
              },
              puzzle_reveal: puzzle,
            })),
            change_puzzle_hash: changePuzzleHash,
            purpose: this.walletSpendPurpose(request),
          }),
        ),
      );
    } catch (error) {
      const reason = errorText(error);
      log(`[sage-blockchain] ${request.kind} spend construction failed: ${reason}`);
      return { kind: 'failure', reason };
    }

    const coinSpends = unsigned.coin_spends.map((cs) => ({
      coin: {
        parent_coin_info: cs.coin.parent_coin_info,
        puzzle_hash: cs.coin.puzzle_hash,
        amount: BigInt(cs.coin.amount).toString(),
      } satisfies SageCoin,
      puzzle_reveal: cs.puzzle_reveal,
      solution: cs.solution,
    }));
    let signature: string;
    try {
      signature = await sageRpc.signCoinSpends(coinSpends);
    } catch (error) {
      return this.walletCallFailure('sign spend', error);
    }

    const bundle = {
      coin_spends: unsigned.coin_spends,
      aggregated_signature: `0x${normalizeHexString(signature)}`,
    };
    const reservationId = this.ledger.reserve(
      request.kind,
      new Set(unsigned.coin_spends.map((cs) => coinKey(cs.coin))),
    );
    log(
      `[sage-blockchain] ${request.kind} spend signed inputs=${unsigned.coin_spends.length} reservation=${reservationId}`,
    );
    return {
      kind: 'created-reserved',
      material: { kind: 'bundle', bundle },
      tradeId: reservationId,
    };
  }

  private walletCallFailure(
    action: string,
    error: unknown,
  ): Extract<WalletOfferCompletion, { kind: 'failure' | 'unavailable' }> {
    const reason = `Sage could not ${action}: ${errorText(error)}`;
    log(`[sage-blockchain] ${reason}`);
    return error instanceof WalletConnectTransportError
      ? { kind: 'unavailable', reason }
      : { kind: 'failure', reason };
  }

  private async cancelReservation(reservationId: string): Promise<WalletOfferCancellationOutcome> {
    return this.ledger.release(reservationId)
      ? { status: 'cancelled' }
      : { status: 'already-terminal', detail: 'Sage reservation is not held by this page' };
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
    // Chain reads go to Coinset, so a connected wallet is ready for play.
    for (const cb of this.readinessListeners) {
      try {
        cb(connected);
      } catch {
        /* ignore */
      }
    }
  }

  private subscribeToWcEvents() {
    if (this.wcSubscription) return;
    this.wcSubscription = walletConnectState.getObservable().subscribe({
      next: (evt) => {
        // The Chia reference wallet shares the WalletConnect client.
        if (walletConnectState.getProfile() !== 'sage') return;
        if (evt.stateName === 'connected') {
          void this.startMonitoring().catch((err) => {
            log(`[sage-blockchain] monitoring setup after WalletConnect event failed: ${err}`);
            this.markDisconnected();
          });
        } else if (
          evt.connected === false ||
          (evt.stateName === 'initialized' && evt.sessions === 0)
        ) {
          this.markDisconnected();
        }
      },
    });
  }

  async beginConnect(_uniqueId: string, fresh = false): Promise<ConnectionSetup> {
    await walletConnectState.init();
    walletConnectState.useProfile('sage');
    this.subscribeToWcEvents();
    if (fresh) {
      await walletConnectState.forgetSessions();
      this.blockchainAddressData = { puzzleHash: '' };
    }

    if (walletConnectState.getSession()) {
      return {
        qrUri: '',
        skipQr: true,
        finalize: async () => {
          this.monitoringEpoch++;
          this.monitoringPromise = null;
          await this.startMonitoring();
        },
      };
    }

    const { uri, approval } = await walletConnectState.startConnect();
    return {
      qrUri: uri,
      finalize: async () => {
        await walletConnectState.connect(approval);
        await this.startMonitoring();
      },
    };
  }

  async disconnect(): Promise<void> {
    if (this.wcSubscription) {
      this.wcSubscription.unsubscribe();
      this.wcSubscription = null;
    }
    await walletConnectState.disconnect();
    this.markDisconnected();
  }

  isConnected(): boolean {
    return walletConnectState.getSession() !== undefined;
  }

  onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.connectionListeners.add(cb);
    this.subscribeToWcEvents();
    return () => {
      this.connectionListeners.delete(cb);
    };
  }

  isReadyForPlay(): boolean {
    return this.lastConnectedState;
  }

  onPlayReadinessChange(cb: (ready: boolean) => void): () => void {
    this.readinessListeners.add(cb);
    this.subscribeToWcEvents();
    return () => {
      this.readinessListeners.delete(cb);
    };
  }
}

export const sageBlockchainInfo: SageBlockchainInterface = new SageBlockchainInterface();
