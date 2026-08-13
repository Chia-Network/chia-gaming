import type { ChannelStatus } from '../../types/ChiaGaming';
import { CHANNEL_SEMANTIC_PHASES } from '../../types/ChiaGaming';
import { isSettlementOutcome, type SettlementOutcome } from '../settlement';
import type {
  LiveSessionSave,
  SessionPairingSave,
  SessionPresentationSave,
  SessionSave,
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
  requireNullableString,
  requireRecord,
  requireString,
} from './persistencePrimitives';

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
  'durability-error',
  'game-terminal',
  'proposal-rejected',
  'insufficient-bal',
]);
const SESSION_DISPOSITIONS = new Set(['AwaitOutboundTerminal', 'Abandoned']);
const CHANNEL_SEMANTIC_PHASE_SET = new Set<string>(CHANNEL_SEMANTIC_PHASES);
const OUTCOME_FLAGS = new Set(['win', 'lose', 'tie']);
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
  if (typeof id === 'number' && Number.isInteger(id) && id >= 0) return BigInt(id);
  if (typeof id === 'string') {
    try {
      return parseDecimalString(id, 'notification id', 0n);
    } catch {
      throw new Error(`Garbled save: invalid notification id: ${id}`);
    }
  }
  throw new Error('Garbled save: missing notification id');
}

export function parseQueuedNotifications(queue: unknown): QueuedNotificationModel[] {
  if (!Array.isArray(queue)) throw new Error('Garbled save: invalid notification queue');
  const parsed = queue.map((notification, index) => {
    const record = requireRecord(notification, `notification[${index}]`);
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
    save.preferences.blockchainType !== 'walletconnect'
  ) {
    throw new Error('Garbled save: invalid blockchainType');
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
  optionalString(pairing.gameSessionId, 'pairing.gameSessionId');
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

export function validateLive(live: LiveSessionSave['live']): void {
  if (!(live.serializedGameSession instanceof Uint8Array)) {
    throw new Error('Garbled save: invalid live.serializedGameSession');
  }
  requireBigint(live.gameSessionSchemaVersion, 'live.gameSessionSchemaVersion');
  requireBigint(live.messageNumber, 'live.messageNumber');
  requireBigint(live.remoteNumber, 'live.remoteNumber');
  requireString(live.rewardPuzzleHash, 'live.rewardPuzzleHash');
  if (!/^[0-9a-fA-F]{64}$/.test(live.rewardPuzzleHash)) {
    throw new Error('Garbled save: invalid live.rewardPuzzleHash');
  }
  optionalString(live.durabilityWarning, 'live.durabilityWarning', true);
  if (!Array.isArray(live.unackedMessages)) {
    throw new Error('Garbled save: invalid live.unackedMessages');
  }
  const messageIds = new Set<bigint>();
  live.unackedMessages.forEach((message, index) => {
    const record = requireRecord(message, `live.unackedMessages[${index}]`);
    const msgno = requireBigint(record.msgno, `live.unackedMessages[${index}].msgno`);
    if (messageIds.has(msgno)) {
      throw new Error(`Garbled save: duplicate live.unackedMessages msgno ${msgno}`);
    }
    messageIds.add(msgno);
    if (!(record.msg instanceof Uint8Array)) {
      throw new Error(`Garbled save: invalid live.unackedMessages[${index}].msg`);
    }
  });
}

export function validatePresentationScalarFields(save: SessionPresentationSave): void {
  if (save.waitingStateEnteredAt !== null) {
    requireBigint(save.waitingStateEnteredAt, 'waitingStateEnteredAt');
  }
  if (save.cleanShutdownGraceStartedAt !== null) {
    requireBigint(save.cleanShutdownGraceStartedAt, 'cleanShutdownGraceStartedAt');
  }
  if (
    save.currentHandOrigin !== null &&
    save.currentHandOrigin !== 'local' &&
    save.currentHandOrigin !== 'peer'
  ) {
    throw new Error('Garbled save: invalid currentHandOrigin');
  }
  requireBoolean(save.cleanShutdownStarted, 'cleanShutdownStarted');
  if (save.lastOutcomeWin !== null && !OUTCOME_FLAGS.has(save.lastOutcomeWin)) {
    throw new Error('Garbled save: invalid lastOutcomeWin');
  }
}

export function validateChannelStatus(value: unknown): void {
  if (value == null) return;
  const status = requireRecord(value, 'channelStatus');
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
    const raw =
      typeof amount === 'object' && !Array.isArray(amount) && amount !== null
        ? requireRecord(amount, `channelStatus.${field}`).Amount
        : amount;
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
    if (typeof value === 'bigint') {
      if (value < 0n) throw new Error(`Garbled save: invalid channelStatus.${field}`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`Garbled save: invalid channelStatus.${field}`);
    }
  }
}

export function validateTerminalCoins(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error('Garbled save: terminal phase is missing coinsOfInterest');
  }
  const coinIds = new Set<string>();
  value.forEach((coin, index) => {
    const record = requireRecord(coin, `terminal.coinsOfInterest[${index}]`);
    const label = requireString(record.label, `terminal.coinsOfInterest[${index}].label`);
    const id = requireString(record.id, `terminal.coinsOfInterest[${index}].id`);
    if (!label || !id) throw new Error(`Garbled save: invalid terminal coin ${index}`);
    if (coinIds.has(id)) throw new Error(`Garbled save: duplicate terminal coin ${id}`);
    coinIds.add(id);
  });
}
