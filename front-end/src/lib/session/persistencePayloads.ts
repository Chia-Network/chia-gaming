import type {
  ChannelStatus,
  ChannelStatusPayload,
  CoinOfInterestEntry,
} from '../../types/ChiaGaming';
import { CHANNEL_SEMANTIC_PHASES } from '../../types/ChiaGaming';
import type { LiveSessionSave, SessionPairingSave, SessionTransportSave } from './saveEnvelope';
import type { BetweenHandModeModel, GameTerminalModel } from './types';
import {
  parseDecimalString,
  parseDiscriminant,
  requireBigint,
  requireBoolean,
  requireExactKeys,
  requireRecord,
  requireString,
} from './persistencePrimitives';

const AMOUNT_KEYS = new Set(['Amount']);
export const CHANNEL_STATUS_KEYS = new Set([
  'state',
  'session_disposition',
  'advisory',
  'coin',
  'our_balance',
  'their_balance',
  'game_allocated',
  'have_potato',
  'zero_payout',
  'unroll_initiator',
  'semantic_phase',
  'state_number',
  'unrolling_state_number',
  'preempting_state_number',
]);
export const TERMINAL_COIN_KEYS = new Set(['label', 'id', 'game_id', 'game_coin_kind']);

export const CHANNEL_STATUSES: ReadonlySet<string> = new Set<ChannelStatus>([
  'Handshaking',
  'WaitingForHeightToOffer',
  'WaitingForHeightToAccept',
  'OurWalletMakingOffer',
  'OurWalletMakingOfferAcceptance',
  'OfferSent',
  'TransactionPending',
  'Active',
  'ShuttingDown',
  'ShutdownTransactionPending',
  'GoingOnChain',
  'Unrolling',
  'ResolvedClean',
  'ResolvedUnrolled',
  'ResolvedStale',
  'Failed',
]);

export const BETWEEN_HAND_MODES: ReadonlySet<string> = new Set<BetweenHandModeModel>([
  'decision',
  'compose-proposal',
  'review-incoming-proposal',
]);

const SESSION_DISPOSITIONS = new Set(['AwaitOutboundTerminal', 'Abandoned']);
const CHANNEL_SEMANTIC_PHASE_SET = new Set<string>(CHANNEL_SEMANTIC_PHASES);
export function validateTerminalFields(terminal: GameTerminalModel, label: string): void {
  const isNonEmpty = (value: string | null): boolean => value !== null && value.length > 0;
  const isAmount = (value: string | null): boolean => {
    if (value === null) return false;
    try {
      return parseDecimalString(value, label, 0n) >= 0n;
    } catch {
      return false;
    }
  };
  if (terminal.type === 'none') {
    if (
      terminal.outcome !== null ||
      terminal.label !== null ||
      terminal.myReward !== null ||
      terminal.rewardCoinHex !== null
    ) {
      throw new Error(`Garbled save: ${label} none terminal contains outcome data`);
    }
    return;
  }
  if (!isNonEmpty(terminal.label)) {
    throw new Error(`Garbled save: ${label} terminal is missing its label`);
  }
  if (terminal.rewardCoinHex !== null && terminal.rewardCoinHex.length === 0) {
    throw new Error(`Garbled save: ${label} has an empty reward coin id`);
  }
  if (terminal.type === 'settled' && !isAmount(terminal.myReward)) {
    throw new Error(`Garbled save: ${label} settled terminal has invalid reward`);
  }
  if (
    (terminal.type === 'insufficient-balance' || terminal.type === 'ended-cancelled') &&
    (terminal.myReward !== null || terminal.rewardCoinHex !== null)
  ) {
    throw new Error(`Garbled save: ${label} ${terminal.type} terminal contains reward data`);
  }
}

export function validatePairing(pairing: SessionPairingSave): void {
  if (!/^[0-9a-f]{32}$/.test(pairing.gameSessionId)) {
    throw new Error('Garbled save: invalid pairing.gameSessionId');
  }
  for (const [field, minimum] of [
    ['myContribution', 0n],
    ['theirContribution', 0n],
    ['perGameAmount', 0n],
    ['channelTimeout', 1n],
    ['unrollTimeout', 1n],
  ] as const) {
    const value = pairing[field];
    if (value !== undefined) parseDecimalString(value, field, minimum);
  }
}

export function validateTransport(
  transport: SessionTransportSave,
  label: 'transport' | 'live',
): void {
  const { messageNumber, remoteNumber } = transport;
  if (messageNumber < 1n || messageNumber > 0x1_0000_0000n) {
    throw new Error(`Garbled save: invalid ${label}.messageNumber`);
  }
  if (remoteNumber < 0n || remoteNumber > 0xffff_ffffn) {
    throw new Error(`Garbled save: invalid ${label}.remoteNumber`);
  }
  const messageIds = new Set<bigint>();
  transport.unackedMessages.forEach(({ msgno }) => {
    if (msgno < 1n || msgno >= messageNumber) {
      throw new Error(`Garbled save: invalid ${label}.unackedMessages msgno ${msgno}`);
    }
    if (messageIds.has(msgno)) {
      throw new Error(`Garbled save: duplicate ${label}.unackedMessages msgno ${msgno}`);
    }
    messageIds.add(msgno);
  });
  const terminalHandoff = transport.terminalHandoff;
  if (terminalHandoff !== null) {
    const { id, msgno, sent, acknowledged, message: commandMessage } = terminalHandoff;
    if (id.length === 0 || msgno < 1n || msgno >= messageNumber) {
      throw new Error(`Garbled save: invalid ${label}.terminalHandoff`);
    }
    if (acknowledged && !sent) {
      throw new Error(`Garbled save: acknowledged ${label}.terminalHandoff was never sent`);
    }
    const boundFrame = transport.unackedMessages.find((message) => message.msgno === msgno);
    if (acknowledged) {
      if (transport.unackedMessages.some((message) => message.msgno <= msgno)) {
        throw new Error(
          `Garbled save: acknowledged ${label}.terminalHandoff remains in the unacked window`,
        );
      }
    } else if (
      !boundFrame ||
      boundFrame.msg.length !== commandMessage.length ||
      !boundFrame.msg.every((byte, index) => byte === commandMessage[index])
    ) {
      throw new Error(
        `Garbled save: ${label}.terminalHandoff does not match its unacked reliable frame`,
      );
    }
  }
}

export function validateLive(live: LiveSessionSave['live']): void {
  validateTransport(live, 'live');
  if (!/^[0-9a-fA-F]{64}$/.test(live.rewardPuzzleHash)) {
    throw new Error('Garbled save: invalid live.rewardPuzzleHash');
  }
}

export function validateChannelStatus(value: unknown): ChannelStatusPayload | null {
  if (value === null) return null;
  const status = requireRecord(value, 'channelStatus');
  requireExactKeys(status, CHANNEL_STATUS_KEYS, 'channelStatus');
  for (const required of ['advisory', 'coin', 'our_balance', 'their_balance', 'game_allocated']) {
    if (!Object.hasOwn(status, required)) {
      throw new Error(`Garbled save: channelStatus is missing ${required}`);
    }
  }
  parseDiscriminant<ChannelStatus>(status.state, CHANNEL_STATUSES, 'channelStatus.state');
  if (
    status.session_disposition !== undefined &&
    status.session_disposition !== null &&
    (typeof status.session_disposition !== 'string' ||
      !SESSION_DISPOSITIONS.has(status.session_disposition))
  ) {
    throw new Error('Garbled save: invalid channelStatus.session_disposition');
  }
  if (status.advisory !== undefined && status.advisory !== null) {
    requireString(status.advisory, 'channelStatus.advisory', true);
  }
  if (status.coin !== undefined && status.coin !== null) {
    if (!(status.coin instanceof Uint8Array) || status.coin.length < 64) {
      throw new Error('Garbled save: invalid channelStatus.coin');
    }
  }
  for (const field of ['our_balance', 'their_balance', 'game_allocated'] as const) {
    const amount = status[field];
    if (amount === undefined || amount === null) continue;
    const raw = (() => {
      if (typeof amount !== 'object' || Array.isArray(amount) || amount === null) return amount;
      const record = requireRecord(amount, `channelStatus.${field}`);
      requireExactKeys(record, AMOUNT_KEYS, `channelStatus.${field}`);
      return record.Amount;
    })();
    if (typeof raw === 'bigint') requireBigint(raw, `channelStatus.${field}`);
    else parseDecimalString(raw, `channelStatus.${field}`, 0n);
  }
  for (const field of ['have_potato', 'zero_payout'] as const) {
    const flag = status[field];
    if (flag !== undefined && flag !== null) requireBoolean(flag, `channelStatus.${field}`);
  }
  if (
    status.unroll_initiator !== undefined &&
    status.unroll_initiator !== null &&
    status.unroll_initiator !== 'us' &&
    status.unroll_initiator !== 'opponent'
  ) {
    throw new Error('Garbled save: invalid channelStatus.unroll_initiator');
  }
  if (
    status.semantic_phase !== undefined &&
    status.semantic_phase !== null &&
    (typeof status.semantic_phase !== 'string' ||
      !CHANNEL_SEMANTIC_PHASE_SET.has(status.semantic_phase))
  ) {
    throw new Error('Garbled save: invalid channelStatus.semantic_phase');
  }
  for (const field of [
    'state_number',
    'unrolling_state_number',
    'preempting_state_number',
  ] as const) {
    const value = status[field];
    if (value === undefined || value === null) continue;
    requireBigint(value, `channelStatus.${field}`);
  }
  return status as unknown as ChannelStatusPayload;
}

export function decodeTerminalCoins(value: unknown): CoinOfInterestEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('Garbled save: terminal phase is missing coinsOfInterest');
  }
  const coinIds = new Set<string>();
  return value.map((coin, index) => {
    const record = requireRecord(coin, `terminal.coinsOfInterest[${index}]`);
    requireExactKeys(record, TERMINAL_COIN_KEYS, `terminal.coinsOfInterest[${index}]`);
    const label = requireString(record.label, `terminal.coinsOfInterest[${index}].label`);
    const id = requireString(record.id, `terminal.coinsOfInterest[${index}].id`);
    if (!label || !id) throw new Error(`Garbled save: invalid terminal coin ${index}`);
    const gameId =
      record.game_id === undefined
        ? undefined
        : requireString(record.game_id, `terminal.coinsOfInterest[${index}].game_id`);
    if (gameId === '') throw new Error(`Garbled save: invalid terminal coin game id ${index}`);
    const gameCoinKind = record.game_coin_kind;
    if (gameCoinKind !== undefined && gameCoinKind !== 'current' && gameCoinKind !== 'reward') {
      throw new Error(`Garbled save: invalid terminal coin kind ${index}`);
    }
    if (coinIds.has(id)) throw new Error(`Garbled save: duplicate terminal coin ${id}`);
    coinIds.add(id);
    return {
      label,
      id,
      ...(gameId === undefined ? {} : { game_id: gameId }),
      ...(gameCoinKind === undefined ? {} : { game_coin_kind: gameCoinKind }),
    };
  });
}
