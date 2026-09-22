import type {
  LiveSessionSave,
  PreHandshakeSessionSave,
  DurableRejectionTransport,
  DurableSessionPhase,
  DurableApplicationState,
  SessionHistorySave,
  SessionIdentitySave,
  SessionPairingSave,
  SessionPreferencesSave,
  SessionPresentationSave,
  SessionTransportSave,
  TerminalSessionSave,
} from './saveEnvelope';
import {
  DURABLE_APPLICATION_STATE_SCHEMA,
  DURABLE_APPLICATION_STATE_VERSION,
  MAX_DURABLE_REJECTION_TRANSPORTS,
} from './saveEnvelope';
import {
  decodePersistedGameState,
  isCatalogGameType,
  restoreRegisteredGameHandState,
} from '../gameRegistry';
import { isSettlementOutcome, type SettlementOutcome } from '../settlement';
import {
  HUMAN_HISTORY_LIMIT,
  recentDiagnosticEntries,
  recentEntries,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from './historyLimits';
import {
  channelStatusModelFromPayload,
  createSessionModel,
  INITIAL_CHANNEL_STATUS_MODEL,
  normalizeSessionPresentation,
} from './normalization';
import type {
  BetweenHandModeModel,
  GameInstanceModel,
  GameProtocolPresentation,
  GameTerminalModel,
  GameTerminalType,
  SessionModel,
} from './types';
import { isTerminalChannelSnapshot } from './selectors';
import {
  parseComposeDraftState,
  parsePendingProposals,
  parseHandProposalSnapshot,
} from './persistenceBetweenHands';
import {
  BETWEEN_HAND_MODES,
  validateChannelStatus,
  validateLive,
  validatePairing,
  decodeTerminalCoins,
  validateTerminalFields,
  validateTransport,
} from './persistencePayloads';
import {
  optionalString,
  parseDecimalString,
  parseDiscriminant,
  requireBigint,
  requireBoolean,
  requireNullableString,
  requireExactKeys,
  requireRecord,
  requireString,
  requireUniqueIds,
  parseStringArray,
} from './persistencePrimitives';
import { decodeChannelFundingEntries } from './channelFundingValidation';
import { decodeFeeAttachments } from './feeAttachmentValidation';
import { providerScopeKey } from './providerKeys';
import { decodeProviderScope } from './providerValidation';

export { snapshotFromSessionModel } from './sessionSnapshot';

const AGGREGATE_FIELDS = new Set([
  'schema',
  'version',
  'identity',
  'preferences',
  'history',
  'session',
  'walletContext',
  'channelFundingOperations',
  'feeAttachments',
  'rejectionTransports',
]);
const SESSION_FIELDS = {
  'pre-handshake': new Set(['phase', 'pairing', 'transport']),
  live: new Set(['phase', 'pairing', 'live', 'presentation']),
  terminal: new Set(['phase', 'terminal', 'presentation']),
} as const;
const IDENTITY_FIELDS = new Set(['playerId', 'sessionId', 'myHubPlayerId']);
const PREFERENCE_FIELDS = new Set([
  'alias',
  'theme',
  'defaultFee',
  'feeUnit',
  'hubUrl',
  'activeTab',
  'unreadGame',
  'walletAlert',
  'hubAlert',
  'blockchainType',
  'network',
]);
const HISTORY_FIELDS = new Set(['humanHistory', 'wasmNotificationHistory', 'diagnosticLog']);
const PAIRING_FIELDS = new Set([
  'token',
  'peerId',
  'gameSessionId',
  'iStarted',
  'myContribution',
  'theirContribution',
  'perGameAmount',
  'channelTimeout',
  'unrollTimeout',
  'myAlias',
  'opponentAlias',
]);
const TRANSPORT_FIELDS = new Set([
  'messageNumber',
  'remoteNumber',
  'unackedMessages',
  'disposition',
  'terminalHandoff',
]);
const LIVE_FIELDS = new Set([
  ...TRANSPORT_FIELDS,
  'serializedGameSession',
  'gameSessionSchemaVersion',
  'rewardPuzzleHash',
]);
const TERMINAL_HANDOFF_FIELDS = new Set(['id', 'message', 'msgno', 'sent', 'acknowledged']);
const UNACKED_MESSAGE_FIELDS = new Set(['msgno', 'msg']);
const TERMINAL_FIELDS = new Set(['iStarted', 'coinsOfInterest', 'myAlias', 'opponentAlias']);
const REJECTION_FIELDS = new Set([
  'kind',
  'peerId',
  'sessionId',
  'messageNumber',
  'remoteNumber',
  'unackedMessages',
  'createdAt',
]);

const PRESENTATION_FIELDS = new Set([
  'handKey',
  'activeGameIds',
  'currentHandGameIds',
  'currentHandOrigin',
  'lastDisplayedGameId',
  'gameInstances',
  'activeGameType',
  'handState',
  'channelStatus',
  'cleanShutdownStarted',
  'betweenHandMode',
  'betweenHandCompose',
  'betweenHandLastHandProposal',
  'betweenHandRejectedOnceHandProposal',
  'betweenHandPendingRetryHandProposal',
  'newHandRequested',
  'pendingProposals',
  'waitingStateEnteredAt',
  'cleanShutdownGraceStartedAt',
]);
const GAME_INSTANCE_FIELDS = new Set(['id', 'amount', 'coinHex', 'presentation', 'terminal']);
const GAME_TERMINAL_FIELDS = new Set(['type', 'outcome', 'label', 'myReward', 'rewardCoinHex']);
const GAME_TERMINAL_TYPES: ReadonlySet<string> = new Set<GameTerminalType>([
  'none',
  'settled',
  'insufficient-balance',
  'ended-cancelled',
  'game-error',
]);
const GAME_PRESENTATIONS: ReadonlySet<string> = new Set<GameProtocolPresentation>([
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

function parseIdentity(value: unknown): SessionIdentitySave {
  const fields = requireRecord(value, 'identity');
  requireExactKeys(fields, IDENTITY_FIELDS, 'identity');
  return {
    playerId: requireString(fields.playerId, 'identity.playerId'),
    sessionId: optionalString(fields.sessionId, 'identity.sessionId'),
    myHubPlayerId: optionalString(fields.myHubPlayerId, 'identity.myHubPlayerId'),
  };
}

function parsePreferences(value: unknown): SessionPreferencesSave {
  const fields = requireRecord(value, 'preferences');
  requireExactKeys(fields, PREFERENCE_FIELDS, 'preferences');
  const theme =
    fields.theme === undefined
      ? undefined
      : parseDiscriminant<'dark' | 'light'>(
          fields.theme,
          new Set(['dark', 'light']),
          'preferences.theme',
        );
  const feeUnit =
    fields.feeUnit === undefined
      ? undefined
      : parseDiscriminant<'mojo' | 'xch'>(
          fields.feeUnit,
          new Set(['mojo', 'xch']),
          'preferences.feeUnit',
        );
  const blockchainType =
    fields.blockchainType === undefined
      ? undefined
      : parseDiscriminant<'simulator' | 'walletconnect' | 'cloud'>(
          fields.blockchainType,
          new Set(['simulator', 'walletconnect', 'cloud']),
          'preferences.blockchainType',
        );
  const network =
    fields.network === undefined
      ? undefined
      : parseDiscriminant<'mainnet' | 'testnet'>(
          fields.network,
          new Set(['mainnet', 'testnet']),
          'preferences.network',
        );
  return {
    alias: optionalString(fields.alias, 'preferences.alias', true),
    theme,
    defaultFee:
      fields.defaultFee === undefined
        ? undefined
        : requireBigint(fields.defaultFee, 'preferences.defaultFee'),
    feeUnit,
    hubUrl: optionalString(fields.hubUrl, 'preferences.hubUrl'),
    activeTab: optionalString(fields.activeTab, 'preferences.activeTab'),
    unreadGame:
      fields.unreadGame === undefined
        ? undefined
        : requireBoolean(fields.unreadGame, 'preferences.unreadGame'),
    walletAlert:
      fields.walletAlert === undefined
        ? undefined
        : requireBoolean(fields.walletAlert, 'preferences.walletAlert'),
    hubAlert:
      fields.hubAlert === undefined
        ? undefined
        : requireBoolean(fields.hubAlert, 'preferences.hubAlert'),
    blockchainType,
    network,
  };
}

function parseHistory(value: unknown): SessionHistorySave {
  const fields = requireRecord(value, 'history');
  requireExactKeys(fields, HISTORY_FIELDS, 'history');
  return {
    humanHistory:
      fields.humanHistory === undefined
        ? undefined
        : parseStringArray(fields.humanHistory, 'history.humanHistory'),
    wasmNotificationHistory:
      fields.wasmNotificationHistory === undefined
        ? undefined
        : parseStringArray(fields.wasmNotificationHistory, 'history.wasmNotificationHistory'),
    diagnosticLog:
      fields.diagnosticLog === undefined
        ? undefined
        : recentDiagnosticEntries(parseStringArray(fields.diagnosticLog, 'history.diagnosticLog')),
  };
}

function parsePairing(value: unknown): SessionPairingSave {
  const fields = requireRecord(value, 'pairing');
  requireExactKeys(fields, PAIRING_FIELDS, 'pairing');
  const pairing: SessionPairingSave = {
    token: requireString(fields.token, 'pairing.token'),
    peerId: optionalString(fields.peerId, 'pairing.peerId'),
    gameSessionId: requireString(fields.gameSessionId, 'pairing.gameSessionId'),
    iStarted: requireBoolean(fields.iStarted, 'pairing.iStarted'),
    myContribution: requireString(fields.myContribution, 'pairing.myContribution'),
    theirContribution: requireString(fields.theirContribution, 'pairing.theirContribution'),
    perGameAmount: requireString(fields.perGameAmount, 'pairing.perGameAmount'),
    channelTimeout: optionalString(fields.channelTimeout, 'pairing.channelTimeout'),
    unrollTimeout: optionalString(fields.unrollTimeout, 'pairing.unrollTimeout'),
    myAlias: optionalString(fields.myAlias, 'pairing.myAlias', true),
    opponentAlias: optionalString(fields.opponentAlias, 'pairing.opponentAlias', true),
  };
  validatePairing(pairing);
  return pairing;
}

function parseTransportFields(
  fields: Record<string, unknown>,
  label: 'transport' | 'live',
): SessionTransportSave {
  if (!Array.isArray(fields.unackedMessages)) {
    throw new Error(`Garbled save: invalid ${label}.unackedMessages`);
  }
  if (!Object.hasOwn(fields, 'terminalHandoff')) {
    throw new Error(`Garbled save: ${label}.terminalHandoff is required`);
  }
  const terminalHandoff =
    fields.terminalHandoff === null
      ? null
      : (() => {
          const record = requireRecord(fields.terminalHandoff, `${label}.terminalHandoff`);
          requireExactKeys(record, TERMINAL_HANDOFF_FIELDS, `${label}.terminalHandoff`);
          if (!(record.message instanceof Uint8Array)) {
            throw new Error(`Garbled save: invalid ${label}.terminalHandoff.message`);
          }
          return {
            id: requireString(record.id, `${label}.terminalHandoff.id`),
            message: record.message,
            msgno: requireBigint(record.msgno, `${label}.terminalHandoff.msgno`),
            sent: requireBoolean(record.sent, `${label}.terminalHandoff.sent`),
            acknowledged: requireBoolean(
              record.acknowledged,
              `${label}.terminalHandoff.acknowledged`,
            ),
          };
        })();
  return {
    messageNumber: requireBigint(fields.messageNumber, `${label}.messageNumber`),
    remoteNumber: requireBigint(fields.remoteNumber, `${label}.remoteNumber`),
    unackedMessages: fields.unackedMessages.map((message, index) => {
      const record = requireRecord(message, `${label}.unackedMessages[${index}]`);
      requireExactKeys(record, UNACKED_MESSAGE_FIELDS, `${label}.unackedMessages[${index}]`);
      if (!(record.msg instanceof Uint8Array)) {
        throw new Error(`Garbled save: invalid ${label}.unackedMessages[${index}].msg`);
      }
      return {
        msgno: requireBigint(record.msgno, `${label}.unackedMessages[${index}].msgno`),
        msg: record.msg,
      };
    }),
    disposition: parseDiscriminant<SessionTransportSave['disposition']>(
      fields.disposition,
      new Set(['active', 'proposal-received', 'outbound-reject', 'inbound-reject']),
      `${label}.disposition`,
    ),
    terminalHandoff,
  };
}

function parseTransport(value: unknown): SessionTransportSave {
  const fields = requireRecord(value, 'transport');
  requireExactKeys(fields, TRANSPORT_FIELDS, 'transport');
  const transport = parseTransportFields(fields, 'transport');
  validateTransport(transport, 'transport');
  return transport;
}

function parseLive(value: unknown): LiveSessionSave['live'] {
  const fields = requireRecord(value, 'live');
  requireExactKeys(fields, LIVE_FIELDS, 'live');
  const live: LiveSessionSave['live'] = {
    ...parseTransportFields(fields, 'live'),
    serializedGameSession:
      fields.serializedGameSession instanceof Uint8Array
        ? fields.serializedGameSession
        : (() => {
            throw new Error('Garbled save: invalid live.serializedGameSession');
          })(),
    gameSessionSchemaVersion: requireBigint(
      fields.gameSessionSchemaVersion,
      'live.gameSessionSchemaVersion',
    ),
    rewardPuzzleHash: requireString(fields.rewardPuzzleHash, 'live.rewardPuzzleHash'),
  };
  validateLive(live);
  return live;
}

function parseRejectionTransports(value: unknown): DurableRejectionTransport[] {
  if (!Array.isArray(value) || value.length > MAX_DURABLE_REJECTION_TRANSPORTS) {
    throw new Error('Garbled application state: invalid rejectionTransports');
  }
  const identities = new Set<string>();
  return value.map((entry, index) => {
    const label = `rejectionTransports[${index}]`;
    const fields = requireRecord(entry, label);
    requireExactKeys(fields, REJECTION_FIELDS, label);
    const peerId = requireString(fields.peerId, `${label}.peerId`);
    const sessionId = requireString(fields.sessionId, `${label}.sessionId`);
    if (!/^[0-9a-f]{32}$/.test(sessionId)) {
      throw new Error(`Garbled application state: invalid ${label}.sessionId`);
    }
    const identity = JSON.stringify([peerId, sessionId]);
    if (identities.has(identity)) {
      throw new Error(`Garbled application state: duplicate ${label}`);
    }
    identities.add(identity);
    if (!Array.isArray(fields.unackedMessages)) {
      throw new Error(`Garbled application state: invalid ${label}.unackedMessages`);
    }
    const createdAt = fields.createdAt;
    if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new Error(`Garbled application state: invalid ${label}.createdAt`);
    }
    return {
      kind: parseDiscriminant<DurableRejectionTransport['kind']>(
        fields.kind,
        new Set(['outbound-reject', 'inbound-receipt']),
        `${label}.kind`,
      ),
      peerId,
      sessionId,
      messageNumber: requireBigint(fields.messageNumber, `${label}.messageNumber`),
      remoteNumber: requireBigint(fields.remoteNumber, `${label}.remoteNumber`),
      unackedMessages: fields.unackedMessages.map((message, messageIndex) => {
        const messageLabel = `${label}.unackedMessages[${messageIndex}]`;
        const messageFields = requireRecord(message, messageLabel);
        requireExactKeys(messageFields, UNACKED_MESSAGE_FIELDS, messageLabel);
        if (!(messageFields.msg instanceof Uint8Array)) {
          throw new Error(`Garbled application state: invalid ${messageLabel}.msg`);
        }
        return {
          msgno: requireBigint(messageFields.msgno, `${messageLabel}.msgno`),
          msg: messageFields.msg,
        };
      }),
      createdAt,
    };
  });
}

function parseGameTerminal(value: unknown, label: string): GameTerminalModel {
  const fields = requireRecord(value, label);
  requireExactKeys(fields, GAME_TERMINAL_FIELDS, label);
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
  } else if (requireNullableString(fields.outcome, `${label}.outcome`, true) !== null) {
    throw new Error(`Garbled save: unexpected ${label}.outcome for ${type}`);
  }
  return {
    type,
    outcome,
    label: requireNullableString(fields.label, `${label}.label`, true),
    myReward: requireNullableString(fields.myReward, `${label}.myReward`, true),
    rewardCoinHex: requireNullableString(fields.rewardCoinHex, `${label}.rewardCoinHex`, true),
  };
}

function parseGameInstance(key: string, value: unknown): GameInstanceModel {
  const label = `gameInstances.${key}`;
  const fields = requireRecord(value, label);
  requireExactKeys(fields, GAME_INSTANCE_FIELDS, label);
  if (fields.id !== key) {
    throw new Error(`Garbled save: game instance ${key} has mismatched id ${String(fields.id)}`);
  }
  const amount = requireString(fields.amount, `${label}.amount`);
  parseDecimalString(amount, `${label}.amount`, 0n);
  return {
    id: key,
    amount,
    coinHex: requireNullableString(fields.coinHex, `${label}.coinHex`),
    presentation: parseDiscriminant<GameProtocolPresentation>(
      fields.presentation,
      GAME_PRESENTATIONS,
      `${label}.presentation`,
    ),
    terminal: parseGameTerminal(fields.terminal, `${label}.terminal`),
  };
}

function parsePresentation(value: unknown): SessionPresentationSave {
  const fields = requireRecord(value, 'presentation');
  requireExactKeys(fields, PRESENTATION_FIELDS, 'presentation');
  if (
    typeof fields.handKey !== 'bigint' ||
    fields.handKey < 0n ||
    fields.handKey > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('Garbled save: invalid handKey');
  }
  const activeGameIds = requireUniqueIds(fields.activeGameIds, 'activeGameIds');
  const currentHandGameIds = requireUniqueIds(fields.currentHandGameIds, 'currentHandGameIds');
  const currentHandOrigin =
    fields.currentHandOrigin === null
      ? null
      : parseDiscriminant<'local' | 'peer'>(
          fields.currentHandOrigin,
          new Set(['local', 'peer']),
          'currentHandOrigin',
        );
  const lastDisplayedGameId = requireNullableString(
    fields.lastDisplayedGameId,
    'lastDisplayedGameId',
  );
  const savedInstances = requireRecord(fields.gameInstances, 'gameInstances');
  const gameInstances = Object.fromEntries(
    Object.entries(savedInstances).map(([id, instance]) => [id, parseGameInstance(id, instance)]),
  );
  if (!isCatalogGameType(fields.activeGameType)) {
    throw new Error(`Garbled save: invalid activeGameType ${String(fields.activeGameType)}`);
  }
  const decodedHandState =
    fields.handState === null ? null : decodePersistedGameState(fields.handState);
  if (fields.handState !== null && decodedHandState === null) {
    throw new Error('Garbled save: invalid handState');
  }
  const compose = parseComposeDraftState(fields.betweenHandCompose);
  const lastHandProposal =
    fields.betweenHandLastHandProposal === null
      ? null
      : parseHandProposalSnapshot(
          fields.betweenHandLastHandProposal,
          'betweenHandLastHandProposal',
        );
  const rejectedOnceHandProposal =
    fields.betweenHandRejectedOnceHandProposal === null
      ? null
      : parseHandProposalSnapshot(
          fields.betweenHandRejectedOnceHandProposal,
          'betweenHandRejectedOnceHandProposal',
        );
  const pendingRetryHandProposal =
    fields.betweenHandPendingRetryHandProposal === null
      ? null
      : parseHandProposalSnapshot(
          fields.betweenHandPendingRetryHandProposal,
          'betweenHandPendingRetryHandProposal',
        );
  const pendingProposals = parsePendingProposals(fields.pendingProposals, 'pendingProposals');
  const waitingStateEnteredAt =
    fields.waitingStateEnteredAt === null
      ? null
      : requireBigint(fields.waitingStateEnteredAt, 'waitingStateEnteredAt');
  const cleanShutdownGraceStartedAt =
    fields.cleanShutdownGraceStartedAt === null
      ? null
      : requireBigint(fields.cleanShutdownGraceStartedAt, 'cleanShutdownGraceStartedAt');
  return {
    handKey: fields.handKey,
    activeGameIds,
    currentHandGameIds,
    currentHandOrigin,
    lastDisplayedGameId,
    gameInstances,
    activeGameType: fields.activeGameType,
    handState: decodedHandState,
    channelStatus: validateChannelStatus(fields.channelStatus),
    cleanShutdownStarted: requireBoolean(fields.cleanShutdownStarted, 'cleanShutdownStarted'),
    betweenHandMode: parseDiscriminant<BetweenHandModeModel>(
      fields.betweenHandMode,
      BETWEEN_HAND_MODES,
      'betweenHandMode',
    ),
    betweenHandCompose: {
      selectedGame: compose.selectedGame,
      gameTimeout: compose.gameTimeout,
    },
    betweenHandLastHandProposal: lastHandProposal,
    betweenHandRejectedOnceHandProposal: rejectedOnceHandProposal,
    betweenHandPendingRetryHandProposal: pendingRetryHandProposal,
    newHandRequested: requireBoolean(fields.newHandRequested, 'newHandRequested'),
    pendingProposals,
    waitingStateEnteredAt,
    cleanShutdownGraceStartedAt,
  };
}

function validatePresentationInvariants(
  save: SessionPresentationSave,
  phase: 'live' | 'terminal',
): void {
  if (phase === 'terminal' && !isTerminalChannelSnapshot(save.channelStatus)) {
    throw new Error('Garbled save: terminal phase requires a terminal channelStatus');
  }
  const activeIds = save.activeGameIds;
  const currentHandIds = save.currentHandGameIds;
  const currentSet = new Set(currentHandIds);
  for (const id of activeIds) {
    if (!currentSet.has(id)) {
      throw new Error(`Garbled save: active game ${id} is not in currentHandGameIds`);
    }
  }
  const referencedIds = new Set([
    ...activeIds,
    ...currentHandIds,
    ...(save.lastDisplayedGameId === null ? [] : [save.lastDisplayedGameId]),
  ]);
  for (const id of referencedIds) {
    if (!save.gameInstances[id]) {
      throw new Error(`Garbled save: game ${id} is missing its keyed instance`);
    }
  }
  for (const [id, instance] of Object.entries(save.gameInstances)) {
    if (!referencedIds.has(id)) {
      throw new Error(`Garbled save: game ${id} is an unrelated keyed instance`);
    }
    validateTerminalFields(instance.terminal, `gameInstances.${id}.terminal`);
    const terminal = instance.terminal.type !== 'none';
    if ((instance.presentation === 'ended') !== terminal) {
      throw new Error(`Garbled save: gameInstances.${id} presentation and terminal state disagree`);
    }
    if (activeIds.includes(id) && terminal) {
      throw new Error(`Garbled save: active game ${id} is terminal`);
    }
  }
  const hasCurrentHand = activeIds.length > 0 || currentHandIds.length > 0;
  if (hasCurrentHand !== (save.currentHandOrigin !== null)) {
    throw new Error(
      hasCurrentHand
        ? 'Garbled save: current hand is missing currentHandOrigin'
        : 'Garbled save: currentHandOrigin requires a current hand',
    );
  }
  if (currentHandIds.length > 0 && save.handState === null) {
    throw new Error('Garbled save: current hand is missing handState');
  }
  if (save.handState !== null) {
    if (currentHandIds.length === 0) {
      throw new Error('Garbled save: handState requires currentHandGameIds');
    }
    if (save.handState.gameType !== save.activeGameType) {
      throw new Error('Garbled save: activeGameType does not match handState.gameType');
    }
    try {
      restoreRegisteredGameHandState(save.activeGameType, save.handState);
    } catch (error) {
      throw new Error(
        `Garbled save: ${save.activeGameType} handState cannot be restored: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }
  const hasPersistedHand = hasCurrentHand || save.handState !== null;
  if (hasPersistedHand && save.betweenHandLastHandProposal === null) {
    throw new Error('Garbled save: persisted hand is missing betweenHandLastHandProposal');
  }
  if (
    hasPersistedHand &&
    save.betweenHandLastHandProposal !== null &&
    save.betweenHandLastHandProposal.gameType !== save.activeGameType
  ) {
    throw new Error(
      'Garbled save: activeGameType does not match betweenHandLastHandProposal.gameType',
    );
  }
}

export interface ParsedSessionSave {
  model: SessionModel;
  save: DurableApplicationState;
}

export function decodeDurableApplicationState(value: unknown): ParsedSessionSave {
  const envelope = requireRecord(value, 'application state');
  requireExactKeys(envelope, AGGREGATE_FIELDS, 'application state');
  if (envelope.schema !== DURABLE_APPLICATION_STATE_SCHEMA) {
    throw new Error(`Garbled application state: unsupported schema ${String(envelope.schema)}`);
  }
  if (envelope.version !== DURABLE_APPLICATION_STATE_VERSION) {
    throw new Error(`Garbled application state: unsupported version ${String(envelope.version)}`);
  }
  const identity = parseIdentity(envelope.identity);
  const preferences = parsePreferences(envelope.preferences);
  const history = parseHistory(envelope.history);
  const walletContext =
    envelope.walletContext === null
      ? null
      : decodeProviderScope(envelope.walletContext, 'walletContext');
  const channelFundingOperations = decodeChannelFundingEntries(
    envelope.channelFundingOperations,
    'channelFundingOperations',
    'funding',
  );
  const feeAttachments = decodeFeeAttachments(envelope.feeAttachments);
  const providerReservationIds = new Set<string>();
  for (const entry of [...channelFundingOperations, ...feeAttachments]) {
    if (entry.stage === 'creating' || entry.stage === 'best-effort-uncertain') continue;
    if (providerReservationIds.has(entry.providerReservationId)) {
      throw new Error(
        `Garbled application state: duplicate provider reservation ${entry.providerReservationId}`,
      );
    }
    providerReservationIds.add(entry.providerReservationId);
  }
  if (
    (channelFundingOperations.length > 0 || feeAttachments.length > 0) &&
    walletContext === null
  ) {
    throw new Error('Garbled application state: provider-backed operations require walletContext');
  }
  if (
    walletContext &&
    [...channelFundingOperations, ...feeAttachments].some(
      (entry) => providerScopeKey(entry.owner.providerScope) !== providerScopeKey(walletContext),
    )
  ) {
    throw new Error('Garbled application state: provider operation owner/context mismatch');
  }
  const rejectionTransports = parseRejectionTransports(envelope.rejectionTransports);
  const common = {
    schema: DURABLE_APPLICATION_STATE_SCHEMA,
    version: DURABLE_APPLICATION_STATE_VERSION,
    identity,
    preferences,
    history,
    walletContext,
    channelFundingOperations,
    feeAttachments,
    rejectionTransports,
  } as const;
  let session: DurableSessionPhase | null;
  const sessionEnvelope =
    envelope.session === null ? null : requireRecord(envelope.session, 'session');
  let presentation: SessionPresentationSave | null = null;
  let restoring = false;
  switch (sessionEnvelope?.phase) {
    case undefined:
      session = null;
      break;
    case 'pre-handshake':
      requireExactKeys(sessionEnvelope, SESSION_FIELDS['pre-handshake'], 'session');
      session = {
        phase: 'pre-handshake',
        pairing: parsePairing(sessionEnvelope.pairing),
        transport: parseTransport(sessionEnvelope.transport),
      } satisfies PreHandshakeSessionSave;
      break;
    case 'live':
      requireExactKeys(sessionEnvelope, SESSION_FIELDS.live, 'session');
      presentation = parsePresentation(sessionEnvelope.presentation);
      session = {
        phase: 'live',
        pairing: parsePairing(sessionEnvelope.pairing),
        live: parseLive(sessionEnvelope.live),
        presentation,
      } satisfies LiveSessionSave;
      restoring = true;
      break;
    case 'terminal': {
      requireExactKeys(sessionEnvelope, SESSION_FIELDS.terminal, 'session');
      const terminal = requireRecord(sessionEnvelope.terminal, 'terminal');
      requireExactKeys(terminal, TERMINAL_FIELDS, 'terminal');
      presentation = parsePresentation(sessionEnvelope.presentation);
      session = {
        phase: 'terminal',
        terminal: {
          iStarted: requireBoolean(terminal.iStarted, 'terminal.iStarted'),
          coinsOfInterest: decodeTerminalCoins(terminal.coinsOfInterest),
          myAlias: requireNullableString(terminal.myAlias, 'terminal.myAlias', true),
          opponentAlias: requireNullableString(
            terminal.opponentAlias,
            'terminal.opponentAlias',
            true,
          ),
        },
        presentation,
      } satisfies TerminalSessionSave;
      break;
    }
    default:
      throw new Error(
        `Garbled application state: invalid session phase ${String(sessionEnvelope?.phase)}`,
      );
  }
  if (session !== null && walletContext === null) {
    throw new Error('Garbled application state: durable session requires walletContext');
  }
  const typedEnvelope: DurableApplicationState = { ...common, session };
  if (presentation === null) {
    return {
      save: typedEnvelope,
      model: createSessionModel({
        history: {
          humanHistory: recentEntries(history.humanHistory ?? [], HUMAN_HISTORY_LIMIT),
          wasmNotificationHistory: recentEntries(
            history.wasmNotificationHistory ?? [],
            WASM_NOTIFICATION_HISTORY_LIMIT,
          ),
          diagnosticLog: recentDiagnosticEntries(history.diagnosticLog ?? []),
        },
      }),
    };
  }
  if (typedEnvelope.session?.phase !== 'live' && typedEnvelope.session?.phase !== 'terminal') {
    throw new Error('Garbled save: presentation requires a live or terminal session');
  }
  validatePresentationInvariants(presentation, typedEnvelope.session.phase);
  const save = presentation;
  const activeIds = save.activeGameIds;
  const currentHandIds = save.currentHandGameIds;
  const instances = save.gameInstances;
  const handState = save.handState;
  const pendingProposals = save.pendingProposals;
  const restoredActiveIds = [...activeIds];
  const lastDisplayedId = save.lastDisplayedGameId;
  const mode = save.betweenHandMode;
  const model = normalizeSessionPresentation(
    createSessionModel({
      restore: {
        restoring,
        status: restoring ? 'restoring' : 'idle',
        error: null,
      },
      channel: {
        status: save.channelStatus
          ? channelStatusModelFromPayload(save.channelStatus)
          : INITIAL_CHANNEL_STATUS_MODEL,
        connection: save.channelStatus
          ? { stateIdentifier: 'running', stateDetail: [] }
          : { stateIdentifier: 'starting', stateDetail: ['before handshake'] },
        cleanShutdownStarted: save.cleanShutdownStarted,
        dismissedChannelStatus: null,
        queue: [],
      },
      game: {
        handKey: Number(save.handKey),
        activeIds: restoredActiveIds,
        currentHandIds,
        currentHandOrigin: save.currentHandOrigin,
        instances,
        lastDisplayedId,
        activeGameType: save.activeGameType,
        handState,
        queue: [],
      },
      betweenHand: {
        mode,
        pendingProposals,
        rejectedOnceHandProposal: save.betweenHandRejectedOnceHandProposal,
        pendingRetryHandProposal: save.betweenHandPendingRetryHandProposal,
        lastHandProposal: save.betweenHandLastHandProposal,
        compose: {
          ...save.betweenHandCompose,
          proposalSent: pendingProposals.some(
            ({ lifecycle }) =>
              lifecycle === 'local-outgoing' || lifecycle === 'local-cancel-queued',
          ),
        },
        newHandRequested: save.newHandRequested,
      },
      history: {
        humanHistory: recentEntries(typedEnvelope.history.humanHistory ?? [], HUMAN_HISTORY_LIMIT),
        wasmNotificationHistory: recentEntries(
          typedEnvelope.history.wasmNotificationHistory ?? [],
          WASM_NOTIFICATION_HISTORY_LIMIT,
        ),
        diagnosticLog: recentDiagnosticEntries(typedEnvelope.history.diagnosticLog ?? []),
      },
    }),
  );
  return {
    model,
    save: typedEnvelope,
  };
}

/** Decode once at boot and distribute independent plain-data projections. */
export function rehydrateDurableApplicationState(value: unknown) {
  const decoded = decodeDurableApplicationState(value);
  return {
    state: structuredClone(decoded.save),
    model: structuredClone(decoded.model),
  };
}

export type RehydratedDurableApplicationState = ReturnType<typeof rehydrateDurableApplicationState>;
