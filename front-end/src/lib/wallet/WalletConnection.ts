import { channelFundingRuntime } from '../session/channelFundingRuntime';
import { walletRecoveryNotice } from '../session/channelFundingSelectors';
import { log } from '../../services/log';
import type {
  ConnectionFieldValues,
  ConnectionSetup,
  InternalBlockchainInterface,
} from '../../types/ChiaGaming';
import { needsConnectionSetupPrompt, needsWalletPairing } from '../../util/connectionSetup';
import { markSavedSession } from '../session/saveCoordination';
import type { BlockchainType } from '../session/saveEnvelope';
import { storageRepository } from '../session/storageRepository';
import {
  BALANCE_POLL_INTERVAL_MS,
  CHAIN_POLL_INTERVAL_MS,
  BlockchainPoller,
} from './BlockchainPoller';
import { cloudBlockchainInfo } from './CloudBlockchainInterface';
import { fakeBlockchainInfo } from './FakeBlockchainInterface';
import { realBlockchainInfo } from './RealBlockchainInterface';
import type { SessionWallet } from './sessionWallet';

export interface WalletView {
  recoveryNotice: ReturnType<typeof walletRecoveryNotice>;
  walletType: BlockchainType | undefined;
  connected: boolean;
  connecting: boolean;
  hasProvider: boolean;
  setup: Omit<ConnectionSetup, 'finalize'> | null;
  showSetup: boolean;
  error: string | null;
  balance: bigint | undefined;
}
export type WalletEvent =
  | { type: 'view'; view: WalletView }
  | { type: 'connected' }
  | { type: 'connection'; connected: boolean }
  | { type: 'readiness'; ready: boolean }
  | { type: 'attention' | 'fee-changed' | 'detaching' };

function providerFor(type: BlockchainType) {
  return type === 'walletconnect'
    ? { provider: realBlockchainInfo, interval: CHAIN_POLL_INTERVAL_MS }
    : type === 'cloud'
      ? { provider: cloudBlockchainInfo, interval: CHAIN_POLL_INTERVAL_MS }
      : { provider: fakeBlockchainInfo, interval: 5000 };
}

/** Provider lifetime and normalization. Session and hub policy belongs to the host. */
export class WalletConnection {
  view: WalletView = {
    recoveryNotice: this.readRecoveryNotice(),
    walletType: storageRepository.query('blockchainType'),
    connected: false,
    connecting: false,
    hasProvider: false,
    setup: null,
    showSetup: false,
    error: null,
    balance: undefined,
  };
  private provider: InternalBlockchainInterface | null = null;
  private setup: ConnectionSetup | null = null;
  private aborted = false;
  private detachConnection: (() => void) | null = null;
  private detachReadiness: (() => void) | null = null;
  private poller: BlockchainPoller | null = null;

  constructor(
    private readonly playerId: string,
    private readonly emit: (event: WalletEvent) => void,
  ) {}

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
    this.update({ hasProvider: true, connected: true, connecting: false, setup: null });
    this.emit({ type: 'connected' });
    this.watchBalance();
    this.detachConnection = provider.onConnectionChange((connected) => {
      this.update({ connected });
      this.emit({ type: 'connection', connected });
      if (connected) this.watchBalance();
    });
    this.detachReadiness = this.poller.rpc.onPlayReadinessChange((ready) =>
      this.emit({ type: 'readiness', ready }),
    );
    this.emit({ type: 'readiness', ready: this.ready() });
    log(`${type} wallet connected`);
  }
  watchBalance(): void {
    this.poller?.stopBalanceInterest();
    this.poller?.startBalanceInterest(BALANCE_POLL_INTERVAL_MS, {
      onBalance: (balance) => this.update({ balance }),
      onError: () => {},
    });
  }

  async connect(type: BlockchainType, silent = false, fresh = false): Promise<boolean> {
    this.aborted = false;
    if (!silent) this.update({ error: null });
    const { provider, interval } = providerFor(type);
    try {
      this.select(type);
      this.update({ connecting: true });
      const setup = await provider.beginConnect(this.playerId, fresh);
      if (this.aborted) return false;
      if (needsWalletPairing(setup)) {
        this.presentSetup(setup);
        this.update({ connected: false, connecting: false });
        if (silent) {
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
      await setup.finalize();
      if (this.aborted) return false;
      this.complete(provider, type, interval);
      return true;
    } catch (error) {
      if (!this.aborted) {
        console.error(`[wallet] ${type} connect failed`, error);
        this.update({ error: error instanceof Error ? error.message : String(error) });
      }
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
    this.aborted = false;
    this.update({ error: null, connecting: true });
    try {
      await this.setup.finalize(values);
      if (this.aborted) return false;
      this.emit({ type: 'fee-changed' });
      this.update({ showSetup: false });
      this.complete(provider, type, interval);
      return true;
    } catch (error) {
      if (this.aborted) return false;
      console.error(`[wallet] ${type} finalize failed`, error);
      this.update({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.update({ connecting: false });
    }
    return false;
  }

  async resume(type: BlockchainType): Promise<void> {
    const { provider, interval } = providerFor(type);
    this.provider = provider;
    this.update({
      walletType: type,
      hasProvider: true,
      connected: provider.isConnected(),
      connecting: true,
    });
    try {
      const setup = await provider.beginConnect(this.playerId);
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
      this.complete(provider, type, interval);
    } catch (error) {
      console.warn('[wallet] resume connect failed, falling back', error);
      if (!this.poller && type === 'simulator') this.complete(provider, type, interval);
      else this.update({ connecting: false });
    }
  }

  async cancel(): Promise<void> {
    this.aborted = true;
    this.stopPoller();
    const provider =
      this.provider ?? (this.view.walletType ? providerFor(this.view.walletType).provider : null);
    try {
      await provider?.disconnect();
    } catch {
      /* Cancellation is best effort. */
    }
    this.stopLocalActivity();
    this.presentSetup(null);
    this.update({
      walletType: undefined,
      connecting: false,
      connected: false,
      showSetup: false,
      error: null,
    });
  }

  async disconnect(): Promise<void> {
    this.stopPoller();
    this.update({ connected: false });
    try {
      await this.provider?.disconnect();
    } catch {
      /* Preserve local disconnect. */
    }
    this.stopLocalActivity();
    this.update({ walletType: undefined, connected: false, balance: undefined });
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
    this.detachConnection?.();
    this.detachConnection = null;
    this.detachReadiness?.();
    this.detachReadiness = null;
    this.stopPoller();
    this.provider = null;
    this.update({ hasProvider: false });
  }
  leavePage(): void {
    if (this.view.walletType === 'simulator') void this.provider?.disconnect().catch(() => {});
  }
}
