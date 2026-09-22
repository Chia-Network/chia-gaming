import type { WalletOfferRequest } from '../../types/ChiaGaming';
import {
  MAX_FEE_ATTACHMENT_REASON_LENGTH,
  feeAttachmentEntryKey,
  feeAttachmentOperationKey,
  type FeeAttachment,
} from './feeAttachmentStore';
import { providerScopeKey } from './providerKeys';
import {
  boundedString,
  decodeProviderOwner,
  exactFields,
  exactStageFields,
  strictRecord,
  strictU64,
} from './providerValidation';

const MAX_ID = 1024;

function decodeRequest(
  value: unknown,
  label: string,
): Extract<WalletOfferRequest, { kind: 'fee' }> {
  const fields = strictRecord(value, label);
  exactFields(fields, ['kind', 'uniqueId', 'fee', 'concurrentSpendCoinId'], label);
  if (
    fields.kind !== 'fee' ||
    typeof fields.concurrentSpendCoinId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(fields.concurrentSpendCoinId)
  ) {
    throw new Error(`Garbled save: invalid ${label} fields`);
  }
  return {
    kind: 'fee',
    uniqueId: boundedString(fields.uniqueId, `${label}.uniqueId`, MAX_ID),
    fee: strictU64(fields.fee, `${label}.fee`),
    concurrentSpendCoinId: fields.concurrentSpendCoinId,
  };
}

export function decodeFeeAttachment(value: unknown, label: string): FeeAttachment {
  const fields = strictRecord(value, label);
  const commonKeys = ['owner', 'submissionId', 'stage', 'reason'];
  const stageKeys: Record<string, string[]> = {
    creating: ['disposition', 'recoveryId', 'request'],
    'best-effort-uncertain': ['disposition', 'request', 'lastAttemptEpoch'],
    reserved: ['providerReservationId'],
    'retained-for-replay': ['providerReservationId'],
    'cancel-required': ['providerReservationId'],
    'best-effort-cancellation-uncertain': ['providerReservationId', 'lastAttemptEpoch'],
    cancelling: ['providerReservationId', 'recoveryId'],
  };
  const orphanRisk = exactStageFields(fields, commonKeys, stageKeys, label);
  const common = {
    owner: decodeProviderOwner(fields.owner, `${label}.owner`),
    submissionId: boundedString(fields.submissionId, `${label}.submissionId`, MAX_ID),
    reason: boundedString(fields.reason, `${label}.reason`, MAX_FEE_ATTACHMENT_REASON_LENGTH, true),
    ...orphanRisk,
  };
  const reservation = (): string =>
    boundedString(fields.providerReservationId, `${label}.providerReservationId`, MAX_ID);
  if (fields.stage === 'creating' || fields.stage === 'best-effort-uncertain') {
    if (fields.disposition !== 'active' && fields.disposition !== 'cancel-on-create') {
      throw new Error(`Garbled save: invalid ${label}.disposition`);
    }
    const request = decodeRequest(fields.request, `${label}.request`);
    return fields.stage === 'creating'
      ? {
          ...common,
          stage: fields.stage,
          disposition: fields.disposition,
          request,
          recoveryId: boundedString(fields.recoveryId, `${label}.recoveryId`, MAX_ID),
        }
      : {
          ...common,
          stage: fields.stage,
          disposition: fields.disposition,
          request,
          lastAttemptEpoch: strictU64(fields.lastAttemptEpoch, `${label}.lastAttemptEpoch`),
        };
  }
  if (fields.stage === 'cancelling') {
    return {
      ...common,
      stage: fields.stage,
      providerReservationId: reservation(),
      recoveryId: boundedString(fields.recoveryId, `${label}.recoveryId`, MAX_ID),
    };
  }
  if (fields.stage === 'best-effort-cancellation-uncertain') {
    return {
      ...common,
      stage: fields.stage,
      providerReservationId: reservation(),
      lastAttemptEpoch: strictU64(fields.lastAttemptEpoch, `${label}.lastAttemptEpoch`),
    };
  }
  return {
    ...common,
    stage: fields.stage as 'reserved' | 'retained-for-replay' | 'cancel-required',
    providerReservationId: reservation(),
  };
}

export function decodeFeeAttachments(value: unknown, label = 'feeAttachments'): FeeAttachment[] {
  if (!Array.isArray(value)) throw new Error(`Garbled save: invalid ${label}`);
  const entries = new Set<string>();
  const operations = new Set<string>();
  const sessionScopes = new Map<string, string>();
  return value.map((item, index) => {
    const entry = decodeFeeAttachment(item, `${label}[${index}]`);
    const entryKey = feeAttachmentEntryKey(entry);
    const operation = feeAttachmentOperationKey(entry.owner, entry.submissionId);
    if (entries.has(entryKey) || operations.has(operation)) {
      throw new Error(`Garbled save: duplicate ${label} entry`);
    }
    entries.add(entryKey);
    operations.add(operation);
    const session = `${entry.owner.installationPlayerId}:${entry.owner.peerSessionId}`;
    const scope = providerScopeKey(entry.owner.providerScope);
    const prior = sessionScopes.get(session);
    if (prior && prior !== scope) {
      throw new Error(`Garbled save: fee attachments for one session span provider scopes`);
    }
    sessionScopes.set(session, scope);
    return entry;
  });
}
