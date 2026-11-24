import { decodeCanonicalFundingRequest } from './fundingRequest';
import {
  MAX_CHANNEL_FUNDING_REASON_LENGTH,
  channelFundingEntryKey,
  channelFundingKey,
  type ChannelFundingEntry,
  type ChannelFundingEntryBase,
  type ChannelFundingPurpose,
  type ChannelFundingRecoveryRequest,
} from './channelFundingStore';
import {
  boundedString,
  decodeProviderOwner,
  exactFields,
  exactStageFields,
  strictRecord,
  strictU64,
} from './providerValidation';

const MAX_RESERVATION_ID = 256;
const MAX_OPERATION_ID = 1024;

function decodeRequest(value: unknown, label: string): ChannelFundingRecoveryRequest {
  const fields = strictRecord(value, label);
  exactFields(fields, ['kind', 'canonical'], label);
  if (fields.kind !== 'funding') throw new Error(`Garbled save: invalid ${label}.kind`);
  return {
    kind: 'funding',
    canonical: decodeCanonicalFundingRequest(fields.canonical, `${label}.canonical`),
  };
}

export function decodeChannelFundingEntry(
  value: unknown,
  label = 'channel funding entry',
): ChannelFundingEntry {
  const fields = strictRecord(value, label);
  const commonKeys = ['owner', 'purpose', 'stage', 'reason'];
  const stageKeys: Record<string, string[]> = {
    creating: ['disposition', 'recoveryId', 'request'],
    'best-effort-uncertain': ['disposition', 'request', 'lastAttemptEpoch'],
    'awaiting-channel': [
      'providerReservationId',
      'request',
      ...(Object.hasOwn(fields, 'inputs') ? ['inputs'] : []),
    ],
    'cancel-required': ['providerReservationId'],
    'best-effort-cancellation-uncertain': ['providerReservationId', 'lastAttemptEpoch'],
    cancelling: ['providerReservationId', 'recoveryId'],
  };
  const orphanRisk = exactStageFields(fields, commonKeys, stageKeys, label);
  const purpose = strictRecord(fields.purpose, `${label}.purpose`);
  exactFields(purpose, ['kind', 'operationId'], `${label}.purpose`);
  if (purpose.kind !== 'funding') throw new Error(`Garbled save: invalid ${label}.purpose.kind`);
  const common: ChannelFundingEntryBase = {
    owner: decodeProviderOwner(fields.owner, `${label}.owner`),
    purpose: {
      kind: 'funding',
      operationId: boundedString(
        purpose.operationId,
        `${label}.purpose.operationId`,
        MAX_OPERATION_ID,
      ),
    },
    reason: boundedString(
      fields.reason,
      `${label}.reason`,
      MAX_CHANNEL_FUNDING_REASON_LENGTH,
      true,
    ),
    ...orphanRisk,
  };
  const reservation = (): string =>
    boundedString(
      fields.providerReservationId,
      `${label}.providerReservationId`,
      MAX_RESERVATION_ID,
    );
  const recovery = (): string =>
    boundedString(fields.recoveryId, `${label}.recoveryId`, MAX_RESERVATION_ID);
  switch (fields.stage) {
    case 'creating':
    case 'best-effort-uncertain': {
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
            recoveryId: recovery(),
          }
        : {
            ...common,
            stage: fields.stage,
            disposition: fields.disposition,
            request,
            lastAttemptEpoch: strictU64(fields.lastAttemptEpoch, `${label}.lastAttemptEpoch`),
          };
    }
    case 'awaiting-channel': {
      if (
        fields.inputs !== undefined &&
        (!Array.isArray(fields.inputs) || fields.inputs.length === 0)
      ) {
        throw new Error(`Garbled save: invalid ${label}.inputs`);
      }
      const request = decodeRequest(fields.request, `${label}.request`);
      if (fields.inputs !== undefined && !request.canonical.max_height) {
        throw new Error(`Garbled save: missing ${label}.request.canonical.max_height`);
      }
      return {
        ...common,
        stage: fields.stage,
        providerReservationId: reservation(),
        request,
        ...(fields.inputs === undefined
          ? {}
          : {
              inputs: fields.inputs.map((value: unknown, index: number) => {
                const input = strictRecord(value, `${label}.inputs[${index}]`);
                exactFields(input, ['coin_name', 'coin_string'], `${label}.inputs[${index}]`);
                if (
                  typeof input.coin_name !== 'string' ||
                  !/^[0-9a-f]{64}$/.test(input.coin_name) ||
                  typeof input.coin_string !== 'string' ||
                  !/^[0-9a-f]{128}(?:[0-9a-f]{2}){0,9}$/.test(input.coin_string)
                ) {
                  throw new Error(`Garbled save: invalid ${label}.inputs[${index}]`);
                }
                return { coin_name: input.coin_name, coin_string: input.coin_string };
              }),
            }),
      };
    }
    case 'cancelling':
      return {
        ...common,
        stage: fields.stage,
        providerReservationId: reservation(),
        recoveryId: recovery(),
      };
    case 'best-effort-cancellation-uncertain':
      return {
        ...common,
        stage: fields.stage,
        providerReservationId: reservation(),
        lastAttemptEpoch: strictU64(fields.lastAttemptEpoch, `${label}.lastAttemptEpoch`),
      };
    default:
      return { ...common, stage: 'cancel-required', providerReservationId: reservation() };
  }
}

export function decodeChannelFundingEntries(
  value: unknown,
  label = 'channel funding record',
  expectedPurpose?: ChannelFundingPurpose['kind'],
): ChannelFundingEntry[] {
  if (!Array.isArray(value)) throw new Error(`Garbled save: invalid ${label}`);
  const entryKeys = new Set<string>();
  const operations = new Map<
    string,
    { preId: boolean; cancellation: boolean; awaiting: boolean }
  >();
  return value.map((item, index) => {
    const entry = decodeChannelFundingEntry(item, `${label}[${index}]`);
    if (expectedPurpose && entry.purpose.kind !== expectedPurpose) {
      throw new Error(`Garbled save: invalid ${label}[${index}].purpose.kind`);
    }
    const entryKey = channelFundingEntryKey(entry);
    if (entryKeys.has(entryKey)) throw new Error(`Garbled save: duplicate ${label} entry`);
    entryKeys.add(entryKey);
    const operation = channelFundingKey(entry.owner, entry.purpose);
    const priorStages = operations.get(operation) ?? {
      preId: false,
      cancellation: false,
      awaiting: false,
    };
    const preId = entry.stage === 'creating' || entry.stage === 'best-effort-uncertain';
    const cancellation =
      entry.stage === 'cancel-required' ||
      entry.stage === 'cancelling' ||
      entry.stage === 'best-effort-cancellation-uncertain';
    const awaiting = entry.stage === 'awaiting-channel';
    if (
      (preId && (priorStages.preId || priorStages.awaiting)) ||
      (awaiting && (priorStages.preId || priorStages.awaiting)) ||
      (cancellation && priorStages.cancellation)
    ) {
      throw new Error(`Garbled save: contradictory ${label} operation`);
    }
    operations.set(operation, {
      preId: priorStages.preId || preId,
      cancellation: priorStages.cancellation || cancellation,
      awaiting: priorStages.awaiting || awaiting,
    });
    return entry;
  });
}
