import type { WalletProviderScope } from '../../types/ChiaGaming';
import { decodeCanonicalFundingRequest } from './fundingRequest';
import {
  MAX_WALLET_OPERATION_REASON_LENGTH,
  walletOperationKey,
  walletProviderScopeKey,
  type WalletOperationEntry,
  type WalletOperationEntryBase,
  type WalletOperationPurpose,
  type WalletOperationRecoveryRequest,
} from './walletOperationStore';

export const WALLET_OPERATION_RECORD_SCHEMA = 'chia-gaming-wallet-operations' as const;
export const WALLET_OPERATION_RECORD_VERSION = 8n;

export interface WalletOperationRecord {
  schema: typeof WALLET_OPERATION_RECORD_SCHEMA;
  version: typeof WALLET_OPERATION_RECORD_VERSION;
  entries: WalletOperationEntry[];
}

const MAX_TRADE_ID_LENGTH = 256;
const MAX_IDENTITY_LENGTH = 256;
const MAX_OPERATION_ID_LENGTH = 1024;

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

export function decodeWalletProviderScope(value: unknown, label: string): WalletProviderScope {
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

function decodeOfferRequest(value: unknown, label: string): WalletOperationRecoveryRequest {
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

export function decodeWalletOperationEntry(
  value: unknown,
  label = 'wallet operation entry',
): WalletOperationEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  const creating = fields.stage === 'creating';
  const uncertain = fields.stage === 'best-effort-uncertain';
  const cancellationUncertain = fields.stage === 'best-effort-cancellation-uncertain';
  const cancelling = fields.stage === 'cancelling';
  const hasOrphanRisk = Object.hasOwn(fields, 'orphanRisk');
  if (
    keys.length !==
      (creating ? 7 : uncertain ? 8 : cancellationUncertain ? 7 : cancelling ? 6 : 5) +
        (hasOrphanRisk ? 1 : 0) ||
    !keys.includes('owner') ||
    !keys.includes('purpose') ||
    !keys.includes('stage') ||
    !keys.includes('reason') ||
    (creating || uncertain
      ? !keys.includes('disposition') ||
        !keys.includes('request') ||
        (creating
          ? !keys.includes('recoveryId')
          : !keys.includes('generation') || !keys.includes('lastAttemptEpoch'))
      : !keys.includes('tradeId') ||
        (cancellationUncertain
          ? !keys.includes('generation') || !keys.includes('lastAttemptEpoch')
          : cancelling && !keys.includes('recoveryId')))
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
    fields.stage !== 'best-effort-uncertain' &&
    fields.stage !== 'reserved' &&
    fields.stage !== 'retained-for-replay' &&
    fields.stage !== 'cancel-required' &&
    fields.stage !== 'best-effort-cancellation-uncertain' &&
    fields.stage !== 'cancelling'
  ) {
    throw new Error(`Garbled save: invalid ${label}.stage`);
  }
  const common: WalletOperationEntryBase = {
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
      providerScope: decodeWalletProviderScope(
        ownerFields.providerScope,
        `${label}.owner.providerScope`,
      ),
    },
    purpose: {
      kind: purposeFields.kind as WalletOperationPurpose['kind'],
      operationId: requireBoundedString(
        purposeFields.operationId,
        `${label}.purpose.operationId`,
        MAX_OPERATION_ID_LENGTH,
      ),
    },
    reason: requireBoundedString(
      fields.reason,
      `${label}.reason`,
      MAX_WALLET_OPERATION_REASON_LENGTH,
      true,
    ),
    ...(hasOrphanRisk
      ? fields.orphanRisk === 'pre-id-response-lost'
        ? ({ orphanRisk: fields.orphanRisk } as const)
        : (() => {
            throw new Error(`Garbled save: invalid ${label}.orphanRisk`);
          })()
      : {}),
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
  if (fields.stage === 'best-effort-uncertain') {
    if (fields.disposition !== 'active' && fields.disposition !== 'cancel-on-create') {
      throw new Error(`Garbled save: invalid ${label}.disposition`);
    }
    return {
      ...common,
      stage: 'best-effort-uncertain',
      disposition: fields.disposition,
      request: decodeOfferRequest(fields.request, `${label}.request`),
      generation: requireU64(fields.generation, `${label}.generation`),
      lastAttemptEpoch: requireU64(fields.lastAttemptEpoch, `${label}.lastAttemptEpoch`),
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
  if (fields.stage === 'best-effort-cancellation-uncertain') {
    return {
      ...common,
      stage: 'best-effort-cancellation-uncertain',
      tradeId: requireBoundedString(fields.tradeId, `${label}.tradeId`, MAX_TRADE_ID_LENGTH),
      generation: requireU64(fields.generation, `${label}.generation`),
      lastAttemptEpoch: requireU64(fields.lastAttemptEpoch, `${label}.lastAttemptEpoch`),
    };
  }
  return {
    ...common,
    stage: fields.stage,
    tradeId: requireBoundedString(fields.tradeId, `${label}.tradeId`, MAX_TRADE_ID_LENGTH),
  };
}

export function decodeWalletOperationEntries(
  value: unknown,
  label = 'wallet operation record',
): WalletOperationEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  const entryIds = new Set<string>();
  const operationStages = new Map<
    string,
    { creating: boolean; cleanupCount: number; otherTradeCount: number }
  >();
  const sessionScopes = new Map<string, string>();
  return value.map((entry, index) => {
    const decoded = decodeWalletOperationEntry(entry, `${label}[${index}]`);
    const sessionKey = `${decoded.owner.installationPlayerId.length}:${decoded.owner.installationPlayerId}${decoded.owner.peerSessionId.length}:${decoded.owner.peerSessionId}`;
    const scopeKey = walletProviderScopeKey(decoded.owner.providerScope);
    const existingScope = sessionScopes.get(sessionKey);
    if (existingScope !== undefined && existingScope !== scopeKey) {
      throw new Error(`Garbled save: wallet operations for one session span provider scopes`);
    }
    sessionScopes.set(sessionKey, scopeKey);
    const entryId =
      decoded.stage === 'creating'
        ? `recovery:${decoded.recoveryId}`
        : decoded.stage === 'best-effort-uncertain'
          ? `uncertain:${walletOperationKey(decoded.owner, decoded.purpose)}`
          : `trade:${decoded.tradeId}`;
    if (entryIds.has(entryId)) {
      throw new Error(`Garbled save: duplicate ${label} entry ${entryId}`);
    }
    entryIds.add(entryId);
    const operation = walletOperationKey(decoded.owner, decoded.purpose);
    const stages = operationStages.get(operation) ?? {
      creating: false,
      cleanupCount: 0,
      otherTradeCount: 0,
    };
    if (decoded.stage === 'creating' || decoded.stage === 'best-effort-uncertain') {
      if (stages.creating || stages.otherTradeCount > 0) {
        throw new Error(`Garbled save: contradictory ${label} operation ownership`);
      }
      stages.creating = true;
    } else {
      const cleanup =
        decoded.stage === 'cancel-required' ||
        decoded.stage === 'best-effort-cancellation-uncertain' ||
        decoded.stage === 'cancelling';
      if (stages.creating && !cleanup) {
        throw new Error(`Garbled save: contradictory ${label} operation ownership`);
      }
      if (cleanup) stages.cleanupCount += 1;
      else stages.otherTradeCount += 1;
    }
    operationStages.set(operation, stages);
    return decoded;
  });
}

export function encodeWalletOperationRecord(
  entries: WalletOperationEntry[],
): WalletOperationRecord {
  return {
    schema: WALLET_OPERATION_RECORD_SCHEMA,
    version: WALLET_OPERATION_RECORD_VERSION,
    entries: decodeWalletOperationEntries(entries),
  };
}

export function decodeWalletOperationRecord(value: unknown): WalletOperationRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Garbled wallet operation record');
  }
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (
    keys.length !== 3 ||
    !Object.hasOwn(fields, 'schema') ||
    !Object.hasOwn(fields, 'version') ||
    !Object.hasOwn(fields, 'entries')
  ) {
    throw new Error('Garbled wallet operation record fields');
  }
  if (fields.schema !== WALLET_OPERATION_RECORD_SCHEMA) {
    throw new Error(`Garbled wallet operation record schema: ${String(fields.schema)}`);
  }
  if (fields.version !== WALLET_OPERATION_RECORD_VERSION) {
    throw new Error(`Garbled wallet operation record version: ${String(fields.version)}`);
  }
  return {
    schema: WALLET_OPERATION_RECORD_SCHEMA,
    version: WALLET_OPERATION_RECORD_VERSION,
    entries: decodeWalletOperationEntries(fields.entries),
  };
}
