import type { ChannelStatus } from '../../types/ChiaGaming';
import type { SessionSave } from '../../hooks/save';
import {
  decodePersistedGameState,
  decodePersistedGameTerms,
  gameHandMembershipDescription,
  isRegisteredGameType,
  validateGameHandMembership,
} from '../gameRegistry';
import { isSettlementOutcome, type SettlementOutcome } from '../settlement';
import {
  DIAGNOSTIC_LOG_LIMIT,
  HUMAN_HISTORY_LIMIT,
  recentEntries,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from './historyLimits';
import {
  channelStatusModelFromPayload,
  createSessionModel,
  DEFAULT_GAME_TIMEOUT_BLOCKS,
  INITIAL_CHANNEL_STATUS_MODEL,
  normalizeSessionPresentation,
} from './normalization';
import { createComposeDraftState, type ComposeDraftState } from './composeDraft';
import type {
  BetweenHandModeModel,
  BetweenHandProposalModel,
  GameInstanceModel,
  GameProtocolPresentation,
  GameTerminalModel,
  GameTerminalType,
  HandTermsModel,
  QueuedNotificationModel,
  SessionModel,
} from './types';
import { isTerminalChannelSnapshot } from './selectors';

export { snapshotFromSessionModel } from './sessionSnapshot';

export const SESSION_SAVE_ENVELOPE_VERSION = 11n;

type UnknownRecord = Record<string, unknown>;

const CHANNEL_STATUSES: ReadonlySet<string> = new Set<ChannelStatus>([
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
const BETWEEN_HAND_MODES: ReadonlySet<string> = new Set<BetweenHandModeModel>([
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
const CHANNEL_SEMANTIC_PHASES = new Set([
  'submitting_channel_spend',
  'resolving_opponent_channel_spend',
  'preempting',
  'waiting_timeout',
  'submitting_timeout_finish',
  'resolving',
]);
const OUTCOME_FLAGS = new Set(['win', 'lose', 'tie']);

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value as UnknownRecord;
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value;
}

function optionalString(value: unknown, label: string, allowEmpty = false): string | undefined {
  return value === undefined ? undefined : requireString(value, label, allowEmpty);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Garbled save: invalid ${label}`);
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  return value === undefined ? undefined : requireBoolean(value, label);
}

function requireBigint(value: unknown, label: string, minimum = 0n): bigint {
  if (typeof value !== 'bigint' || value < minimum) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return value;
}

function parseDecimalString(value: unknown, label: string, minimum?: bigint): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new Error(`Garbled save: invalid ${label}: ${String(value)}`);
  }
  const parsed = BigInt(value);
  if (minimum !== undefined && parsed < minimum) {
    throw new Error(`Garbled save: invalid ${label}: ${value}`);
  }
  return parsed;
}

function parseOptionalDecimalString(
  value: unknown,
  label: string,
  fallback: bigint,
  minimum?: bigint,
): bigint {
  return value === undefined ? fallback : parseDecimalString(value, label, minimum);
}

function requireBigintString(value: string | undefined, label: string): bigint {
  if (value === undefined) throw new Error(`Garbled save: missing ${label}`);
  return parseDecimalString(value, label);
}

export function sessionAmountsFromSave(
  save: Pick<SessionSave, 'myContribution' | 'theirContribution' | 'perGameAmount'>,
): { myContribution: bigint; theirContribution: bigint; perGameAmount: bigint } {
  const myContribution = requireBigintString(save.myContribution, 'myContribution');
  const theirContribution = requireBigintString(save.theirContribution, 'theirContribution');
  const perGameAmount = requireBigintString(save.perGameAmount, 'perGameAmount');
  return {
    myContribution,
    theirContribution,
    perGameAmount,
  };
}

type SavedHandTerms = {
  my_contribution: string;
  their_contribution: string;
  game_timeout?: string;
  game_type?: string;
  spacepoker_unit_size?: string;
};

type SavedProposal = SavedHandTerms & { id: string; groupIds: string[] };

function parseComposeDraftState(value: unknown, fallback: ComposeDraftState): ComposeDraftState {
  if (value === undefined) return fallback;
  const saved = requireRecord(value, 'betweenHandCompose');
  const selectedGame = saved.selected_game;
  if (!isRegisteredGameType(selectedGame)) {
    throw new Error('Garbled save: invalid betweenHandCompose.selected_game');
  }
  const calpoker = requireRecord(saved.calpoker, 'betweenHandCompose.calpoker');
  const krunk = requireRecord(saved.krunk, 'betweenHandCompose.krunk');
  const spacepoker = requireRecord(saved.spacepoker, 'betweenHandCompose.spacepoker');
  return {
    selectedGame,
    gameTimeout: parseDecimalString(saved.game_timeout, 'betweenHandCompose.game_timeout', 0n),
    proposalSent: requireBoolean(saved.proposal_sent, 'betweenHandCompose.proposal_sent'),
    calpoker: {
      amount: parseDecimalString(calpoker.amount, 'betweenHandCompose.calpoker.amount', 0n),
    },
    krunk: {
      amount: parseDecimalString(krunk.amount, 'betweenHandCompose.krunk.amount', 0n),
    },
    spacepoker: {
      unitSize: parseDecimalString(
        spacepoker.unit_size,
        'betweenHandCompose.spacepoker.unit_size',
        0n,
      ),
      stackSize: parseDecimalString(
        spacepoker.stack_size,
        'betweenHandCompose.spacepoker.stack_size',
        0n,
      ),
    },
  };
}

function parseTermsSnapshot(
  value: unknown,
  fallback: HandTermsModel,
  label: string,
): HandTermsModel {
  if (value == null) return fallback;
  const saved = requireRecord(value, label) as SavedHandTerms;
  const gameType = saved.game_type ?? fallback.gameType;
  if (!isRegisteredGameType(gameType)) {
    throw new Error(`Garbled save: unknown ${label}.game_type ${String(gameType)}`);
  }
  const myContribution = parseDecimalString(saved.my_contribution, `${label}.my_contribution`, 0n);
  const terms = decodePersistedGameTerms(
    gameType,
    {
      myContribution,
      theirContribution: parseDecimalString(
        saved.their_contribution,
        `${label}.their_contribution`,
        0n,
      ),
      gameTimeout: parseOptionalDecimalString(
        saved.game_timeout,
        `${label}.game_timeout`,
        fallback.gameTimeout,
        1n,
      ),
    },
    { spacepoker_unit_size: saved.spacepoker_unit_size },
  );
  if (!terms) throw new Error(`Garbled save: invalid ${label} ${gameType} terms`);
  return terms;
}

function parseOptionalTermsSnapshot(
  saved: unknown,
  fallback: HandTermsModel,
  label: string,
): HandTermsModel | null {
  return saved == null ? null : parseTermsSnapshot(saved, fallback, label);
}

function parseProposalSnapshot(
  value: unknown,
  fallbackTerms: HandTermsModel,
  label: string,
): BetweenHandProposalModel | null {
  if (value == null) return null;
  const saved = requireRecord(value, label) as SavedProposal;
  const id = requireString(saved.id, `${label}.id`);
  const groupIds = requireUniqueIds(saved.groupIds, `${label}.groupIds`, true);
  if (!groupIds.includes(id)) {
    throw new Error(`Garbled save: ${label}.id is not in its groupIds`);
  }
  return {
    id,
    groupIds,
    terms: parseTermsSnapshot(saved, fallbackTerms, label),
  };
}

function parseNotificationId(id: unknown): bigint {
  if (typeof id === 'bigint' && id >= 0n) return id;
  if (typeof id === 'number' && Number.isInteger(id) && id >= 0) return BigInt(id);
  if (typeof id === 'string') {
    try {
      const parsed = parseDecimalString(id, 'notification id', 0n);
      return parsed;
    } catch {
      throw new Error(`Garbled save: invalid notification id: ${id}`);
    }
  }
  throw new Error(`Garbled save: missing notification id`);
}

function parseQueuedNotifications(queue: unknown): QueuedNotificationModel[] {
  if (queue === undefined) return [];
  if (!Array.isArray(queue)) throw new Error('Garbled save: invalid notification queue');
  const parsed = queue.map((notification, index) => {
    const n = requireRecord(notification, `notification[${index}]`);
    const kind = parseDiscriminant<QueuedNotificationModel['kind']>(
      n.kind,
      NOTIFICATION_KINDS,
      `notification[${index}].kind`,
    );
    return {
      kind,
      id: parseNotificationId(n.id),
      title: requireString(n.title, `notification[${index}].title`, true),
      message: requireString(n.message, `notification[${index}].message`, true),
    };
  });
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) {
    throw new Error('Garbled save: duplicate notification id');
  }
  return parsed;
}

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
  'ended',
]);

function parseDiscriminant<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`Garbled save: invalid ${label}: ${String(value)}`);
  }
  return value as T;
}

function parseGameTerminal(value: unknown, label: string): GameTerminalModel {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  const fields = value as {
    type?: unknown;
    outcome?: unknown;
    label?: unknown;
    myReward?: unknown;
    rewardCoinHex?: unknown;
  };
  const type = parseDiscriminant<GameTerminalType>(
    fields.type,
    GAME_TERMINAL_TYPES,
    `${label}.type`,
  );
  let outcome: SettlementOutcome | null = null;
  if (type === 'settled') {
    if (!isSettlementOutcome(fields.outcome)) {
      throw new Error(`Garbled save: invalid ${label}.outcome: ${String(fields.outcome)}`);
    }
    outcome = fields.outcome;
  } else if (fields.outcome != null) {
    throw new Error(`Garbled save: unexpected ${label}.outcome for ${type}`);
  }
  const nullableString = (field: unknown, fieldLabel: string): string | null => {
    if (field == null) return null;
    if (typeof field !== 'string') {
      throw new Error(`Garbled save: invalid ${fieldLabel}: ${String(field)}`);
    }
    return field;
  };
  return {
    type,
    outcome,
    label: nullableString(fields.label, `${label}.label`),
    myReward: nullableString(fields.myReward, `${label}.myReward`),
    rewardCoinHex: nullableString(fields.rewardCoinHex, `${label}.rewardCoinHex`),
  };
}

function parseSavedGameInstance(
  key: string,
  instance: NonNullable<SessionSave['gameInstances']>[string],
): GameInstanceModel {
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
  const presentation = parseDiscriminant<GameProtocolPresentation>(
    instance.presentation,
    SAVED_GAME_PRESENTATIONS,
    `gameInstances.${key}.presentation`,
  );
  return {
    id: key,
    amount: instance.amount,
    coinHex: instance.coinHex,
    presentation,
    terminal: parseGameTerminal(instance.terminal, `gameInstances.${key}.terminal`),
  };
}

function requireUniqueIds(value: unknown, label: string, requireNonEmpty = false): string[] {
  if (
    !Array.isArray(value) ||
    (requireNonEmpty && value.length === 0) ||
    !value.every((id) => typeof id === 'string' && id.length > 0)
  ) {
    throw new Error(`Garbled save: ${label} must contain non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`Garbled save: duplicate ${label}`);
  }
  return value;
}

function validateTerminalFields(terminal: GameTerminalModel, label: string): void {
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

function parseStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`Garbled save: invalid ${label}`);
  }
  return [...value];
}

function parseProposalGroups(value: unknown, label: string): string[][] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Garbled save: invalid ${label}`);
  const seen = new Set<string>();
  return value.map((group, index) => {
    const ids = requireUniqueIds(group, `${label}[${index}]`, true);
    for (const id of ids) {
      if (seen.has(id)) throw new Error(`Garbled save: duplicate ${label} id ${id}`);
      seen.add(id);
    }
    return ids;
  });
}

function validateOptionalScalarFields(save: SessionSave): void {
  optionalString(save.sessionId, 'sessionId');
  optionalString(save.alias, 'alias', true);
  optionalString(save.hubUrl, 'hubUrl');
  optionalString(save.activeTab, 'activeTab');
  optionalString(save.pairingToken, 'pairingToken');
  optionalString(save.sessionPeerId, 'sessionPeerId');
  optionalString(save.myHubPlayerId, 'myHubPlayerId');
  optionalString(save.gameSessionId, 'gameSessionId');
  optionalString(save.myAlias, 'myAlias', true);
  optionalString(save.opponentAlias, 'opponentAlias', true);
  optionalString(save.durabilityWarning, 'durabilityWarning', true);
  if (save.theme !== undefined && save.theme !== 'dark' && save.theme !== 'light') {
    throw new Error('Garbled save: invalid theme');
  }
  if (save.feeUnit !== undefined && save.feeUnit !== 'mojo' && save.feeUnit !== 'xch') {
    throw new Error('Garbled save: invalid feeUnit');
  }
  if (
    save.blockchainType !== undefined &&
    save.blockchainType !== 'simulator' &&
    save.blockchainType !== 'walletconnect'
  ) {
    throw new Error('Garbled save: invalid blockchainType');
  }
  if (save.defaultFee !== undefined) requireBigint(save.defaultFee, 'defaultFee');
  if (save.gameSessionSchemaVersion !== undefined) {
    requireBigint(save.gameSessionSchemaVersion, 'gameSessionSchemaVersion');
  }
  if (save.messageNumber !== undefined) requireBigint(save.messageNumber, 'messageNumber');
  if (save.remoteNumber !== undefined) requireBigint(save.remoteNumber, 'remoteNumber');
  if (save.waitingStateEnteredAt !== undefined) {
    requireBigint(save.waitingStateEnteredAt, 'waitingStateEnteredAt');
  }
  if (save.cleanShutdownGraceStartedAt !== undefined) {
    requireBigint(save.cleanShutdownGraceStartedAt, 'cleanShutdownGraceStartedAt');
  }
  optionalBoolean(save.unreadGame, 'unreadGame');
  optionalBoolean(save.walletAlert, 'walletAlert');
  optionalBoolean(save.hubAlert, 'hubAlert');
  optionalBoolean(save.iStarted, 'iStarted');
  optionalBoolean(save.terminalIStarted, 'terminalIStarted');
  optionalBoolean(save.iProposedHand, 'iProposedHand');
  optionalBoolean(save.cleanShutdownStarted, 'cleanShutdownStarted');

  if (
    save.rewardPuzzleHash !== null &&
    save.rewardPuzzleHash !== undefined &&
    (typeof save.rewardPuzzleHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(save.rewardPuzzleHash))
  ) {
    throw new Error('Garbled save: invalid rewardPuzzleHash');
  }
  if (
    save.serializedGameSession !== undefined &&
    !(save.serializedGameSession instanceof Uint8Array)
  ) {
    throw new Error('Garbled save: invalid serializedGameSession');
  }
  for (const [field, minimum] of [
    ['myContribution', 0n],
    ['theirContribution', 0n],
    ['perGameAmount', 0n],
    ['channelTimeout', 1n],
    ['unrollTimeout', 1n],
  ] as const) {
    const value = save[field];
    if (value !== undefined) parseDecimalString(value, field, minimum);
  }
  if (save.lastOutcomeWin !== undefined && !OUTCOME_FLAGS.has(save.lastOutcomeWin)) {
    throw new Error('Garbled save: invalid lastOutcomeWin');
  }
  for (const [field, value] of [
    ['humanHistory', save.humanHistory],
    ['wasmNotificationHistory', save.wasmNotificationHistory],
    ['diagnosticLog', save.diagnosticLog],
  ] as const) {
    if (value !== undefined) parseStringArray(value, field);
  }

  if (save.unackedMessages !== undefined) {
    if (!Array.isArray(save.unackedMessages)) {
      throw new Error('Garbled save: invalid unackedMessages');
    }
    const messageIds = new Set<bigint>();
    save.unackedMessages.forEach((message, index) => {
      const record = requireRecord(message, `unackedMessages[${index}]`);
      const msgno = requireBigint(record.msgno, `unackedMessages[${index}].msgno`);
      if (messageIds.has(msgno)) {
        throw new Error(`Garbled save: duplicate unackedMessages msgno ${msgno}`);
      }
      messageIds.add(msgno);
      if (!(record.msg instanceof Uint8Array)) {
        throw new Error(`Garbled save: invalid unackedMessages[${index}].msg`);
      }
    });
  }
  if (save.moveReplayJournal !== undefined) {
    if (!Array.isArray(save.moveReplayJournal) || save.moveReplayJournal.length > 256) {
      throw new Error('Garbled save: invalid moveReplayJournal');
    }
    const keys = new Set<string>();
    save.moveReplayJournal.forEach((entry, index) => {
      const record = requireRecord(entry, `moveReplayJournal[${index}]`);
      const gameId = requireString(record.gameId, `moveReplayJournal[${index}].gameId`);
      const stateNumber =
        typeof record.stateNumber === 'bigint'
          ? record.stateNumber
          : typeof record.stateNumber === 'number' && Number.isSafeInteger(record.stateNumber)
            ? BigInt(record.stateNumber)
            : null;
      if (stateNumber === null || stateNumber < 0n) {
        throw new Error(`Garbled save: invalid moveReplayJournal[${index}].stateNumber`);
      }
      const key = `${gameId}:${stateNumber}`;
      if (keys.has(key)) {
        throw new Error(`Garbled save: duplicate moveReplayJournal key ${key}`);
      }
      keys.add(key);
      if (!(record.readable instanceof Uint8Array)) {
        throw new Error(`Garbled save: invalid moveReplayJournal[${index}].readable`);
      }
      if (typeof record.entropy !== 'string' || !/^[0-9a-fA-F]{64}$/.test(record.entropy)) {
        throw new Error(`Garbled save: invalid moveReplayJournal[${index}].entropy`);
      }
    });
  }
}

function validateChannelStatus(value: unknown): void {
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
      !CHANNEL_SEMANTIC_PHASES.has(status.semantic_phase))
  ) {
    throw new Error('Garbled save: invalid channelStatus.semantic_phase');
  }
}

export interface ParsedSessionSaveV11 {
  model: SessionModel;
  kind: 'preferences' | 'pre-handshake' | 'live-resumable' | 'terminal-frozen';
}

type SessionSaveField = keyof SessionSave;

const LIVE_TRANSPORT_FIELDS: readonly SessionSaveField[] = [
  'serializedGameSession',
  'gameSessionSchemaVersion',
  'messageNumber',
  'remoteNumber',
  'unackedMessages',
];
const SESSION_PROTOCOL_FIELDS: readonly SessionSaveField[] = [
  'pairingToken',
  'sessionPeerId',
  'gameSessionId',
  'iStarted',
  'myContribution',
  'theirContribution',
  'perGameAmount',
  'channelTimeout',
  'unrollTimeout',
];
const CHANNEL_PAYLOAD_FIELDS: readonly SessionSaveField[] = [
  'channelStatus',
  'dismissedChannelStatus',
  'cleanShutdownStarted',
  'waitingStateEnteredAt',
  'cleanShutdownGraceStartedAt',
];
const GAME_PAYLOAD_FIELDS: readonly SessionSaveField[] = [
  'activeGameIds',
  'moveReplayJournal',
  'currentHandGameIds',
  'lastDisplayedGameId',
  'gameInstances',
  'iProposedHand',
  'activeGameType',
  'handState',
  'lastOutcomeWin',
  'myRunningBalance',
  'channelNotifQueue',
  'gameNotifQueue',
  'betweenHandMode',
  'betweenHandCompose',
  'betweenHandLastTerms',
  'betweenHandRejectedOnceTerms',
  'betweenHandPendingRetryTerms',
  'betweenHandCachedPeerProposal',
  'betweenHandReviewPeerProposal',
  'outgoingProposalGroupIds',
  'acceptedProposalGroupIds',
  'outgoingProposalTerms',
];
const TERMINAL_ONLY_FIELDS: readonly SessionSaveField[] = ['terminalIStarted', 'coinsOfInterest'];

function rejectPresentFields(
  save: SessionSave,
  kind: ParsedSessionSaveV11['kind'],
  fields: readonly SessionSaveField[],
): void {
  for (const field of fields) {
    if (save[field] !== undefined) {
      throw new Error(`Garbled save: ${field} is not allowed for ${kind}`);
    }
  }
}

function validatePhasePayloadMatrix(save: SessionSave, kind: ParsedSessionSaveV11['kind']): void {
  if (kind === 'preferences') {
    rejectPresentFields(save, kind, [
      ...LIVE_TRANSPORT_FIELDS,
      ...SESSION_PROTOCOL_FIELDS,
      ...CHANNEL_PAYLOAD_FIELDS,
      ...GAME_PAYLOAD_FIELDS,
      ...TERMINAL_ONLY_FIELDS,
    ]);
    if (save.rewardPuzzleHash !== null && save.rewardPuzzleHash !== undefined) {
      throw new Error('Garbled save: rewardPuzzleHash is not allowed for preferences');
    }
    return;
  }
  if (kind === 'pre-handshake') {
    rejectPresentFields(save, kind, [
      ...LIVE_TRANSPORT_FIELDS,
      ...CHANNEL_PAYLOAD_FIELDS,
      ...GAME_PAYLOAD_FIELDS,
      ...TERMINAL_ONLY_FIELDS,
    ]);
    if (save.rewardPuzzleHash !== null && save.rewardPuzzleHash !== undefined) {
      throw new Error('Garbled save: rewardPuzzleHash is not allowed for pre-handshake');
    }
    return;
  }
  if (kind === 'live-resumable') {
    rejectPresentFields(save, kind, TERMINAL_ONLY_FIELDS);
    return;
  }
  rejectPresentFields(save, kind, [...LIVE_TRANSPORT_FIELDS, ...SESSION_PROTOCOL_FIELDS]);
}

function requireSessionAmounts(save: SessionSave): void {
  for (const field of ['myContribution', 'theirContribution', 'perGameAmount'] as const) {
    if (save[field] === undefined) {
      throw new Error(`Garbled save: missing ${field}`);
    }
    parseDecimalString(save[field], field, 0n);
  }
}

function classifySessionSave(save: SessionSave): ParsedSessionSaveV11['kind'] {
  const terminal = isTerminalChannelSnapshot(save.channelStatus);
  if (terminal) {
    return 'terminal-frozen';
  }
  if (save.serializedGameSession !== undefined) {
    requireBigint(save.gameSessionSchemaVersion, 'gameSessionSchemaVersion');
    requireBigint(save.messageNumber, 'messageNumber');
    requireBigint(save.remoteNumber, 'remoteNumber');
    requireBoolean(save.iStarted, 'iStarted');
    requireString(save.pairingToken, 'pairingToken');
    requireSessionAmounts(save);
    if (!Array.isArray(save.unackedMessages)) {
      throw new Error('Garbled save: missing unackedMessages');
    }
    if (!Array.isArray(save.activeGameIds)) {
      throw new Error('Garbled save: missing activeGameIds');
    }
    if (typeof save.rewardPuzzleHash !== 'string') {
      throw new Error('Garbled save: missing rewardPuzzleHash');
    }
    return 'live-resumable';
  }
  if (save.pairingToken !== undefined) {
    requireString(save.pairingToken, 'pairingToken');
    requireBoolean(save.iStarted, 'iStarted');
    requireSessionAmounts(save);
    return 'pre-handshake';
  }
  return 'preferences';
}

export function decodeSessionSaveEnvelope(
  save: SessionSave,
  perGameAmount = 0n,
): ParsedSessionSaveV11 {
  if (save.version !== SESSION_SAVE_ENVELOPE_VERSION) {
    throw new Error(`Garbled save: unsupported version ${String(save.version)}`);
  }
  if (typeof save.playerId !== 'string' || save.playerId.length === 0) {
    throw new Error('Garbled save: invalid playerId');
  }

  validateOptionalScalarFields(save);
  validateChannelStatus(save.channelStatus);
  const kind = classifySessionSave(save);
  validatePhasePayloadMatrix(save, kind);

  const activeIds = requireUniqueIds(save.activeGameIds ?? [], 'activeGameIds');
  const currentHandIds = requireUniqueIds(
    save.currentHandGameIds ?? activeIds,
    'currentHandGameIds',
  );
  const currentSet = new Set(currentHandIds);
  if (save.activeGameType !== undefined && !isRegisteredGameType(save.activeGameType)) {
    throw new Error(`Garbled save: invalid activeGameType ${String(save.activeGameType)}`);
  }
  for (const id of activeIds) {
    if (!currentSet.has(id)) {
      throw new Error(`Garbled save: active game ${id} is not in currentHandGameIds`);
    }
  }

  if (
    save.lastDisplayedGameId !== undefined &&
    (typeof save.lastDisplayedGameId !== 'string' || save.lastDisplayedGameId.length === 0)
  ) {
    throw new Error('Garbled save: invalid lastDisplayedGameId');
  }
  if (
    save.gameInstances !== undefined &&
    (typeof save.gameInstances !== 'object' ||
      save.gameInstances === null ||
      Array.isArray(save.gameInstances))
  ) {
    throw new Error('Garbled save: invalid gameInstances');
  }
  const instances = Object.fromEntries(
    Object.entries(save.gameInstances ?? {}).map(([id, instance]) => [
      id,
      parseSavedGameInstance(id, instance),
    ]),
  );
  const referencedIds = new Set([
    ...activeIds,
    ...currentHandIds,
    ...(save.lastDisplayedGameId === undefined ? [] : [save.lastDisplayedGameId]),
  ]);
  for (const id of referencedIds) {
    if (!instances[id]) {
      throw new Error(`Garbled save: game ${id} is missing its keyed instance`);
    }
  }
  for (const id of Object.keys(instances)) {
    if (!referencedIds.has(id)) {
      throw new Error(`Garbled save: game ${id} is an unrelated keyed instance`);
    }
  }
  for (const [id, instance] of Object.entries(instances)) {
    validateTerminalFields(instance.terminal, `gameInstances.${id}.terminal`);
    const ended = instance.presentation === 'ended';
    const terminal = instance.terminal.type !== 'none';
    if (ended !== terminal) {
      throw new Error(`Garbled save: gameInstances.${id} presentation and terminal state disagree`);
    }
    if (activeIds.includes(id) && terminal) {
      throw new Error(`Garbled save: active game ${id} is terminal`);
    }
  }

  let handState = null;
  let decodedHandState: ReturnType<typeof decodePersistedGameState> = null;
  if (save.handState != null) {
    decodedHandState = decodePersistedGameState(save.handState);
    if (!decodedHandState) throw new Error('Garbled save: invalid handState');
    handState = decodedHandState.persisted;
    if (
      typeof save.activeGameType !== 'string' ||
      save.activeGameType !== decodedHandState.persisted.gameType
    ) {
      throw new Error('Garbled save: activeGameType does not match handState.gameType');
    }
  } else if (
    (activeIds.length > 0 || currentHandIds.length > 0) &&
    (typeof save.activeGameType !== 'string' || save.activeGameType.length === 0)
  ) {
    throw new Error('Garbled save: missing activeGameType');
  }

  const hasCurrentHand = activeIds.length > 0 || currentHandIds.length > 0;
  if (kind === 'live-resumable' && hasCurrentHand && decodedHandState === null) {
    throw new Error('Garbled save: live current hand is missing handState');
  }
  if (decodedHandState !== null && currentHandIds.length === 0) {
    throw new Error('Garbled save: handState requires currentHandGameIds');
  }
  if (
    currentHandIds.length > 0 &&
    isRegisteredGameType(save.activeGameType) &&
    !validateGameHandMembership(save.activeGameType, currentHandIds, handState)
  ) {
    throw new Error(
      `Garbled save: ${save.activeGameType} requires ${gameHandMembershipDescription(save.activeGameType)}`,
    );
  }

  if (isTerminalChannelSnapshot(save.channelStatus)) {
    if (!Array.isArray(save.coinsOfInterest)) {
      throw new Error('Garbled save: terminal channel is missing coinsOfInterest');
    }
    const coinIds = new Set<string>();
    for (const [index, coin] of save.coinsOfInterest.entries()) {
      if (
        typeof coin !== 'object' ||
        coin === null ||
        typeof coin.label !== 'string' ||
        coin.label.length === 0 ||
        typeof coin.id !== 'string' ||
        coin.id.length === 0
      ) {
        throw new Error(`Garbled save: invalid coinsOfInterest[${index}]`);
      }
      if (coinIds.has(coin.id)) {
        throw new Error(`Garbled save: duplicate terminal coin ${coin.id}`);
      }
      coinIds.add(coin.id);
    }
  } else if (save.coinsOfInterest !== undefined) {
    throw new Error('Garbled save: coinsOfInterest requires a terminal channel');
  }

  if (
    save.dismissedChannelStatus !== undefined &&
    (typeof save.dismissedChannelStatus !== 'string' ||
      !CHANNEL_STATUSES.has(save.dismissedChannelStatus))
  ) {
    throw new Error('Garbled save: invalid dismissedChannelStatus');
  }

  const fallbackTerms: HandTermsModel = {
    gameType: 'calpoker',
    myContribution: perGameAmount,
    theirContribution: perGameAmount,
    gameTimeout: DEFAULT_GAME_TIMEOUT_BLOCKS,
  };
  const lastTerms = parseTermsSnapshot(
    save.betweenHandLastTerms,
    fallbackTerms,
    'betweenHandLastTerms',
  );
  const hasPersistedHand = activeIds.length > 0 || currentHandIds.length > 0 || handState !== null;
  if (hasPersistedHand && save.betweenHandLastTerms === undefined) {
    throw new Error('Garbled save: persisted hand is missing betweenHandLastTerms');
  }
  if (
    hasPersistedHand &&
    isRegisteredGameType(save.activeGameType) &&
    lastTerms.gameType !== save.activeGameType
  ) {
    throw new Error('Garbled save: activeGameType does not match betweenHandLastTerms.game_type');
  }
  const restoredActiveIds = [...activeIds];
  const lastDisplayedId =
    save.lastDisplayedGameId ??
    restoredActiveIds[0] ??
    currentHandIds[0] ??
    Object.keys(instances)[0] ??
    null;
  const mode =
    save.betweenHandMode === undefined
      ? 'decision'
      : parseDiscriminant<BetweenHandModeModel>(
          save.betweenHandMode,
          BETWEEN_HAND_MODES,
          'betweenHandMode',
        );
  const outgoingProposalGroups = parseProposalGroups(
    save.outgoingProposalGroupIds,
    'outgoingProposalGroupIds',
  );
  const acceptedProposalGroups = parseProposalGroups(
    save.acceptedProposalGroupIds,
    'acceptedProposalGroupIds',
  );
  const outgoingTermsRecord =
    save.outgoingProposalTerms === undefined
      ? {}
      : requireRecord(save.outgoingProposalTerms, 'outgoingProposalTerms');
  const outgoingProposalTerms = Object.fromEntries(
    Object.entries(outgoingTermsRecord).map(([id, saved]) => {
      requireString(id, 'outgoingProposalTerms key');
      return [id, parseTermsSnapshot(saved, lastTerms, `outgoingProposalTerms.${id}`)] as const;
    }),
  );
  if (
    Object.keys(outgoingProposalTerms).length > 0 &&
    save.outgoingProposalGroupIds === undefined
  ) {
    throw new Error('Garbled save: outgoing proposal terms missing group IDs');
  }
  const groupedOutgoingIds = outgoingProposalGroups.flat();
  for (const id of groupedOutgoingIds) {
    if (!outgoingProposalTerms[id]) {
      throw new Error(`Garbled save: outgoing proposal ${id} is missing terms`);
    }
  }
  for (const id of Object.keys(outgoingProposalTerms)) {
    if (!groupedOutgoingIds.includes(id)) {
      throw new Error(`Garbled save: outgoing proposal terms contain unrelated id ${id}`);
    }
  }
  const hasOutgoing = groupedOutgoingIds.length > 0;
  const compose = parseComposeDraftState(
    save.betweenHandCompose,
    createComposeDraftState(perGameAmount, lastTerms),
  );
  const model = normalizeSessionPresentation(
    createSessionModel({
      restore: {
        restoring: !!save.serializedGameSession,
        status: save.serializedGameSession ? 'restoring' : 'idle',
        error: null,
        hubReconciled: false,
      },
      channel: {
        status: save.channelStatus
          ? channelStatusModelFromPayload(save.channelStatus)
          : INITIAL_CHANNEL_STATUS_MODEL,
        connection: save.channelStatus
          ? { stateIdentifier: 'running', stateDetail: [] }
          : { stateIdentifier: 'starting', stateDetail: ['before handshake'] },
        cleanShutdownStarted: save.cleanShutdownStarted ?? false,
        dismissedChannelStatus: (save.dismissedChannelStatus as ChannelStatus | undefined) ?? null,
        queue: parseQueuedNotifications(save.channelNotifQueue),
      },
      game: {
        handKey:
          restoredActiveIds.length > 0 || save.handState || save.betweenHandLastTerms ? 1 : 0,
        activeIds: restoredActiveIds,
        currentHandIds,
        instances,
        lastDisplayedId,
        activeGameType: (() => {
          if (isRegisteredGameType(save.activeGameType)) return save.activeGameType;
          if (restoredActiveIds.length === 0) return 'calpoker';
          throw new Error('Garbled save: missing activeGameType');
        })(),
        handState,
        queue: parseQueuedNotifications(save.gameNotifQueue),
      },
      betweenHand: {
        mode,
        cachedPeerProposal: parseProposalSnapshot(
          save.betweenHandCachedPeerProposal,
          lastTerms,
          'betweenHandCachedPeerProposal',
        ),
        reviewPeerProposal: parseProposalSnapshot(
          save.betweenHandReviewPeerProposal,
          lastTerms,
          'betweenHandReviewPeerProposal',
        ),
        rejectedOnceTerms: parseOptionalTermsSnapshot(
          save.betweenHandRejectedOnceTerms,
          lastTerms,
          'betweenHandRejectedOnceTerms',
        ),
        pendingRetryTerms: parseOptionalTermsSnapshot(
          save.betweenHandPendingRetryTerms,
          lastTerms,
          'betweenHandPendingRetryTerms',
        ),
        lastTerms,
        compose,
        newHandRequested: hasOutgoing && mode === 'decision',
        outgoingProposalIds: groupedOutgoingIds,
        outgoingProposalGroupIds: outgoingProposalGroups,
        acceptedProposalGroupIds: acceptedProposalGroups,
        outgoingProposalTerms,
      },
      history: {
        humanHistory: recentEntries(save.humanHistory ?? [], HUMAN_HISTORY_LIMIT),
        wasmNotificationHistory: recentEntries(
          save.wasmNotificationHistory ?? [],
          WASM_NOTIFICATION_HISTORY_LIMIT,
        ),
        diagnosticLog: recentEntries(save.diagnosticLog ?? [], DIAGNOSTIC_LOG_LIMIT),
      },
      myRunningBalance: parseOptionalDecimalString(save.myRunningBalance, 'myRunningBalance', 0n),
      lastOutcomeWin: save.lastOutcomeWin,
    }),
  );
  return { model, kind };
}

export function validateSessionSaveEnvelope(save: SessionSave): void {
  decodeSessionSaveEnvelope(save);
}

export function sessionModelFromSave(save: SessionSave, perGameAmount = 0n): SessionModel {
  return decodeSessionSaveEnvelope(save, perGameAmount).model;
}
