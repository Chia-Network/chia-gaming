import type { WalletProviderScope } from '../../types/ChiaGaming';
import type { ProviderOwner } from './providerKeys';

const MAX_PROVIDER_IDENTITY_LENGTH = 256;

export function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

export function exactFields(
  fields: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(fields);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(fields, key))) {
    throw new Error(`Garbled save: invalid ${label} fields`);
  }
}

export function exactStageFields(
  fields: Record<string, unknown>,
  common: readonly string[],
  stages: Readonly<Record<string, readonly string[]>>,
  label: string,
): { orphanRisk?: 'pre-id-response-lost' } {
  const extras = stages[String(fields.stage)];
  if (!extras) throw new Error(`Garbled save: invalid ${label}.stage`);
  const hasRisk = Object.hasOwn(fields, 'orphanRisk');
  exactFields(fields, [...common, ...extras, ...(hasRisk ? ['orphanRisk'] : [])], label);
  if (!hasRisk) return {};
  if (fields.orphanRisk !== 'pre-id-response-lost') {
    throw new Error(`Garbled save: invalid ${label}.orphanRisk`);
  }
  return { orphanRisk: fields.orphanRisk };
}

export function boundedString(
  value: unknown,
  label: string,
  maximum = MAX_PROVIDER_IDENTITY_LENGTH,
  allowEmpty = false,
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximum) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value;
}

export function strictU64(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value;
}

export function decodeProviderScope(value: unknown, label: string): WalletProviderScope {
  const fields = strictRecord(value, label);
  if (fields.provider === 'cloud' && Object.keys(fields).length === 2) {
    return {
      provider: 'cloud',
      walletId: boundedString(fields.walletId, `${label}.walletId`),
    };
  }
  if (fields.provider === 'walletconnect' && Object.keys(fields).length === 3) {
    return {
      provider: 'walletconnect',
      fingerprint: boundedString(fields.fingerprint, `${label}.fingerprint`),
      chainId: boundedString(fields.chainId, `${label}.chainId`),
    };
  }
  if (fields.provider === 'simulator' && Object.keys(fields).length === 2) {
    return {
      provider: 'simulator',
      identity: boundedString(fields.identity, `${label}.identity`),
    };
  }
  throw new Error(`Garbled save: invalid ${label} fields`);
}

export function decodeProviderOwner(value: unknown, label: string): ProviderOwner {
  const fields = strictRecord(value, label);
  exactFields(fields, ['installationPlayerId', 'peerSessionId', 'providerScope'], label);
  return {
    installationPlayerId: boundedString(
      fields.installationPlayerId,
      `${label}.installationPlayerId`,
    ),
    peerSessionId: boundedString(fields.peerSessionId, `${label}.peerSessionId`),
    providerScope: decodeProviderScope(fields.providerScope, `${label}.providerScope`),
  };
}
