export const WALLET_OFFER_CLEANUP_SOURCES = [
  'funding-offer-stale',
  'funding-cradle-unavailable',
  'funding-offer-rejected',
  'fee-finalization-rejected',
  'fee-finalization-warning',
  'fee-network-rejected',
] as const;

export type WalletOfferCleanupSource = (typeof WALLET_OFFER_CLEANUP_SOURCES)[number];

export interface WalletOfferCleanupEntry {
  tradeId: string;
  source: WalletOfferCleanupSource;
}

const SOURCE_SET = new Set<string>(WALLET_OFFER_CLEANUP_SOURCES);
const MAX_TRADE_ID_LENGTH = 256;

export function decodeWalletOfferCleanupEntry(
  value: unknown,
  label = 'wallet offer cleanup entry',
): WalletOfferCleanupEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== 2 || !keys.includes('tradeId') || !keys.includes('source')) {
    throw new Error(`Garbled save: invalid ${label} fields`);
  }
  if (
    typeof fields.tradeId !== 'string' ||
    fields.tradeId.length === 0 ||
    fields.tradeId.length > MAX_TRADE_ID_LENGTH
  ) {
    throw new Error(`Garbled save: invalid ${label}.tradeId`);
  }
  if (typeof fields.source !== 'string' || !SOURCE_SET.has(fields.source)) {
    throw new Error(`Garbled save: invalid ${label}.source`);
  }
  return {
    tradeId: fields.tradeId,
    source: fields.source as WalletOfferCleanupSource,
  };
}

export function decodeWalletOfferCleanupEntries(
  value: unknown,
  label = 'wallet offer cleanup',
): WalletOfferCleanupEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  const tradeIds = new Set<string>();
  return value.map((entry, index) => {
    const decoded = decodeWalletOfferCleanupEntry(entry, `${label}[${index}]`);
    if (tradeIds.has(decoded.tradeId)) {
      throw new Error(`Garbled save: duplicate ${label} tradeId ${decoded.tradeId}`);
    }
    tradeIds.add(decoded.tradeId);
    return decoded;
  });
}
