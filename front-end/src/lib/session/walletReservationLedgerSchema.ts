import type { WalletOfferRequest, WalletProviderScope } from '../../types/ChiaGaming';

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
  recoveryId: string;
  request: WalletOfferRequest;
};

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
export const WALLET_RESERVATION_RECORD_VERSION = 4n;

export interface WalletReservationRecord {
  schema: typeof WALLET_RESERVATION_RECORD_SCHEMA;
  version: typeof WALLET_RESERVATION_RECORD_VERSION;
  entries: WalletReservationLedgerEntry[];
}

const MAX_TRADE_ID_LENGTH = 256;
const MAX_IDENTITY_LENGTH = 256;
const MAX_OPERATION_ID_LENGTH = 1024;
const MAX_CONDITION_COUNT = 64;
const MAX_CONDITION_ARGS = 64;
const MAX_CONDITION_ARG_LENGTH = 4096;
export const MAX_WALLET_RESERVATION_REASON_LENGTH = 256;

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
  return `${walletReservationOwnerKey(owner)}\0${purpose.kind}\0${purpose.operationId}`;
}

export function walletReservationOwnerKey(owner: WalletReservationOwner): string {
  return `${owner.installationPlayerId}\0${owner.peerSessionId}\0${walletProviderScopeKey(owner.providerScope)}`;
}

export function walletProviderScopeKey(scope: WalletProviderScope): string {
  switch (scope.provider) {
    case 'cloud':
      return `cloud\0${scope.walletId}`;
    case 'walletconnect':
      return `walletconnect\0${scope.fingerprint}\0${scope.remoteWalletId}`;
    case 'simulator':
      return `simulator\0${scope.identity}`;
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
      remoteWalletId: requireBoundedString(
        fields.remoteWalletId,
        `${label}.remoteWalletId`,
        MAX_IDENTITY_LENGTH,
      ),
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

function decodeOfferRequest(value: unknown, label: string): WalletOfferRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  const fields = value as Record<string, unknown>;
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
      concurrentSpendCoinId: requireBoundedString(
        fields.concurrentSpendCoinId,
        `${label}.concurrentSpendCoinId`,
        66,
      ),
    };
  }
  const allowed = new Set([
    'kind',
    'uniqueId',
    'offer',
    'extraConditions',
    'coinIds',
    'maxHeight',
    'openingFee',
  ]);
  if (
    fields.kind !== 'funding' ||
    Object.keys(fields).some((key) => !allowed.has(key)) ||
    typeof fields.offer !== 'object' ||
    fields.offer === null ||
    Array.isArray(fields.offer)
  ) {
    throw new Error(`Garbled save: invalid ${label} fields`);
  }
  const offer = fields.offer as Record<string, unknown>;
  if (
    Object.keys(offer).length !== 1 ||
    !Object.hasOwn(offer, '1') ||
    typeof offer['1'] !== 'bigint' ||
    offer['1'] >= 0n ||
    offer['1'] < -0xffff_ffff_ffff_ffffn
  ) {
    throw new Error(`Garbled save: invalid ${label}.offer`);
  }
  const extraConditions =
    fields.extraConditions === undefined
      ? undefined
      : decodeConditions(fields.extraConditions, `${label}.extraConditions`);
  const coinIds =
    fields.coinIds === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(fields.coinIds) || fields.coinIds.length > MAX_CONDITION_ARGS) {
            throw new Error(`Garbled save: invalid ${label}.coinIds`);
          }
          return fields.coinIds.map((coinId, index) =>
            requireBoundedString(coinId, `${label}.coinIds[${index}]`, 64),
          );
        })();
  return {
    kind: 'funding',
    uniqueId,
    offer: { '1': offer['1'] },
    ...(extraConditions === undefined ? {} : { extraConditions }),
    ...(coinIds === undefined ? {} : { coinIds }),
    ...(fields.maxHeight === undefined
      ? {}
      : { maxHeight: requireU64(fields.maxHeight, `${label}.maxHeight`) }),
    ...(fields.openingFee === undefined
      ? {}
      : { openingFee: requireU64(fields.openingFee, `${label}.openingFee`) }),
  };
}

function decodeConditions(
  value: unknown,
  label: string,
): Array<{ opcode: bigint; args: string[] }> {
  if (!Array.isArray(value) || value.length > MAX_CONDITION_COUNT) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value.map((condition, index) => {
    if (typeof condition !== 'object' || condition === null || Array.isArray(condition)) {
      throw new Error(`Garbled save: invalid ${label}[${index}]`);
    }
    const fields = condition as Record<string, unknown>;
    if (
      Object.keys(fields).length !== 2 ||
      typeof fields.opcode !== 'bigint' ||
      fields.opcode < 0n ||
      fields.opcode > 0xffff_ffffn ||
      !Array.isArray(fields.args) ||
      fields.args.length > MAX_CONDITION_ARGS
    ) {
      throw new Error(`Garbled save: invalid ${label}[${index}]`);
    }
    return {
      opcode: fields.opcode,
      args: fields.args.map((arg, argIndex) =>
        requireBoundedString(
          arg,
          `${label}[${index}].args[${argIndex}]`,
          MAX_CONDITION_ARG_LENGTH,
          true,
        ),
      ),
    };
  });
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
    keys.length !== (creating || cancelling ? 6 : 5) ||
    !keys.includes('owner') ||
    !keys.includes('purpose') ||
    !keys.includes('stage') ||
    !keys.includes('reason') ||
    (creating
      ? !keys.includes('recoveryId') || !keys.includes('request')
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
    return {
      ...common,
      stage: 'creating',
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
