import type { ChannelStatusPayload } from '../../types/ChiaGaming';
import type {
  LiveSessionSave,
  PreHandshakeSessionSave,
  DurableRejectionTransport,
  DurableSessionPhase,
  DurableApplicationState,
  SavedHandProposal,
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
import type { BetweenHandModeModel, HandProposal, SessionModel } from './types';
import { isTerminalChannelSnapshot } from './selectors';
import {
  parseComposeDraftState,
  encodeComposeDraftState,
  parseOptionalHandProposalSnapshot,
  parsePendingProposals,
  parseHandProposalSnapshot,
} from './persistenceBetweenHands';
import {
  BETWEEN_HAND_MODES,
  parseSavedGameInstance,
  validateChannelStatus,
  validateLive,
  validatePairing,
  validateTerminalCoins,
  validateTerminalFields,
  validateTransport,
} from './persistencePayloads';
import {
  optionalString,
  parseDiscriminant,
  requireBigintString,
  requireBigint,
  requireBoolean,
  requireNullableString,
  requireExactKeys,
  requireRecord,
  requireString,
  requireUniqueIds,
  parseStringArray,
} from './persistencePrimitives';
import {
  decodeWalletOperationEntries,
  decodeWalletProviderScope,
} from './walletOperationValidation';
import { walletProviderScopeKey } from './walletOperationStore';

export { snapshotFromSessionModel } from './sessionSnapshot';

const AGGREGATE_FIELDS = new Set([
  'schema',
  'version',
  'identity',
  'preferences',
  'history',
  'session',
  'walletContext',
  'walletObligations',
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

export function decodeChannelStatusPayload(value: unknown): ChannelStatusPayload | null {
  return validateChannelStatus(value);
}

function savedHandProposalFromModel(handProposal: HandProposal): SavedHandProposal {
  return {
    sender_is_player_a: handProposal.senderIsPlayerA,
    game_timeout: handProposal.gameTimeout.toString(),
    game_type: handProposal.gameType,
    parameters: handProposal.parameters,
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
    Object.entries(savedInstances).map(([id, instance]) => {
      const parsed = parseSavedGameInstance(id, instance);
      return [id, parsed];
    }),
  );
  if (!isCatalogGameType(fields.activeGameType)) {
    throw new Error(`Garbled save: invalid activeGameType ${String(fields.activeGameType)}`);
  }
  const decodedHandState =
    fields.handState === null ? null : decodePersistedGameState(fields.handState);
  if (fields.handState !== null && decodedHandState === null) {
    throw new Error('Garbled save: invalid handState');
  }
  if (decodedHandState !== null) {
    if (decodedHandState.persisted.gameType !== fields.activeGameType) {
      throw new Error('Garbled save: activeGameType does not match handState.gameType');
    }
    try {
      restoreRegisteredGameHandState(fields.activeGameType, decodedHandState.persisted);
    } catch (error) {
      throw new Error(
        `Garbled save: ${fields.activeGameType} handState cannot be restored: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }
  const compose = parseComposeDraftState(fields.betweenHandCompose);
  const lastHandProposal =
    fields.betweenHandLastHandProposal === null
      ? null
      : parseHandProposalSnapshot(
          fields.betweenHandLastHandProposal,
          'betweenHandLastHandProposal',
        );
  const rejectedOnceHandProposal = parseOptionalHandProposalSnapshot(
    fields.betweenHandRejectedOnceHandProposal,
    'betweenHandRejectedOnceHandProposal',
  );
  const pendingRetryHandProposal = parseOptionalHandProposalSnapshot(
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
    handState: decodedHandState?.persisted ?? null,
    channelStatus: decodeChannelStatusPayload(fields.channelStatus),
    cleanShutdownStarted: requireBoolean(fields.cleanShutdownStarted, 'cleanShutdownStarted'),
    betweenHandMode: parseDiscriminant<BetweenHandModeModel>(
      fields.betweenHandMode,
      BETWEEN_HAND_MODES,
      'betweenHandMode',
    ),
    betweenHandCompose: encodeComposeDraftState(compose),
    betweenHandLastHandProposal:
      lastHandProposal === null ? null : savedHandProposalFromModel(lastHandProposal),
    betweenHandRejectedOnceHandProposal:
      rejectedOnceHandProposal === null
        ? null
        : savedHandProposalFromModel(rejectedOnceHandProposal),
    betweenHandPendingRetryHandProposal:
      pendingRetryHandProposal === null
        ? null
        : savedHandProposalFromModel(pendingRetryHandProposal),
    newHandRequested: requireBoolean(fields.newHandRequested, 'newHandRequested'),
    pendingProposals: pendingProposals.map((proposal) => ({
      id: proposal.id,
      lifecycle: proposal.lifecycle,
      hand_proposal: savedHandProposalFromModel(proposal.handProposal),
    })),
    waitingStateEnteredAt,
    cleanShutdownGraceStartedAt,
  };
}

export function sessionAmountsFromSave(save: DurableApplicationState): {
  myContribution: bigint;
  theirContribution: bigint;
  perGameAmount: bigint;
} {
  if (save.session === null || save.session.phase === 'terminal') {
    throw new Error(`Garbled save: ${save.session?.phase ?? 'no-session'} has no session amounts`);
  }
  const myContribution = requireBigintString(save.session.pairing.myContribution, 'myContribution');
  const theirContribution = requireBigintString(
    save.session.pairing.theirContribution,
    'theirContribution',
  );
  const perGameAmount = requireBigintString(save.session.pairing.perGameAmount, 'perGameAmount');
  return {
    myContribution,
    theirContribution,
    perGameAmount,
  };
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
      : decodeWalletProviderScope(envelope.walletContext, 'walletContext');
  const walletObligations = decodeWalletOperationEntries(
    envelope.walletObligations,
    'walletObligations',
  );
  if (walletObligations.length > 0 && walletContext === null) {
    throw new Error('Garbled application state: wallet obligations require walletContext');
  }
  if (
    walletContext &&
    walletObligations.some(
      (entry) =>
        walletProviderScopeKey(entry.owner.providerScope) !== walletProviderScopeKey(walletContext),
    )
  ) {
    throw new Error('Garbled application state: wallet obligation owner/context mismatch');
  }
  const rejectionTransports = parseRejectionTransports(envelope.rejectionTransports);
  const common = {
    schema: DURABLE_APPLICATION_STATE_SCHEMA,
    version: DURABLE_APPLICATION_STATE_VERSION,
    identity,
    preferences,
    history,
    walletContext,
    walletObligations,
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
      validateTerminalCoins(terminal.coinsOfInterest);
      const coins = terminal.coinsOfInterest as unknown[];
      presentation = parsePresentation(sessionEnvelope.presentation);
      session = {
        phase: 'terminal',
        terminal: {
          iStarted: requireBoolean(terminal.iStarted, 'terminal.iStarted'),
          coinsOfInterest: coins.map((coin, index) => {
            const fields = requireRecord(coin, `terminal.coinsOfInterest[${index}]`);
            const gameId =
              fields.game_id === undefined
                ? undefined
                : requireString(fields.game_id, `terminal.coinsOfInterest[${index}].game_id`);
            const gameCoinKind =
              fields.game_coin_kind === undefined
                ? undefined
                : requireString(
                    fields.game_coin_kind,
                    `terminal.coinsOfInterest[${index}].game_coin_kind`,
                  );
            if (
              gameCoinKind !== undefined &&
              gameCoinKind !== 'current' &&
              gameCoinKind !== 'reward'
            ) {
              throw new Error(
                `Garbled save: invalid terminal.coinsOfInterest[${index}].game_coin_kind`,
              );
            }
            return {
              label: requireString(fields.label, `terminal.coinsOfInterest[${index}].label`),
              id: requireString(fields.id, `terminal.coinsOfInterest[${index}].id`),
              ...(gameId === undefined ? {} : { game_id: gameId }),
              ...(gameCoinKind === undefined ? {} : { game_coin_kind: gameCoinKind }),
            };
          }),
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
  const save = presentation;
  if (
    typedEnvelope.session?.phase === 'terminal' &&
    !isTerminalChannelSnapshot(save.channelStatus)
  ) {
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

  const instances = Object.fromEntries(
    Object.entries(save.gameInstances).map(([id, instance]) => [
      id,
      parseSavedGameInstance(id, instance),
    ]),
  );
  const referencedIds = new Set([
    ...activeIds,
    ...currentHandIds,
    ...(save.lastDisplayedGameId === null ? [] : [save.lastDisplayedGameId]),
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

  const handState = save.handState;

  const hasCurrentHand = activeIds.length > 0 || currentHandIds.length > 0;
  if (hasCurrentHand && save.currentHandOrigin === null) {
    throw new Error('Garbled save: current hand is missing currentHandOrigin');
  }
  if (!hasCurrentHand && save.currentHandOrigin !== null) {
    throw new Error('Garbled save: currentHandOrigin requires a current hand');
  }
  if (typedEnvelope.session?.phase === 'live' && hasCurrentHand && handState === null) {
    throw new Error('Garbled save: live current hand is missing handState');
  }
  if (handState !== null && currentHandIds.length === 0) {
    throw new Error('Garbled save: handState requires currentHandGameIds');
  }
  const compose = parseComposeDraftState(save.betweenHandCompose);
  const lastHandProposal =
    save.betweenHandLastHandProposal === null
      ? null
      : parseHandProposalSnapshot(save.betweenHandLastHandProposal, 'betweenHandLastHandProposal');
  const hasPersistedHand = activeIds.length > 0 || currentHandIds.length > 0 || handState !== null;
  if (hasPersistedHand && lastHandProposal === null) {
    throw new Error('Garbled save: persisted hand is missing betweenHandLastHandProposal');
  }
  if (
    hasPersistedHand &&
    lastHandProposal !== null &&
    isCatalogGameType(save.activeGameType) &&
    lastHandProposal.gameType !== save.activeGameType
  ) {
    throw new Error(
      'Garbled save: activeGameType does not match betweenHandLastHandProposal.game_type',
    );
  }
  const restoredActiveIds = [...activeIds];
  const lastDisplayedId = save.lastDisplayedGameId;
  const mode = save.betweenHandMode;
  const pendingProposals = parsePendingProposals(save.pendingProposals, 'pendingProposals');
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
        rejectedOnceHandProposal: parseOptionalHandProposalSnapshot(
          save.betweenHandRejectedOnceHandProposal,
          'betweenHandRejectedOnceHandProposal',
        ),
        pendingRetryHandProposal: parseOptionalHandProposalSnapshot(
          save.betweenHandPendingRetryHandProposal,
          'betweenHandPendingRetryHandProposal',
        ),
        lastHandProposal,
        compose: {
          ...compose,
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
