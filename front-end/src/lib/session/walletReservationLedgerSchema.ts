export interface WalletReservationOwner {
  installationPlayerId: string;
  peerSessionId: string;
}

export type WalletReservationPurpose =
  | { kind: 'funding'; operationId: string }
  | { kind: 'fee'; operationId: string };

export type WalletReservationStage =
  | 'creating'
  | 'reserved'
  | 'retained-for-replay'
  | 'cancel-required';

interface WalletReservationEntryBase {
  owner: WalletReservationOwner;
  purpose: WalletReservationPurpose;
  reason: string;
}

export type WalletReservationRecoveryEntry = WalletReservationEntryBase & {
  stage: 'creating';
  recoveryId: string;
};

export type WalletReservationTradeEntry = WalletReservationEntryBase & {
  stage: Exclude<WalletReservationStage, 'creating'>;
  tradeId: string;
};

export type WalletReservationLedgerEntry =
  | WalletReservationRecoveryEntry
  | WalletReservationTradeEntry;

export const WALLET_RESERVATION_RECORD_SCHEMA = 'chia-gaming-wallet-reservations' as const;
export const WALLET_RESERVATION_RECORD_VERSION = 3n;

export interface WalletReservationRecord {
  schema: typeof WALLET_RESERVATION_RECORD_SCHEMA;
  version: typeof WALLET_RESERVATION_RECORD_VERSION;
  entries: WalletReservationLedgerEntry[];
}

const MAX_TRADE_ID_LENGTH = 256;
const MAX_IDENTITY_LENGTH = 256;
const MAX_OPERATION_ID_LENGTH = 1024;
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
  return `${owner.installationPlayerId}\0${owner.peerSessionId}\0${purpose.kind}\0${purpose.operationId}`;
}

export function walletReservationOwnerKey(owner: WalletReservationOwner): string {
  return `${owner.installationPlayerId}\0${owner.peerSessionId}`;
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
  if (
    keys.length !== 5 ||
    !keys.includes('owner') ||
    !keys.includes('purpose') ||
    !keys.includes('stage') ||
    !keys.includes('reason') ||
    (creating ? !keys.includes('recoveryId') : !keys.includes('tradeId'))
  ) {
    throw new Error(`Garbled save: invalid ${label} fields`);
  }
  const owner = fields.owner;
  if (typeof owner !== 'object' || owner === null || Array.isArray(owner)) {
    throw new Error(`Garbled save: invalid ${label}.owner`);
  }
  const ownerFields = owner as Record<string, unknown>;
  if (
    Object.keys(ownerFields).length !== 2 ||
    !Object.hasOwn(ownerFields, 'installationPlayerId') ||
    !Object.hasOwn(ownerFields, 'peerSessionId')
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
    fields.stage !== 'cancel-required'
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
