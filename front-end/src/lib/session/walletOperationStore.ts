import type {
  WalletOfferOperation,
  WalletOfferRequest,
  WalletProviderScope,
} from '../../types/ChiaGaming';
import { decodeCanonicalFundingRequest, type CanonicalFundingRequest } from './fundingRequest';

export type WalletOperationOwner = WalletOfferOperation['owner'];
export type WalletOperationPurpose = WalletOfferOperation['purpose'];

export type WalletOperationStage =
  | 'creating'
  | 'best-effort-uncertain'
  | 'reserved'
  | 'retained-for-replay'
  | 'cancel-required'
  | 'best-effort-cancellation-uncertain'
  | 'cancelling';

interface WalletOperationEntryBase {
  owner: WalletOperationOwner;
  purpose: WalletOperationPurpose;
  reason: string;
  orphanRisk?: 'pre-id-response-lost';
}

export type WalletOperationRecoveryEntry = WalletOperationEntryBase & {
  stage: 'creating';
  disposition: 'active' | 'cancel-on-create';
  recoveryId: string;
  request: WalletOperationRecoveryRequest;
};

export type WalletBestEffortUncertainEntry = WalletOperationEntryBase & {
  stage: 'best-effort-uncertain';
  disposition: 'active' | 'cancel-on-create';
  request: WalletOperationRecoveryRequest;
  generation: bigint;
  lastAttemptEpoch: bigint;
};

export type WalletOperationRecoveryRequest =
  | { kind: 'funding'; canonical: CanonicalFundingRequest }
  | Extract<WalletOfferRequest, { kind: 'fee' }>;

export type WalletOperationTradeEntry = WalletOperationEntryBase & {
  stage: Exclude<
    WalletOperationStage,
    'creating' | 'best-effort-uncertain' | 'best-effort-cancellation-uncertain' | 'cancelling'
  >;
  tradeId: string;
};

export type WalletBestEffortCancellationUncertainEntry = WalletOperationEntryBase & {
  stage: 'best-effort-cancellation-uncertain';
  tradeId: string;
  generation: bigint;
  lastAttemptEpoch: bigint;
};

export type WalletOperationCancellationEntry = WalletOperationEntryBase & {
  stage: 'cancelling';
  tradeId: string;
  recoveryId: string;
};

export type WalletOperationEntry =
  | WalletOperationRecoveryEntry
  | WalletBestEffortUncertainEntry
  | WalletOperationTradeEntry
  | WalletBestEffortCancellationUncertainEntry
  | WalletOperationCancellationEntry;

export const WALLET_OPERATION_RECORD_SCHEMA = 'chia-gaming-wallet-operations' as const;
export const WALLET_OPERATION_RECORD_VERSION = 7n;

export interface WalletOperationRecord {
  schema: typeof WALLET_OPERATION_RECORD_SCHEMA;
  version: typeof WALLET_OPERATION_RECORD_VERSION;
  entries: WalletOperationEntry[];
}

const MAX_TRADE_ID_LENGTH = 256;
const MAX_IDENTITY_LENGTH = 256;
const MAX_OPERATION_ID_LENGTH = 1024;
export const MAX_WALLET_OPERATION_REASON_LENGTH = 256;

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

export function walletOperationKey(
  owner: WalletOperationOwner,
  purpose: WalletOperationPurpose,
): string {
  return tupleKey([walletOperationOwnerKey(owner), purpose.kind, purpose.operationId]);
}

export function walletOperationOwnerPrefix(owner: WalletOperationOwner): string {
  const ownerKey = walletOperationOwnerKey(owner);
  return `${ownerKey.length}:${ownerKey}`;
}

export function walletOperationOwnerKey(owner: WalletOperationOwner): string {
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
      providerScope: decodeProviderScope(ownerFields.providerScope, `${label}.owner.providerScope`),
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
  const operationStages = new Map<string, { creating: boolean; tradeCount: number }>();
  return value.map((entry, index) => {
    const decoded = decodeWalletOperationEntry(entry, `${label}[${index}]`);
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
    const stages = operationStages.get(operation) ?? { creating: false, tradeCount: 0 };
    if (decoded.stage === 'creating' || decoded.stage === 'best-effort-uncertain') {
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

export type WalletOperationTransition =
  | { kind: 'retire'; reason: string }
  | {
      kind: 'creation-pending';
      recoveryId: string;
      request: WalletOperationRecoveryRequest;
      reason: string;
      retired: boolean;
    }
  | {
      kind: 'creation-uncertain';
      request: WalletOperationRecoveryRequest;
      generation: bigint;
      readinessEpoch: bigint;
      reason: string;
      retired: boolean;
      orphanRisk?: 'pre-id-response-lost';
    }
  | {
      kind: 'uncertain-attempt-launched';
      readinessEpoch: bigint;
      reason: string;
      newRegistryGeneration?: boolean;
    }
  | { kind: 'creation-unavailable'; reason: string }
  | { kind: 'creation-rejected' }
  | { kind: 'creation-completed'; tradeId?: string; reason: string }
  | { kind: 'creation-recovery-identified'; recoveryId: string; reason: string }
  | { kind: 'reserve'; tradeId: string; reason: string }
  | { kind: 'stale-result'; tradeId: string; reason: string }
  | { kind: 'consume' }
  | { kind: 'retain-for-replay'; reason: string }
  | { kind: 'require-cancellation'; reason: string }
  | { kind: 'cancellation-pending'; recoveryId: string }
  | { kind: 'cancellation-uncertain'; readinessEpoch: bigint; reason: string }
  | {
      kind: 'uncertain-cancellation-attempt-launched';
      readinessEpoch: bigint;
      reason: string;
      newRegistryGeneration?: boolean;
    }
  | { kind: 'cancellation-recovery-identified'; recoveryId: string }
  | { kind: 'cancellation-unavailable'; reason: string }
  | { kind: 'cancellation-failed'; reason: string }
  | { kind: 'cancellation-completed' };

function operationReason(reason: string): string {
  return reason.slice(0, MAX_WALLET_OPERATION_REASON_LENGTH);
}

/**
 * Pure, exhaustive durable wallet-operation reducer. Runtime code may launch
 * RPCs and persistence, but it cannot manufacture a durable stage directly.
 */
export function reduceWalletOperation(
  current: WalletOperationEntry | null,
  owner: WalletOperationOwner,
  purpose: WalletOperationPurpose,
  transition: WalletOperationTransition,
): WalletOperationEntry | null {
  const common = { owner, purpose };
  const provenance = current?.orphanRisk ? { orphanRisk: current.orphanRisk } : {};
  switch (transition.kind) {
    case 'creation-pending':
      if (current !== null) throw new Error('Creation launch requires an empty operation');
      return {
        ...common,
        stage: 'creating',
        disposition: transition.retired ? 'cancel-on-create' : 'active',
        recoveryId: transition.recoveryId,
        request: structuredClone(transition.request),
        reason: operationReason(transition.reason),
      };
    case 'creation-uncertain':
      if (current !== null) throw new Error('Uncertain creation requires an empty operation');
      return {
        ...common,
        stage: 'best-effort-uncertain',
        disposition: transition.retired ? 'cancel-on-create' : 'active',
        request: structuredClone(transition.request),
        generation: transition.generation,
        lastAttemptEpoch: transition.readinessEpoch,
        reason: operationReason(transition.reason),
        ...(transition.orphanRisk ? { orphanRisk: transition.orphanRisk } : {}),
      };
    case 'uncertain-attempt-launched':
      if (current?.stage !== 'best-effort-uncertain') {
        throw new Error('Replacement launch requires best-effort uncertainty');
      }
      if (
        !transition.newRegistryGeneration &&
        transition.readinessEpoch <= current.lastAttemptEpoch
      ) {
        return current;
      }
      return {
        ...current,
        generation: current.generation + 1n,
        lastAttemptEpoch: transition.readinessEpoch,
        reason: operationReason(transition.reason),
      };
    case 'creation-unavailable':
      if (current?.stage !== 'creating' && current?.stage !== 'best-effort-uncertain') {
        return current;
      }
      return { ...current, reason: operationReason(transition.reason) };
    case 'creation-rejected':
      if (current?.stage !== 'creating' && current?.stage !== 'best-effort-uncertain') {
        throw new Error('Creation rejection requires an active creation');
      }
      return null;
    case 'creation-completed': {
      if (current?.stage !== 'creating' && current?.stage !== 'best-effort-uncertain') {
        if (current !== null) throw new Error('Creation completion requires an active creation');
        if (!transition.tradeId) return null;
        return {
          ...common,
          stage: 'reserved',
          tradeId: transition.tradeId,
          reason: operationReason(transition.reason),
        };
      }
      if (!transition.tradeId) return null;
      return {
        ...common,
        ...provenance,
        stage: current.disposition === 'cancel-on-create' ? 'cancel-required' : 'reserved',
        tradeId: transition.tradeId,
        reason: operationReason(transition.reason),
      };
    }
    case 'creation-recovery-identified':
      if (current?.stage !== 'best-effort-uncertain') {
        throw new Error('Creation recovery identification requires best-effort uncertainty');
      }
      return {
        ...common,
        ...provenance,
        stage: 'creating',
        disposition: current.disposition,
        recoveryId: transition.recoveryId,
        request: current.request,
        reason: operationReason(transition.reason),
      };
    case 'reserve':
      if (current !== null) throw new Error('Reservation requires an empty operation');
      return {
        ...common,
        stage: 'reserved',
        tradeId: transition.tradeId,
        reason: operationReason(transition.reason),
      };
    case 'stale-result':
      if (current !== null) {
        if (
          current.stage !== 'reserved' &&
          current.stage !== 'retained-for-replay' &&
          current.stage !== 'cancel-required' &&
          current.stage !== 'cancelling'
        ) {
          throw new Error('Stale result conflicts with an active creation');
        }
        if (current.tradeId !== transition.tradeId) {
          throw new Error('Stale result conflicts with another trade');
        }
      }
      return {
        ...common,
        ...provenance,
        stage: 'cancel-required',
        tradeId: transition.tradeId,
        reason: operationReason(transition.reason),
      };
    case 'consume':
      if (current === null) return null;
      if (
        current.stage === 'creating' ||
        current.stage === 'best-effort-uncertain' ||
        current.stage === 'best-effort-cancellation-uncertain'
      ) {
        throw new Error('Cannot consume an incomplete creation');
      }
      return null;
    case 'retain-for-replay':
      if (
        current?.stage !== 'reserved' &&
        current?.stage !== 'retained-for-replay' &&
        current?.stage !== 'cancel-required'
      ) {
        throw new Error('Replay retention requires a trade');
      }
      return {
        ...current,
        stage: 'retained-for-replay',
        reason: operationReason(transition.reason),
      };
    case 'retire':
      if (current === null || current.stage === 'retained-for-replay') return current;
      if (current.stage === 'creating' || current.stage === 'best-effort-uncertain') {
        return {
          ...current,
          disposition: 'cancel-on-create',
          reason: operationReason(transition.reason),
        };
      }
      if (current.stage === 'best-effort-cancellation-uncertain') {
        return { ...current, reason: operationReason(transition.reason) };
      }
      return {
        ...common,
        ...provenance,
        stage: 'cancel-required',
        tradeId: current.tradeId,
        reason: operationReason(transition.reason),
      };
    case 'require-cancellation':
      if (current === null) return null;
      if (current.stage === 'creating' || current.stage === 'best-effort-uncertain') {
        return {
          ...current,
          disposition: 'cancel-on-create',
          reason: operationReason(transition.reason),
        };
      }
      if (current.stage === 'best-effort-cancellation-uncertain') {
        return { ...current, reason: operationReason(transition.reason) };
      }
      return {
        ...common,
        ...provenance,
        stage: 'cancel-required',
        tradeId: current.tradeId,
        reason: operationReason(transition.reason),
      };
    case 'cancellation-pending':
      if (current?.stage !== 'cancel-required') {
        throw new Error('Pending cancellation requires cancel-required state');
      }
      return { ...current, stage: 'cancelling', recoveryId: transition.recoveryId };
    case 'cancellation-uncertain':
      if (current?.stage !== 'cancel-required') {
        throw new Error('Uncertain cancellation requires cancel-required state');
      }
      return {
        ...current,
        stage: 'best-effort-cancellation-uncertain',
        generation: 0n,
        lastAttemptEpoch: transition.readinessEpoch,
        reason: operationReason(transition.reason),
      };
    case 'uncertain-cancellation-attempt-launched':
      if (current?.stage !== 'best-effort-cancellation-uncertain') {
        throw new Error('Cancellation replacement requires best-effort uncertainty');
      }
      if (
        !transition.newRegistryGeneration &&
        transition.readinessEpoch <= current.lastAttemptEpoch
      ) {
        return current;
      }
      return {
        ...current,
        generation: current.generation + 1n,
        lastAttemptEpoch: transition.readinessEpoch,
        reason: operationReason(transition.reason),
      };
    case 'cancellation-recovery-identified':
      if (current?.stage !== 'best-effort-cancellation-uncertain') {
        throw new Error('Cancellation recovery identification requires best-effort uncertainty');
      }
      return { ...current, stage: 'cancelling', recoveryId: transition.recoveryId };
    case 'cancellation-unavailable':
      if (current?.stage !== 'best-effort-cancellation-uncertain') return current;
      return { ...current, reason: operationReason(transition.reason) };
    case 'cancellation-failed':
      if (
        current?.stage !== 'cancelling' &&
        current?.stage !== 'best-effort-cancellation-uncertain'
      ) {
        throw new Error('Cancellation failure requires cancelling state');
      }
      return {
        ...common,
        ...provenance,
        stage: 'cancel-required',
        tradeId: current.tradeId,
        reason: operationReason(transition.reason),
      };
    case 'cancellation-completed':
      if (
        current?.stage !== 'cancel-required' &&
        current?.stage !== 'best-effort-cancellation-uncertain' &&
        current?.stage !== 'cancelling'
      ) {
        throw new Error('Cancellation completion requires cancellation state');
      }
      return null;
  }
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
