import type { WalletOfferCompletion, WalletOfferRequest } from '../../types/ChiaGaming';
import type { CanonicalFundingRequest } from './fundingRequest';
import type { WalletOperationRuntime } from './walletOperationRuntime';
import type { WalletOperationOwner, WalletOperationPurpose } from './walletOperationStore';
import { providerRequestFromRecovery } from './walletOperationSelectors';

export interface WalletOperationHandle {
  readonly owner: WalletOperationOwner;
  readonly purpose: WalletOperationPurpose;
  createFunding(request: CanonicalFundingRequest): Promise<WalletOfferCompletion>;
  createFee(request: Extract<WalletOfferRequest, { kind: 'fee' }>): Promise<WalletOfferCompletion>;
  settle(
    disposition: 'consumed' | 'cancel-required' | 'retained-for-replay',
    reason: string,
    coordinated?: boolean,
  ): void;
  retire(reason: string): void;
}

export function walletOperation(
  runtime: WalletOperationRuntime,
  owner: WalletOperationOwner,
  purpose: WalletOperationPurpose,
): WalletOperationHandle {
  let retired = false;
  return {
    owner,
    purpose,
    createFunding: (request) =>
      runtime.createOffer(
        owner,
        purpose,
        providerRequestFromRecovery(owner, { kind: 'funding', canonical: request }),
        { kind: 'funding', canonical: request },
        () => retired,
      ),
    createFee: (request) => {
      if (!/^[0-9a-f]{64}$/.test(request.concurrentSpendCoinId))
        throw new Error('Fee target coin id must be lowercase 64-hex');
      return runtime.createOffer(owner, purpose, request, request, () => retired);
    },
    settle: (disposition, reason, coordinated = false) =>
      runtime.settleOperation(owner, purpose, disposition, reason, coordinated),
    retire: (reason) => {
      retired = true;
      runtime.retireOperation(owner, purpose, reason);
    },
  };
}
