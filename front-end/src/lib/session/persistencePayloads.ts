import type { ChannelStatus } from '../../types/ChiaGaming';
import { CHANNEL_SEMANTIC_PHASES } from '../../types/ChiaGaming';
import { isSettlementOutcome, type SettlementOutcome } from '../settlement';
import type {
  LiveSessionSave,
  SessionPairingSave,
  SessionSave,
  SessionTransportSave,
} from './saveEnvelope';
import type {
  BetweenHandModeModel,
  GameInstanceModel,
  GameProtocolPresentation,
  GameTerminalModel,
  GameTerminalType,
  QueuedNotificationModel,
} from './types';
import {
  optionalBoolean,
  optionalString,
  parseDecimalString,
  parseDiscriminant,
  parseStringArray,
  requireBigint,
  requireBoolean,
  requireExactKeys,
  requireNullableString,
  requireRecord,
  requireString,
} from './persistencePrimitives';

const NOTIFICATION_KEYS = new Set(['kind', 'id', 'title', 'message']);
const GAME_TERMINAL_KEYS = new Set(['type', 'outcome', 'label', 'myReward', 'rewardCoinHex']);
const GAME_INSTANCE_KEYS = new Set(['id', 'amount', 'coinHex', 'presentation', 'terminal']);
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

const NOTIFICATION_KINDS = new Set([
  'channel-state',
  'action-failed',
  'infra-error',
  'recoverable-internal-error',
  'durability-error',
  'proposal-rejected',
  'insufficient-bal',
  'move-rejected',
]);
const SESSION_DISPOSITIONS = new Set(['AwaitOutboundTerminal', 'Abandoned']);
const CHANNEL_SEMANTIC_PHASE_SET = new Set<string>(CHANNEL_SEMANTIC_PHASES);
const GAME_TERMINAL_TYPES: ReadonlySet<string> = new Set<GameTerminalType>([
  'none',
  'settled',
  'insufficient-balance',
  'ended-cancelled',
  'game-error',
]);
const SAVED_GAME_PRESENTATIONS: ReadonlySet<string> = new Set<GameProtocolPresentation>([
  'off-chain-my-turn',
  'off-chain-their-turn',
  'on-chain-my-turn',
  'on-chain-their-turn',
  'playing-move',
  'replaying-move',
  'illegal-move',
  'submitting-timeout',
  'finishing',
  'finishing-waiting-timeout',
  'finishing-spending',
  'ended',
]);

function parseNotificationId(id: unknown): bigint {
  if (typeof id === 'bigint' && id >= 0n) return id;
  throw new Error('Garbled save: missing notification id');
}

export function parseQueuedNotifications(queue: unknown): QueuedNotificationModel[] {
  if (!Array.isArray(queue)) throw new Error('Garbled save: invalid notification queue');
  const parsed = queue.map((notification, index) => {
    const record = requireRecord(notification, `notification[${index}]`);
    requireExactKeys(record, NOTIFICATION_KEYS, `notification[${index}]`);
    return {
      kind: parseDiscriminant<QueuedNotificationModel['kind']>(
        record.kind,
        NOTIFICATION_KINDS,
        `notification[${index}].kind`,
      ),
      id: parseNotificationId(record.id),
      title: requireString(record.title, `notification[${index}].title`, true),
      message: requireString(record.message, `notification[${index}].message`, true),
    };
  });
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) {
    throw new Error('Garbled save: duplicate notification id');
  }
  return parsed;
}

function parseGameTerminal(value: unknown, label: string): GameTerminalModel {
  const fields = requireRecord(value, label);
  requireExactKeys(fields, GAME_TERMINAL_KEYS, label);
  const type = parseDiscriminant<GameTerminalType>(
    fields.type,
    GAME_TERMINAL_TYPES,
    `${label}.type`,
  );
  let outcome: SettlementOutcome | null;
  if (type === 'settled') {
    if (!isSettlementOutcome(fields.outcome)) {
      throw new Error(`Garbled save: invalid ${label}.outcome: ${String(fields.outcome)}`);
    }
    outcome = fields.outcome;
  } else {
    const nonSettledOutcome = requireNullableString(fields.outcome, `${label}.outcome`, true);
    if (nonSettledOutcome !== null) {
      throw new Error(`Garbled save: unexpected ${label}.outcome for ${type}`);
    }
    outcome = null;
  }
  return {
    type,
    outcome,
    label: requireNullableString(fields.label, `${label}.label`, true),
    myReward: requireNullableString(fields.myReward, `${label}.myReward`, true),
    rewardCoinHex: requireNullableString(fields.rewardCoinHex, `${label}.rewardCoinHex`, true),
  };
}

export function parseSavedGameInstance(key: string, value: unknown): GameInstanceModel {
  const instance = requireRecord(value, `gameInstances.${key}`);
  requireExactKeys(instance, GAME_INSTANCE_KEYS, `gameInstances.${key}`);
  if (instance.id !== key) {
    throw new Error(`Garbled save: game instance ${key} has mismatched id ${String(instance.id)}`);
  }
  if (typeof instance.amount !== 'string') {
    throw new Error(`Garbled save: invalid gameInstances.${key}.amount`);
  }
  parseDecimalString(instance.amount, `gameInstances.${key}.amount`, 0n);
  if (instance.coinHex !== null && typeof instance.coinHex !== 'string') {
    throw new Error(`Garbled save: invalid gameInstances.${key}.coinHex`);
  }
  return {
    id: key,
    amount: instance.amount,
    coinHex: instance.coinHex,
    presentation: parseDiscriminant<GameProtocolPresentation>(
      instance.presentation,
      SAVED_GAME_PRESENTATIONS,
      `gameInstances.${key}.presentation`,
    ),
    terminal: parseGameTerminal(instance.terminal, `gameInstances.${key}.terminal`),
  };
}

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

export function validateCommonFields(save: SessionSave): void {
  requireString(save.identity.playerId, 'identity.playerId');
  optionalString(save.identity.sessionId, 'identity.sessionId');
  optionalString(save.identity.myHubPlayerId, 'identity.myHubPlayerId');
  optionalString(save.preferences.alias, 'preferences.alias', true);
  optionalString(save.preferences.hubUrl, 'preferences.hubUrl');
  optionalString(save.preferences.activeTab, 'preferences.activeTab');
  if (
    save.preferences.theme !== undefined &&
    save.preferences.theme !== 'dark' &&
    save.preferences.theme !== 'light'
  ) {
    throw new Error('Garbled save: invalid theme');
  }
  if (
    save.preferences.feeUnit !== undefined &&
    save.preferences.feeUnit !== 'mojo' &&
    save.preferences.feeUnit !== 'xch'
  ) {
    throw new Error('Garbled save: invalid feeUnit');
  }
  if (
    save.preferences.blockchainType !== undefined &&
    save.preferences.blockchainType !== 'simulator' &&
    save.preferences.blockchainType !== 'walletconnect' &&
    save.preferences.blockchainType !== 'cloud'
  ) {
    throw new Error('Garbled save: invalid blockchainType');
  }
  if (
    save.preferences.network !== undefined &&
    save.preferences.network !== 'mainnet' &&
    save.preferences.network !== 'testnet'
  ) {
    throw new Error('Garbled save: invalid network');
  }
  if (save.preferences.defaultFee !== undefined) {
    requireBigint(save.preferences.defaultFee, 'preferences.defaultFee');
  }
  optionalBoolean(save.preferences.unreadGame, 'preferences.unreadGame');
  optionalBoolean(save.preferences.walletAlert, 'preferences.walletAlert');
  optionalBoolean(save.preferences.hubAlert, 'preferences.hubAlert');
  for (const [field, value] of [
    ['history.humanHistory', save.history.humanHistory],
    ['history.wasmNotificationHistory', save.history.wasmNotificationHistory],
    ['history.diagnosticLog', save.history.diagnosticLog],
  ] as const) {
    if (value !== undefined) parseStringArray(value, field);
  }
}

export function validatePairing(pairing: SessionPairingSave): void {
  requireString(pairing.token, 'pairing.token');
  optionalString(pairing.peerId, 'pairing.peerId');
  requireString(pairing.gameSessionId, 'pairing.gameSessionId');
  if (!/^[0-9a-f]{32}$/.test(pairing.gameSessionId)) {
    throw new Error('Garbled save: invalid pairing.gameSessionId');
  }
  requireBoolean(pairing.iStarted, 'pairing.iStarted');
  optionalString(pairing.myAlias, 'pairing.myAlias', true);
  optionalString(pairing.opponentAlias, 'pairing.opponentAlias', true);
  requireString(pairing.myContribution, 'pairing.myContribution');
  requireString(pairing.theirContribution, 'pairing.theirContribution');
  requireString(pairing.perGameAmount, 'pairing.perGameAmount');
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
  const messageNumber = requireBigint(transport.messageNumber, `${label}.messageNumber`);
  const remoteNumber = requireBigint(transport.remoteNumber, `${label}.remoteNumber`);
  if (messageNumber < 1n || messageNumber > 0x1_0000_0000n) {
    throw new Error(`Garbled save: invalid ${label}.messageNumber`);
  }
  if (remoteNumber < 0n || remoteNumber > 0xffff_ffffn) {
    throw new Error(`Garbled save: invalid ${label}.remoteNumber`);
  }
  if (
    transport.disposition !== 'active' &&
    transport.disposition !== 'proposal-received' &&
    transport.disposition !== 'outbound-reject' &&
    transport.disposition !== 'inbound-reject'
  ) {
    throw new Error(`Garbled save: invalid ${label}.disposition`);
  }
  if (!Array.isArray(transport.unackedMessages)) {
    throw new Error(`Garbled save: invalid ${label}.unackedMessages`);
  }
  const messageIds = new Set<bigint>();
  transport.unackedMessages.forEach((message, index) => {
    const record = requireRecord(message, `${label}.unackedMessages[${index}]`);
    const msgno = requireBigint(record.msgno, `${label}.unackedMessages[${index}].msgno`);
    if (msgno < 1n || msgno >= messageNumber) {
      throw new Error(`Garbled save: invalid ${label}.unackedMessages msgno ${msgno}`);
    }
    if (messageIds.has(msgno)) {
      throw new Error(`Garbled save: duplicate ${label}.unackedMessages msgno ${msgno}`);
    }
    messageIds.add(msgno);
    if (!(record.msg instanceof Uint8Array)) {
      throw new Error(`Garbled save: invalid ${label}.unackedMessages[${index}].msg`);
    }
  });
  const terminalHandoff = transport.terminalHandoff;
  if (terminalHandoff !== null) {
    const record = requireRecord(terminalHandoff, `${label}.terminalHandoff`);
    const id = requireString(record.id, `${label}.terminalHandoff.id`);
    const msgno = requireBigint(record.msgno, `${label}.terminalHandoff.msgno`);
    const sent = requireBoolean(record.sent, `${label}.terminalHandoff.sent`);
    const acknowledged = requireBoolean(
      record.acknowledged,
      `${label}.terminalHandoff.acknowledged`,
    );
    if (id.length === 0 || msgno < 1n || msgno >= messageNumber) {
      throw new Error(`Garbled save: invalid ${label}.terminalHandoff`);
    }
    const commandMessage = record.message;
    if (!(commandMessage instanceof Uint8Array)) {
      throw new Error(`Garbled save: invalid ${label}.terminalHandoff.message`);
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
  if (!(live.serializedGameSession instanceof Uint8Array)) {
    throw new Error('Garbled save: invalid live.serializedGameSession');
  }
  requireBigint(live.gameSessionSchemaVersion, 'live.gameSessionSchemaVersion');
  requireString(live.rewardPuzzleHash, 'live.rewardPuzzleHash');
  if (!/^[0-9a-fA-F]{64}$/.test(live.rewardPuzzleHash)) {
    throw new Error('Garbled save: invalid live.rewardPuzzleHash');
  }
  optionalString(live.durabilityWarning, 'live.durabilityWarning', true);
  if (live.fundingOutbox !== undefined) {
    if (!Array.isArray(live.fundingOutbox)) {
      throw new Error('Garbled save: invalid live.fundingOutbox');
    }
    const fundingKeys = new Set<string>();
    for (const entry of live.fundingOutbox) {
      if (fundingKeys.has(entry.key)) {
        throw new Error(`Garbled save: duplicate live.fundingOutbox key ${entry.key}`);
      }
      if (fundingKeys.size > 0) {
        throw new Error('Garbled save: live.fundingOutbox contains more than one distinct request');
      }
      fundingKeys.add(entry.key);
    }
  }
}

export function validateChannelStatus(value: unknown): void {
  if (value == null) return;
  const status = requireRecord(value, 'channelStatus');
  requireExactKeys(status, CHANNEL_STATUS_KEYS, 'channelStatus');
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
}

export function validateTerminalCoins(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error('Garbled save: terminal phase is missing coinsOfInterest');
  }
  const coinIds = new Set<string>();
  value.forEach((coin, index) => {
    const record = requireRecord(coin, `terminal.coinsOfInterest[${index}]`);
    requireExactKeys(record, TERMINAL_COIN_KEYS, `terminal.coinsOfInterest[${index}]`);
    const label = requireString(record.label, `terminal.coinsOfInterest[${index}].label`);
    const id = requireString(record.id, `terminal.coinsOfInterest[${index}].id`);
    if (!label || !id) throw new Error(`Garbled save: invalid terminal coin ${index}`);
    if (record.parentId !== undefined) {
      throw new Error(`Garbled save: unexpected terminal coin parent ${index}`);
    }
    if (record.game_id !== undefined) {
      const gameId = requireString(record.game_id, `terminal.coinsOfInterest[${index}].game_id`);
      if (!gameId) throw new Error(`Garbled save: invalid terminal coin game id ${index}`);
    }
    if (
      record.game_coin_kind !== undefined &&
      record.game_coin_kind !== 'current' &&
      record.game_coin_kind !== 'reward'
    ) {
      throw new Error(`Garbled save: invalid terminal coin kind ${index}`);
    }
    if (coinIds.has(id)) throw new Error(`Garbled save: duplicate terminal coin ${id}`);
    coinIds.add(id);
  });
}
