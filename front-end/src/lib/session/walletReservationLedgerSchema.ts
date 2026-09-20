import type { WalletOfferRequest, WalletProviderScope } from '../../types/ChiaGaming';
import { decodeCanonicalFundingRequest, type CanonicalFundingRequest } from './fundingRequest';

export interface WalletReservationOwner {
  installationPlayerId: string;
  peerSessionId: string;
  providerScope: WalletProviderScope;
}

export type WalletReservationPurpose =
  | { kind: 'funding'; operationId: string }
  | { kind: 'fee'; operationId: string };

export type WalletReservationStage =
  | 'creating'
  | 'reserved'
  | 'retained-for-replay'
  | 'cancel-required'
  | 'cancelling';

interface WalletReservationEntryBase {
  owner: WalletReservationOwner;
  purpose: WalletReservationPurpose;
  reason: string;
}

export type WalletReservationRecoveryEntry = WalletReservationEntryBase & {
  stage: 'creating';
  disposition: 'active' | 'cancel-on-create';
  recoveryId: string;
  request: WalletReservationRecoveryRequest;
};

export type WalletReservationRecoveryRequest =
  | { kind: 'funding'; canonical: CanonicalFundingRequest }
  | Extract<WalletOfferRequest, { kind: 'fee' }>;

export type WalletReservationTradeEntry = WalletReservationEntryBase & {
  stage: Exclude<WalletReservationStage, 'creating' | 'cancelling'>;
  tradeId: string;
};

export type WalletReservationCancellationEntry = WalletReservationEntryBase & {
  stage: 'cancelling';
  tradeId: string;
  recoveryId: string;
};

export type WalletReservationLedgerEntry =
  | WalletReservationRecoveryEntry
  | WalletReservationTradeEntry
  | WalletReservationCancellationEntry;

export const WALLET_RESERVATION_RECORD_SCHEMA = 'chia-gaming-wallet-reservations' as const;
export const WALLET_RESERVATION_RECORD_VERSION = 5n;

export interface WalletReservationRecord {
  schema: typeof WALLET_RESERVATION_RECORD_SCHEMA;
  version: typeof WALLET_RESERVATION_RECORD_VERSION;
  entries: WalletReservationLedgerEntry[];
}

const MAX_TRADE_ID_LENGTH = 256;
const MAX_IDENTITY_LENGTH = 256;
const MAX_OPERATION_ID_LENGTH = 1024;
export const MAX_WALLET_RESERVATION_REASON_LENGTH = 256;

function tupleKey(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('');
}

function requireBoundedString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximum) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value;
}

export function walletReservationOperationKey(
  owner: WalletReservationOwner,
  purpose: WalletReservationPurpose,
): string {
  return tupleKey([walletReservationOwnerKey(owner), purpose.kind, purpose.operationId]);
}

export function walletReservationOperationPrefix(owner: WalletReservationOwner): string {
  const ownerKey = walletReservationOwnerKey(owner);
  return `${ownerKey.length}:${ownerKey}`;
}

export function walletReservationOwnerKey(owner: WalletReservationOwner): string {
  return tupleKey([
    owner.installationPlayerId,
    owner.peerSessionId,
    walletProviderScopeKey(owner.providerScope),
  ]);
}

export function walletProviderScopeKey(scope: WalletProviderScope): string {
  switch (scope.provider) {
    case 'cloud':
      return tupleKey(['cloud', scope.walletId]);
    case 'walletconnect':
      return tupleKey(['walletconnect', scope.fingerprint, scope.chainId]);
    case 'simulator':
      return tupleKey(['simulator', scope.identity]);
  }
}

function decodeProviderScope(value: unknown, label: string): WalletProviderScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  const fields = value as Record<string, unknown>;
  if (fields.provider === 'cloud' && Object.keys(fields).length === 2) {
    return {
      provider: 'cloud',
      walletId: requireBoundedString(fields.walletId, `${label}.walletId`, MAX_IDENTITY_LENGTH),
    };
  }
  if (fields.provider === 'walletconnect' && Object.keys(fields).length === 3) {
    return {
      provider: 'walletconnect',
      fingerprint: requireBoundedString(
        fields.fingerprint,
        `${label}.fingerprint`,
        MAX_IDENTITY_LENGTH,
      ),
      chainId: requireBoundedString(fields.chainId, `${label}.chainId`, MAX_IDENTITY_LENGTH),
    };
  }
  if (fields.provider === 'simulator' && Object.keys(fields).length === 2) {
    return {
      provider: 'simulator',
      identity: requireBoundedString(fields.identity, `${label}.identity`, MAX_IDENTITY_LENGTH),
    };
  }
  throw new Error(`Garbled save: invalid ${label} fields`);
}

function requireU64(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value;
}

function decodeOfferRequest(value: unknown, label: string): WalletReservationRecoveryRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  const fields = value as Record<string, unknown>;
  if (fields.kind === 'funding') {
    if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields, 'canonical')) {
      throw new Error(`Garbled save: invalid ${label} fields`);
    }
    return {
      kind: 'funding',
      canonical: decodeCanonicalFundingRequest(fields.canonical, `${label}.canonical`),
    };
  }
  const uniqueId = requireBoundedString(fields.uniqueId, `${label}.uniqueId`, MAX_IDENTITY_LENGTH);
  if (fields.kind === 'fee') {
    if (
      Object.keys(fields).length !== 4 ||
      !Object.hasOwn(fields, 'fee') ||
      !Object.hasOwn(fields, 'concurrentSpendCoinId')
    ) {
      throw new Error(`Garbled save: invalid ${label} fields`);
    }
    return {
      kind: 'fee',
      uniqueId,
      fee: requireU64(fields.fee, `${label}.fee`),
      concurrentSpendCoinId: requireCanonicalCoinId(
        fields.concurrentSpendCoinId,
        `${label}.concurrentSpendCoinId`,
      ),
    };
  }
  throw new Error(`Garbled save: invalid ${label} fields`);
}

function requireCanonicalCoinId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value;
}

export function decodeWalletReservationLedgerEntry(
  value: unknown,
  label = 'wallet reservation ledger entry',
): WalletReservationLedgerEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  const creating = fields.stage === 'creating';
  const cancelling = fields.stage === 'cancelling';
  if (
    keys.length !== (creating ? 7 : cancelling ? 6 : 5) ||
    !keys.includes('owner') ||
    !keys.includes('purpose') ||
    !keys.includes('stage') ||
    !keys.includes('reason') ||
    (creating
      ? !keys.includes('disposition') || !keys.includes('recoveryId') || !keys.includes('request')
      : !keys.includes('tradeId') || (cancelling && !keys.includes('recoveryId')))
  ) {
    throw new Error(`Garbled save: invalid ${label} fields`);
  }
  const owner = fields.owner;
  if (typeof owner !== 'object' || owner === null || Array.isArray(owner)) {
    throw new Error(`Garbled save: invalid ${label}.owner`);
  }
  const ownerFields = owner as Record<string, unknown>;
  if (
    Object.keys(ownerFields).length !== 3 ||
    !Object.hasOwn(ownerFields, 'installationPlayerId') ||
    !Object.hasOwn(ownerFields, 'peerSessionId') ||
    !Object.hasOwn(ownerFields, 'providerScope')
  ) {
    throw new Error(`Garbled save: invalid ${label}.owner fields`);
  }
  const purpose = fields.purpose;
  if (typeof purpose !== 'object' || purpose === null || Array.isArray(purpose)) {
    throw new Error(`Garbled save: invalid ${label}.purpose`);
  }
  const purposeFields = purpose as Record<string, unknown>;
  if (
    Object.keys(purposeFields).length !== 2 ||
    !Object.hasOwn(purposeFields, 'kind') ||
    !Object.hasOwn(purposeFields, 'operationId') ||
    (purposeFields.kind !== 'funding' && purposeFields.kind !== 'fee')
  ) {
    throw new Error(`Garbled save: invalid ${label}.purpose fields`);
  }
  if (
    fields.stage !== 'creating' &&
    fields.stage !== 'reserved' &&
    fields.stage !== 'retained-for-replay' &&
    fields.stage !== 'cancel-required' &&
    fields.stage !== 'cancelling'
  ) {
    throw new Error(`Garbled save: invalid ${label}.stage`);
  }
  const common: WalletReservationEntryBase = {
    owner: {
      installationPlayerId: requireBoundedString(
        ownerFields.installationPlayerId,
        `${label}.owner.installationPlayerId`,
        MAX_IDENTITY_LENGTH,
      ),
      peerSessionId: requireBoundedString(
        ownerFields.peerSessionId,
        `${label}.owner.peerSessionId`,
        MAX_IDENTITY_LENGTH,
      ),
      providerScope: decodeProviderScope(ownerFields.providerScope, `${label}.owner.providerScope`),
    },
    purpose: {
      kind: purposeFields.kind as WalletReservationPurpose['kind'],
      operationId: requireBoundedString(
        purposeFields.operationId,
        `${label}.purpose.operationId`,
        MAX_OPERATION_ID_LENGTH,
      ),
    },
    reason: requireBoundedString(
      fields.reason,
      `${label}.reason`,
      MAX_WALLET_RESERVATION_REASON_LENGTH,
      true,
    ),
  };
  if (fields.stage === 'creating') {
    if (fields.disposition !== 'active' && fields.disposition !== 'cancel-on-create') {
      throw new Error(`Garbled save: invalid ${label}.disposition`);
    }
    return {
      ...common,
      stage: 'creating',
      disposition: fields.disposition,
      recoveryId: requireBoundedString(
        fields.recoveryId,
        `${label}.recoveryId`,
        MAX_TRADE_ID_LENGTH,
      ),
      request: decodeOfferRequest(fields.request, `${label}.request`),
    };
  }
  if (fields.stage === 'cancelling') {
    return {
      ...common,
      stage: 'cancelling',
      tradeId: requireBoundedString(fields.tradeId, `${label}.tradeId`, MAX_TRADE_ID_LENGTH),
      recoveryId: requireBoundedString(
        fields.recoveryId,
        `${label}.recoveryId`,
        MAX_TRADE_ID_LENGTH,
      ),
    };
  }
  return {
    ...common,
    stage: fields.stage,
    tradeId: requireBoundedString(fields.tradeId, `${label}.tradeId`, MAX_TRADE_ID_LENGTH),
  };
}

export function decodeWalletReservationLedger(
  value: unknown,
  label = 'wallet reservation ledger',
): WalletReservationLedgerEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  const entryIds = new Set<string>();
  const operationStages = new Map<string, { creating: boolean; tradeCount: number }>();
  return value.map((entry, index) => {
    const decoded = decodeWalletReservationLedgerEntry(entry, `${label}[${index}]`);
    const entryId =
      decoded.stage === 'creating' ? `recovery:${decoded.recoveryId}` : `trade:${decoded.tradeId}`;
    if (entryIds.has(entryId)) {
      throw new Error(`Garbled save: duplicate ${label} entry ${entryId}`);
    }
    entryIds.add(entryId);
    const operation = walletReservationOperationKey(decoded.owner, decoded.purpose);
    const stages = operationStages.get(operation) ?? { creating: false, tradeCount: 0 };
    if (decoded.stage === 'creating') {
      if (stages.creating || stages.tradeCount > 0) {
        throw new Error(`Garbled save: contradictory ${label} operation ownership`);
      }
      stages.creating = true;
    } else {
      if (stages.creating) {
        throw new Error(`Garbled save: contradictory ${label} operation ownership`);
      }
      stages.tradeCount += 1;
    }
    operationStages.set(operation, stages);
    return decoded;
  });
}

export function encodeWalletReservationRecord(
  entries: WalletReservationLedgerEntry[],
): WalletReservationRecord {
  return {
    schema: WALLET_RESERVATION_RECORD_SCHEMA,
    version: WALLET_RESERVATION_RECORD_VERSION,
    entries: decodeWalletReservationLedger(entries),
  };
}

export function decodeWalletReservationRecord(value: unknown): WalletReservationRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Garbled wallet reservation record');
  }
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (
    keys.length !== 3 ||
    !Object.hasOwn(fields, 'schema') ||
    !Object.hasOwn(fields, 'version') ||
    !Object.hasOwn(fields, 'entries')
  ) {
    throw new Error('Garbled wallet reservation record fields');
  }
  if (fields.schema !== WALLET_RESERVATION_RECORD_SCHEMA) {
    throw new Error(`Garbled wallet reservation record schema: ${String(fields.schema)}`);
  }
  if (fields.version !== WALLET_RESERVATION_RECORD_VERSION) {
    throw new Error(`Garbled wallet reservation record version: ${String(fields.version)}`);
  }
  return {
    schema: WALLET_RESERVATION_RECORD_SCHEMA,
    version: WALLET_RESERVATION_RECORD_VERSION,
    entries: decodeWalletReservationLedger(fields.entries),
  };
}
