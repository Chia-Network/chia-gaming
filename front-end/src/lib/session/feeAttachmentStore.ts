import type { WalletOfferOperation, WalletOfferRequest } from '../../types/ChiaGaming';
import { providerOwnerKey } from './providerKeys';

export type FeeAttachmentOwner = WalletOfferOperation['owner'];
export type FeeAttachmentRequest = Extract<WalletOfferRequest, { kind: 'fee' }>;

interface FeeBase {
  owner: FeeAttachmentOwner;
  submissionId: string;
  reason: string;
  orphanRisk?: 'pre-id-response-lost';
}
export type FeeAttachmentCreating = FeeBase & {
  stage: 'creating';
  disposition: 'active' | 'cancel-on-create';
  recoveryId: string;
  request: FeeAttachmentRequest;
};
export type FeeAttachmentUncertain = FeeBase & {
  stage: 'best-effort-uncertain';
  disposition: 'active' | 'cancel-on-create';
  request: FeeAttachmentRequest;
  lastAttemptEpoch: bigint;
};
export type FeeAttachmentIdentified = FeeBase & {
  stage: 'reserved' | 'retained-for-replay' | 'cancel-required';
  providerReservationId: string;
};
export type FeeAttachmentCancellationUncertain = FeeBase & {
  stage: 'best-effort-cancellation-uncertain';
  providerReservationId: string;
  lastAttemptEpoch: bigint;
};
export type FeeAttachmentCancelling = FeeBase & {
  stage: 'cancelling';
  providerReservationId: string;
  recoveryId: string;
};
export type FeeAttachment =
  | FeeAttachmentCreating
  | FeeAttachmentUncertain
  | FeeAttachmentIdentified
  | FeeAttachmentCancellationUncertain
  | FeeAttachmentCancelling;
export type IdentifiedFeeAttachment = Exclude<
  FeeAttachment,
  FeeAttachmentCreating | FeeAttachmentUncertain
>;
export const MAX_FEE_ATTACHMENT_REASON_LENGTH = 256;

export function feeAttachmentOperationKey(owner: FeeAttachmentOwner, submissionId: string): string {
  const ownerKey = providerOwnerKey(owner);
  return `${ownerKey.length}:${ownerKey}${submissionId.length}:${submissionId}`;
}
export function feeAttachmentEntryKey(entry: FeeAttachment): string {
  return entry.stage === 'creating' || entry.stage === 'best-effort-uncertain'
    ? `submission:${feeAttachmentOperationKey(entry.owner, entry.submissionId)}`
    : `reservation:${entry.providerReservationId}`;
}
export function feeAttachmentForSubmission(
  entries: readonly FeeAttachment[],
  owner: FeeAttachmentOwner,
  submissionId: string,
): FeeAttachment | null {
  const key = feeAttachmentOperationKey(owner, submissionId);
  return (
    entries.find((entry) => feeAttachmentOperationKey(entry.owner, entry.submissionId) === key) ??
    null
  );
}
export function identifiedFeeAttachment(
  entries: readonly FeeAttachment[],
  providerReservationId: string,
): IdentifiedFeeAttachment | null {
  const entry = entries.find(
    (candidate) =>
      candidate.stage !== 'creating' &&
      candidate.stage !== 'best-effort-uncertain' &&
      candidate.providerReservationId === providerReservationId,
  );
  return entry && entry.stage !== 'creating' && entry.stage !== 'best-effort-uncertain'
    ? entry
    : null;
}
