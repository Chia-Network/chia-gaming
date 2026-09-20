export interface WalletReservationOwner {
  installationPlayerId: string;
  peerSessionId: string;
}

export type WalletReservationPurpose =
  | { kind: 'funding'; operationId: string }
  | { kind: 'fee'; operationId: string };

export type WalletReservationStage = 'reserved' | 'retained-for-replay' | 'cancel-required';

export interface WalletReservationLedgerEntry {
  tradeId: string;
  owner: WalletReservationOwner;
  purpose: WalletReservationPurpose;
  stage: WalletReservationStage;
  reason: string;
}

export const WALLET_RESERVATION_RECORD_SCHEMA = 'chia-gaming-wallet-reservations' as const;
export const WALLET_RESERVATION_RECORD_VERSION = 2n;

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
  if (
    keys.length !== 5 ||
    !keys.includes('tradeId') ||
    !keys.includes('owner') ||
    !keys.includes('purpose') ||
    !keys.includes('stage') ||
    !keys.includes('reason')
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
    fields.stage !== 'reserved' &&
    fields.stage !== 'retained-for-replay' &&
    fields.stage !== 'cancel-required'
  ) {
    throw new Error(`Garbled save: invalid ${label}.stage`);
  }
  return {
    tradeId: requireBoundedString(fields.tradeId, `${label}.tradeId`, MAX_TRADE_ID_LENGTH),
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
      kind: purposeFields.kind,
      operationId: requireBoundedString(
        purposeFields.operationId,
        `${label}.purpose.operationId`,
        MAX_OPERATION_ID_LENGTH,
      ),
    },
    stage: fields.stage,
    reason: requireBoundedString(
      fields.reason,
      `${label}.reason`,
      MAX_WALLET_RESERVATION_REASON_LENGTH,
      true,
    ),
  };
}

export function decodeWalletReservationLedger(
  value: unknown,
  label = 'wallet reservation ledger',
): WalletReservationLedgerEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  const tradeIds = new Set<string>();
  return value.map((entry, index) => {
    const decoded = decodeWalletReservationLedgerEntry(entry, `${label}[${index}]`);
    if (tradeIds.has(decoded.tradeId)) {
      throw new Error(`Garbled save: duplicate ${label} tradeId ${decoded.tradeId}`);
    }
    tradeIds.add(decoded.tradeId);
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
