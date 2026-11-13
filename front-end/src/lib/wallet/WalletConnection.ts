import { channelFundingRuntime } from '../session/channelFundingRuntime';
import { walletRecoveryNotice } from '../session/channelFundingSelectors';
import { log } from '../../services/log';
import type {
  ConnectionFieldValues,
  ConnectionSetup,
  InternalBlockchainInterface,
  WalletIdentity,
} from '../../types/ChiaGaming';
import { needsConnectionSetupPrompt, needsWalletPairing } from '../../util/connectionSetup';
import { markSavedSession } from '../session/saveCoordination';
import type { BlockchainType } from '../session/saveEnvelope';
import { storageRepository } from '../session/storageRepository';
import {
  TOP_UP_BALANCE_POLL_INTERVAL_MS,
  BALANCE_POLL_INTERVAL_MS,
  CHAIN_POLL_INTERVAL_MS,
  BlockchainPoller,
} from './BlockchainPoller';
import { cloudBlockchainInfo } from './CloudBlockchainInterface';
import { fakeBlockchainInfo } from './FakeBlockchainInterface';
import { realBlockchainInfo } from './RealBlockchainInterface';
import { sageBlockchainInfo } from './SageBlockchainInterface';
import type { SessionWallet } from './sessionWallet';

export interface WalletView {
  walletIdentity: WalletIdentity | null;
  grantedWallets: WalletIdentity[];
  switchingWallet: boolean;
  switchWalletError: string | null;
  recoveryNotice: ReturnType<typeof walletRecoveryNotice>;
  walletType: BlockchainType | undefined;
  connected: boolean;
  recovering: boolean;
  connecting: boolean;
  /** True while the provider is still preparing setup, before any QR or wallet approval. */
  preparingConnection: boolean;
  hasProvider: boolean;
  setup: Omit<ConnectionSetup, 'finalize'> | null;
  showSetup: boolean;
  error: string | null;
  balance: bigint | undefined;
  balanceError: string | null;
}
export type WalletEvent =
  | { type: 'view'; view: WalletView }
  | { type: 'connected' }
  | { type: 'connection'; connected: boolean; recovering: boolean }
  | { type: 'readiness'; ready: boolean }
  | { type: 'attention' | 'fee-changed' | 'detaching' };

function providerFor(type: BlockchainType) {
  return type === 'walletconnect'
    ? { provider: realBlockchainInfo, interval: CHAIN_POLL_INTERVAL_MS }
    : type === 'sage'
      ? { provider: sageBlockchainInfo, interval: CHAIN_POLL_INTERVAL_MS }
      : type === 'cloud'
        ? { provider: cloudBlockchainInfo, interval: CHAIN_POLL_INTERVAL_MS }
        : { provider: fakeBlockchainInfo, interval: 5000 };
}

/** Provider lifetime and normalization. Session and hub policy belongs to the host. */
export class WalletConnection {
  view: WalletView = {
    walletIdentity: null,
    grantedWallets: [],
    switchingWallet: false,
    switchWalletError: null,
    recoveryNotice: this.readRecoveryNotice(),
    walletType: storageRepository.query('blockchainType'),
    connected: false,
    recovering: false,
    connecting: false,
    preparingConnection: false,
    hasProvider: false,
    setup: null,
    showSetup: false,
    error: null,
    balance: undefined,
    balanceError: null,
  };
  private provider: InternalBlockchainInterface | null = null;
  private setup: ConnectionSetup | null = null;
  // A retry must not make a canceled attempt current again.
  private connectionAttempt = 0;
  private detachConnection: (() => void) | null = null;
  private detachReadiness: (() => void) | null = null;
  private poller: BlockchainPoller | null = null;

  constructor(private readonly emit: (event: WalletEvent) => void) {}

  private readRecoveryNotice() {
    return walletRecoveryNotice(
      [...storageRepository.channelFundingOperations(), ...storageRepository.feeAttachments()],
      channelFundingRuntime.providerScopeKeys(),
    );
  }
  start(): () => void {
    const refresh = () => {
      const recoveryNotice = this.readRecoveryNotice();
      if (
        recoveryNotice?.key !== this.view.recoveryNotice?.key ||
        recoveryNotice?.message !== this.view.recoveryNotice?.message
      )
        this.update({ recoveryNotice });
    };
    const stops = [
      storageRepository.onWalletOperationsChange(refresh),
      channelFundingRuntime.subscribe(refresh),
      storageRepository.onLifecycle(refresh),
    ];
    refresh();
    return () => stops.forEach((stop) => stop());
  }

  /** Application composition uses this; the GUI receives only WalletView and commands. */
  sessionAccess(): SessionWallet | null {
    return this.poller;
  }
  setSessionPolling(active: boolean): void {
    if (active) this.poller?.start();
    else this.poller?.pauseChainPolling();
  }
  setFundingBalancePolling(active: boolean): void {
    this.poller?.setBalanceInterval(
      active ? TOP_UP_BALANCE_POLL_INTERVAL_MS : BALANCE_POLL_INTERVAL_MS,
    );
  }
  topUpOptions() {
    return this.provider?.getTopUpOptions?.() ?? null;
  }
  providerScope() {
    return this.provider?.getWalletOfferProvider()?.scope;
  }
  ready(): boolean {
    return this.poller?.rpc.isReadyForPlay() ?? false;
  }

  private update(change: Partial<WalletView>): void {
    this.view = { ...this.view, ...change };
    this.emit({ type: 'view', view: this.view });
  }
  private presentSetup(setup: ConnectionSetup | null): void {
    this.setup = setup;
    if (!setup) {
      this.update({ setup: null });
      return;
    }
    const { finalize: _finalize, ...presentation } = setup;
    this.update({ setup: presentation });
  }
  private select(type: BlockchainType): void {
    markSavedSession();
    storageRepository.updateCommon({ preferences: { blockchainType: type } });
    this.update({ walletType: type });
  }
  private complete(
    provider: InternalBlockchainInterface,
    type: BlockchainType,
    interval: number,
  ): void {
    this.detachConnection?.();
    this.detachReadiness?.();
    this.stopPoller();
    this.poller = new BlockchainPoller(provider, interval, undefined, channelFundingRuntime);
    channelFundingRuntime.retryCancelRequired();
    this.poller.start();
    this.provider = provider;
    this.select(type);
    this.setup = null;
    this.update({
      hasProvider: true,
      walletIdentity: provider.getWalletIdentity?.() ?? null,
      grantedWallets: [],
      balance: undefined,
      balanceError: null,
      connected: true,
      recovering: false,
      connecting: false,
      preparingConnection: false,
      setup: null,
    });
    void this.loadGrantedWallets(provider);
    this.emit({ type: 'connected' });
    this.watchBalance();
    this.detachConnection = provider.onConnectionChange((connected, recovering = false) => {
      this.update({ connected, recovering });
      this.emit({ type: 'connection', connected, recovering });
      if (connected) {
        this.watchBalance();
        void this.loadGrantedWallets(provider);
      }
    });
    this.detachReadiness = this.poller.rpc.onPlayReadinessChange((ready) =>
      this.emit({ type: 'readiness', ready }),
    );
    this.emit({ type: 'readiness', ready: this.ready() });
    log(`${type} wallet connected`);
  }
  private async loadGrantedWallets(provider: InternalBlockchainInterface): Promise<void> {
    if (!provider.listWallets) return;
    const attempt = this.connectionAttempt;
    try {
      const grantedWallets = await provider.listWallets();
      if (attempt === this.connectionAttempt && this.provider === provider)
        this.update({ grantedWallets, walletIdentity: provider.getWalletIdentity?.() ?? null });
    } catch (error) {
      console.error('[wallet] listing granted wallets failed', error);
      if (attempt === this.connectionAttempt && this.provider === provider)
        this.update({ grantedWallets: [] });
    }
  }

  async selectWallet(walletId: string): Promise<void> {
    const provider = this.provider;
    if (!provider?.selectWallet || this.view.connecting || this.view.switchingWallet) return;
    const attempt = this.connectionAttempt;
    this.poller?.stopBalanceInterest();
    this.update({
      switchingWallet: true,
      switchWalletError: null,
      balance: undefined,
      balanceError: null,
    });
    try {
      await provider.selectWallet(walletId);
      if (attempt === this.connectionAttempt && this.provider === provider)
        this.update({ walletIdentity: provider.getWalletIdentity?.() ?? null });
    } catch (error) {
      if (attempt === this.connectionAttempt && this.provider === provider)
        this.update({ switchWalletError: error instanceof Error ? error.message : String(error) });
    } finally {
      if (attempt === this.connectionAttempt && this.provider === provider) {
        this.watchBalance();
        this.update({ switchingWallet: false });
      }
    }
  }

  watchBalance(): void {
    this.poller?.stopBalanceInterest();
    this.poller?.startBalanceInterest(BALANCE_POLL_INTERVAL_MS, {
      onBalance: (balance) => this.update({ balance, balanceError: null }),
      onError: (error) =>
        this.update({
          balance: undefined,
          balanceError: error instanceof Error ? error.message : String(error),
        }),
    });
    this.update({ balance: undefined, balanceError: null });
  }

  async connect(type: BlockchainType, silent = false, fresh = false): Promise<boolean> {
    const attempt = ++this.connectionAttempt;
    if (!silent) this.update({ error: null });
    const { provider, interval } = providerFor(type);
    try {
      this.select(type);
      this.update({ connecting: true, preparingConnection: true });
      const setup = await provider.beginConnect(storageRepository.getPlayerId(), fresh);
      if (attempt !== this.connectionAttempt) return false;
      this.update({ preparingConnection: false });
      if (needsWalletPairing(setup)) {
        this.presentSetup(setup);
        this.update({ connected: false });
        if (silent) {
          this.update({ connecting: false });
          this.emit({ type: 'attention' });
          return false;
        }
      }
      if (!setup.skipQr || setup.fields) this.presentSetup(setup);
      if (setup.fields && (!silent || needsConnectionSetupPrompt(setup))) {
        this.update({ showSetup: true, connecting: false });
        if (silent) this.emit({ type: 'attention' });
        return false;
      }
      await setup.finalize(undefined, () => {
        if (attempt === this.connectionAttempt) this.presentSetup(null);
      });
      if (attempt !== this.connectionAttempt) return false;
      this.complete(provider, type, interval);
      return true;
    } catch (error) {
      if (attempt !== this.connectionAttempt) return false;
      console.error(`[wallet] ${type} connect failed`, error);
      this.update({
        error: error instanceof Error ? error.message : String(error),
        preparingConnection: false,
      });
      if (silent) {
        if (type === 'simulator') this.complete(provider, type, interval);
        else this.update({ connecting: false });
      } else {
        if (!this.provider) {
          this.update({ walletType: undefined });
        }
        this.presentSetup(null);
        this.update({ connecting: false });
      }
    }
    return false;
  }

  async finalize(values?: ConnectionFieldValues): Promise<boolean> {
    const type = this.view.walletType;
    if (!this.setup || !type) return false;
    const { provider, interval } = providerFor(type);
    const attempt = ++this.connectionAttempt;
    this.update({ error: null, connecting: true });
    try {
      await this.setup.finalize(values, () => {
        if (attempt === this.connectionAttempt) this.presentSetup(null);
      });
      if (attempt !== this.connectionAttempt) return false;
      this.emit({ type: 'fee-changed' });
      this.update({ showSetup: false });
      this.complete(provider, type, interval);
      return true;
    } catch (error) {
      if (attempt !== this.connectionAttempt) return false;
      console.error(`[wallet] ${type} finalize failed`, error);
      this.update({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (attempt === this.connectionAttempt) this.update({ connecting: false });
    }
    return false;
  }

  async resume(type: BlockchainType): Promise<void> {
    const attempt = ++this.connectionAttempt;
    const { provider, interval } = providerFor(type);
    this.provider = provider;
    this.update({
      walletType: type,
      hasProvider: true,
      connected: provider.isConnected(),
      connecting: true,
      preparingConnection: false,
    });
    try {
      const setup = await provider.beginConnect(storageRepository.getPlayerId());
      if (attempt !== this.connectionAttempt) return;
      if (needsWalletPairing(setup) || needsConnectionSetupPrompt(setup)) {
        this.presentSetup(setup);
        this.update({
          connected: false,
          connecting: false,
          showSetup: needsConnectionSetupPrompt(setup),
        });
        this.emit({ type: 'attention' });
        return;
      }
      if (setup.skipQr || setup.fields) await setup.finalize();
      if (attempt !== this.connectionAttempt) return;
      this.complete(provider, type, interval);
    } catch (error) {
      if (attempt !== this.connectionAttempt) return;
      console.warn('[wallet] resume connect failed, falling back', error);
      if (!this.poller && type === 'simulator') this.complete(provider, type, interval);
      else this.update({ connecting: false });
    }
  }

  async cancel(): Promise<void> {
    const provider =
      this.provider ?? (this.view.walletType ? providerFor(this.view.walletType).provider : null);
    // Retire local work before awaiting teardown, which may outlive a retry.
    this.stopLocalActivity();
    this.presentSetup(null);
    this.update({
      walletType: undefined,
      connecting: false,
      preparingConnection: false,
      connected: false,
      showSetup: false,
      error: null,
    });
    try {
      await provider?.disconnect();
    } catch {
      /* Cancellation is best effort. */
    }
  }

  async disconnect(): Promise<void> {
    const provider = this.provider;
    this.stopLocalActivity();
    this.presentSetup(null);
    this.update({
      walletType: undefined,
      connected: false,
      connecting: false,
      preparingConnection: false,
      showSetup: false,
      balance: undefined,
      balanceError: null,
    });
    try {
      await provider?.disconnect();
    } catch {
      /* Preserve local disconnect. */
    }
  }

  private stopPoller(): void {
    const poller = this.poller;
    if (!poller) return;
    this.poller = null;
    this.emit({ type: 'detaching' });
    poller.detachProvider();
    poller.stopBalanceInterest();
    poller.pauseChainPolling();
  }

  stopLocalActivity(): void {
    ++this.connectionAttempt;
    this.detachConnection?.();
    this.detachConnection = null;
    this.detachReadiness?.();
    this.detachReadiness = null;
    this.stopPoller();
    this.provider = null;
    this.update({
      hasProvider: false,
      recovering: false,
      walletIdentity: null,
      grantedWallets: [],
      balance: undefined,
      balanceError: null,
      switchingWallet: false,
      switchWalletError: null,
    });
  }
  leavePage(): void {
    if (this.view.walletType === 'simulator') void this.provider?.disconnect().catch(() => {});
  }
}
