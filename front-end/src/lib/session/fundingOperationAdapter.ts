import type { NeedCoinSpendRequest } from '../../types/ChiaGaming';
import { diagStack, log } from '../../services/log';
import { jsonStringify } from '../../util/jsonSafe';
import {
  canonicalizeFundingRequest,
  fundingRequestKey,
  type CanonicalFundingRequest,
} from './fundingRequest';
import type { SessionRuntimeLease } from './sessionRuntimeLease';
import {
  walletOperation,
  type WalletOperationHandle,
  type WalletOperationService,
} from './walletOperationService';
import type { WalletOperationOwner } from './walletOperationStore';

type LaunchState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'scheduled'; readonly lease: SessionRuntimeLease }
  | { readonly kind: 'launched' };

interface FundingAttempt {
  readonly key: string;
  readonly request: CanonicalFundingRequest;
  launchState: LaunchState;
  operation?: WalletOperationHandle;
}

export interface FundingOperationPorts {
  getLease(): SessionRuntimeLease | null;
  getWalletOperations(): WalletOperationService;
  getOwnerForRead(): WalletOperationOwner | null;
  requireOwner(): WalletOperationOwner;
  isBlockchainAvailable(): boolean;
  isRetired(): boolean;
  mutate<T>(work: () => T): Promise<T>;
  track(effect: Promise<void>): void;
  requestCommit(): void;
  scheduleCleanup(): void;
  provideOffer(offer: string): void;
  provideBundle(bundleJson: string): void;
  failRust(message: string): void;
  reportError(message: string): void;
}

function messageFrom(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /insufficient funds/i.test(message)
    ? 'Wallet reports insufficient funds. It may be that your wallet has enough balance but some coins are locked. Free up locked coins in your wallet and try again.'
    : message;
}

export class FundingOperationAdapter {
  private active: FundingAttempt | null = null;

  constructor(private readonly ports: FundingOperationPorts) {}

  queue(request: NeedCoinSpendRequest): void {
    const canonical = canonicalizeFundingRequest(request, 'WASM NeedCoinSpend request');
    const key = fundingRequestKey(canonical);
    if (this.active) {
      if (this.active.key === key) return;
      const message = `Internal protocol-state violation: received concurrent funding request ${key} while ${this.active.key} is active`;
      this.active = null;
      this.ports.failRust(message);
      throw new Error(message);
    }
    this.active = { key, request: canonical, launchState: { kind: 'idle' } };
    this.schedule();
  }

  schedule(): void {
    const attempt = this.active;
    if (!attempt) return;
    const lease = this.ports.getLease();
    const owner = this.ports.getOwnerForRead();
    if (!lease || !owner) return;
    if (
      this.ports
        .getWalletOperations()
        .hasBlockingTradeOperation(owner, { kind: 'funding', operationId: attempt.key })
    ) {
      return;
    }
    if (attempt.launchState.kind === 'launched') return;
    if (attempt.launchState.kind === 'scheduled' && attempt.launchState.lease === lease) return;
    attempt.launchState = { kind: 'scheduled', lease };
    const effect = lease.releaseAfterPersistence(attempt.key, () => {
      if (this.active !== attempt) return Promise.resolve();
      attempt.launchState = { kind: 'launched' };
      return this.execute(attempt);
    });
    this.ports.track(effect);
  }

  providerReady(): void {
    if (!this.active) return;
    this.active.launchState = { kind: 'idle' };
    this.schedule();
  }

  retire(reason: string): void {
    this.active?.operation?.retire(reason);
    this.active = null;
  }

  private async execute(attempt: FundingAttempt): Promise<void> {
    if (!this.ports.isBlockchainAvailable()) {
      attempt.launchState = { kind: 'idle' };
      this.ports.requestCommit();
      return;
    }
    const operation =
      attempt.operation ??
      (attempt.operation = walletOperation(
        this.ports.getWalletOperations(),
        this.ports.requireOwner(),
        { kind: 'funding', operationId: attempt.key },
      ));
    try {
      const outcome = await operation.createFunding(attempt.request);
      if (outcome.kind === 'unavailable') {
        await this.ports.mutate(() => {
          if (this.active === attempt) {
            attempt.launchState = { kind: 'idle' };
            log(`[wasm] funding wallet unavailable: ${outcome.reason}`);
            this.ports.requestCommit();
          }
        });
        return;
      }
      if (outcome.kind === 'failure') {
        await this.ports.mutate(() => {
          this.finish(attempt);
          this.ports.reportError(outcome.reason);
          this.ports.failRust(outcome.reason);
          this.ports.requestCommit();
        });
        return;
      }
      if (this.active !== attempt || this.ports.isRetired()) {
        operation.settle('cancel-required', 'funding-offer-stale');
        return;
      }
      if (outcome.material.kind === 'offer') {
        const offer = outcome.material.offer;
        await this.ports.mutate(() => {
          if (this.ports.isRetired()) {
            operation.settle('cancel-required', 'funding-cradle-unavailable', true);
            this.ports.scheduleCleanup();
            this.finish(attempt);
            this.ports.requestCommit();
            return;
          }
          try {
            if (outcome.warning) this.ports.reportError(outcome.warning);
            this.ports.provideOffer(offer);
            operation.settle('consumed', 'funding-offer-consumed', true);
            this.finish(attempt);
            this.ports.requestCommit();
          } catch (error) {
            operation.settle('cancel-required', 'funding-offer-rejected', true);
            this.ports.scheduleCleanup();
            this.ports.requestCommit();
            throw error;
          }
        });
      } else {
        const bundleJson = jsonStringify(outcome.material.bundle);
        await this.ports.mutate(() => {
          if (outcome.warning) this.ports.reportError(outcome.warning);
          this.finish(attempt);
          this.ports.provideBundle(bundleJson);
          this.ports.requestCommit();
        });
      }
    } catch (error) {
      if (this.ports.isRetired()) return;
      diagStack('handleNeedCoinSpend error', error);
      log(`[wasm] handleNeedCoinSpend error: ${String(error)}`);
      const message = messageFrom(error);
      await this.ports.mutate(() => {
        this.finish(attempt);
        this.ports.reportError(message);
        this.ports.failRust(message);
        this.ports.requestCommit();
      });
    }
  }

  private finish(attempt: FundingAttempt): void {
    if (this.active === attempt) this.active = null;
  }
}
