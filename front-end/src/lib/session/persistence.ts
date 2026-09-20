import type { ChannelStatus, ChannelStatusPayload } from '../../types/ChiaGaming';
import { CHANNEL_SEMANTIC_PHASES } from '../../types/ChiaGaming';
import type {
  LiveSessionSave,
  PreHandshakeSessionSave,
  PreferencesSessionSave,
  SavedHandProposal,
  SessionHistorySave,
  SessionIdentitySave,
  SessionPairingSave,
  SessionPreferencesSave,
  SessionPresentationSave,
  SessionSave,
  SessionTransportSave,
  TerminalSessionSave,
} from './saveEnvelope';
import { SESSION_SAVE_SCHEMA, SESSION_SAVE_VERSION } from './saveEnvelope';
import {
  decodePersistedGameState,
  isCatalogGameType,
  restoreRegisteredGameHandState,
} from '../gameRegistry';
import {
  DIAGNOSTIC_LOG_LIMIT,
  HUMAN_HISTORY_LIMIT,
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
  CHANNEL_STATUSES,
  parseQueuedNotifications,
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
  parseDecimalString,
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
import { decodeCanonicalFundingRequest, fundingRequestKey } from './fundingRequest';

export { snapshotFromSessionModel } from './sessionSnapshot';

export const SESSION_SAVE_ENVELOPE_VERSION = SESSION_SAVE_VERSION;

const COMMON_ENVELOPE_FIELDS = ['schema', 'version', 'phase', 'identity', 'preferences', 'history'];
const ENVELOPE_FIELDS = {
  preferences: new Set(COMMON_ENVELOPE_FIELDS),
  'pre-handshake': new Set([...COMMON_ENVELOPE_FIELDS, 'pairing', 'transport']),
  live: new Set([...COMMON_ENVELOPE_FIELDS, 'pairing', 'live', 'presentation']),
  terminal: new Set([...COMMON_ENVELOPE_FIELDS, 'terminal', 'presentation']),
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
  'durabilityWarning',
  'fundingOutbox',
]);
const TERMINAL_HANDOFF_FIELDS = new Set(['id', 'message', 'msgno', 'sent', 'acknowledged']);
const UNACKED_MESSAGE_FIELDS = new Set(['msgno', 'msg']);
const FUNDING_OUTBOX_FIELDS = new Set(['key', 'request']);
const TERMINAL_FIELDS = new Set(['iStarted', 'coinsOfInterest', 'myAlias', 'opponentAlias']);

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
  'myRunningBalance',
  'channelNotifQueue',
  'gameNotifQueue',
  'dismissedChannelStatus',
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
        : parseStringArray(fields.diagnosticLog, 'history.diagnosticLog'),
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
  const fundingOutbox = fields.fundingOutbox;
  if (fundingOutbox !== undefined && !Array.isArray(fundingOutbox)) {
    throw new Error('Garbled save: invalid live.fundingOutbox');
  }
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
    durabilityWarning: optionalString(fields.durabilityWarning, 'live.durabilityWarning', true),
    ...(fundingOutbox === undefined
      ? {}
      : {
          fundingOutbox: fundingOutbox.map((entry, index) => {
            const record = requireRecord(entry, `live.fundingOutbox[${index}]`);
            requireExactKeys(record, FUNDING_OUTBOX_FIELDS, `live.fundingOutbox[${index}]`);
            const key = requireString(record.key, `live.fundingOutbox[${index}].key`);
            const request = decodeCanonicalFundingRequest(
              record.request,
              `live.fundingOutbox[${index}].request`,
            );
            if (key !== fundingRequestKey(request)) {
              throw new Error(
                `Garbled save: live.fundingOutbox[${index}] key does not match its request`,
              );
            }
            return { key, request };
          }),
        }),
  };
  validateLive(live);
  return live;
}

export function decodeChannelStatusPayload(value: unknown): ChannelStatusPayload | null {
  if (value === null) return null;
  validateChannelStatus(value);
  const fields = requireRecord(value, 'channelStatus');
  for (const required of ['advisory', 'coin', 'our_balance', 'their_balance', 'game_allocated']) {
    if (!Object.hasOwn(fields, required)) {
      throw new Error(`Garbled save: channelStatus is missing ${required}`);
    }
  }
  const sessionDisposition =
    fields.session_disposition === undefined || fields.session_disposition === null
      ? fields.session_disposition
      : parseDiscriminant<'AwaitOutboundTerminal' | 'Abandoned'>(
          fields.session_disposition,
          new Set(['AwaitOutboundTerminal', 'Abandoned']),
          'channelStatus.session_disposition',
        );
  const advisory =
    fields.advisory === null
      ? null
      : requireString(fields.advisory, 'channelStatus.advisory', true);
  const havePotato =
    fields.have_potato === undefined || fields.have_potato === null
      ? fields.have_potato
      : requireBoolean(fields.have_potato, 'channelStatus.have_potato');
  const zeroPayout =
    fields.zero_payout === undefined || fields.zero_payout === null
      ? fields.zero_payout
      : requireBoolean(fields.zero_payout, 'channelStatus.zero_payout');
  const unrollInitiator =
    fields.unroll_initiator === undefined || fields.unroll_initiator === null
      ? fields.unroll_initiator
      : parseDiscriminant<'us' | 'opponent'>(
          fields.unroll_initiator,
          new Set(['us', 'opponent']),
          'channelStatus.unroll_initiator',
        );
  const semanticPhase =
    fields.semantic_phase === undefined || fields.semantic_phase === null
      ? fields.semantic_phase
      : parseDiscriminant<NonNullable<ChannelStatusPayload['semantic_phase']>>(
          fields.semantic_phase,
          new Set<string>(CHANNEL_SEMANTIC_PHASES),
          'channelStatus.semantic_phase',
        );
  const optionalStateNumber = (
    field: 'state_number' | 'unrolling_state_number' | 'preempting_state_number',
  ): bigint | null | undefined => {
    const value = fields[field];
    if (value === undefined || value === null) return value;
    return requireBigint(value, `channelStatus.${field}`);
  };
  return {
    state: parseDiscriminant<ChannelStatus>(fields.state, CHANNEL_STATUSES, 'channelStatus.state'),
    session_disposition: sessionDisposition,
    advisory,
    coin: fields.coin,
    our_balance: fields.our_balance,
    their_balance: fields.their_balance,
    game_allocated: fields.game_allocated,
    have_potato: havePotato,
    zero_payout: zeroPayout,
    unroll_initiator: unrollInitiator,
    semantic_phase: semanticPhase,
    state_number: optionalStateNumber('state_number'),
    unrolling_state_number: optionalStateNumber('unrolling_state_number'),
    preempting_state_number: optionalStateNumber('preempting_state_number'),
  };
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
  const dismissedChannelStatus =
    fields.dismissedChannelStatus === null
      ? null
      : parseDiscriminant<ChannelStatus>(
          fields.dismissedChannelStatus,
          CHANNEL_STATUSES,
          'dismissedChannelStatus',
        );
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
    myRunningBalance: (() => {
      parseDecimalString(fields.myRunningBalance, 'myRunningBalance');
      return requireString(fields.myRunningBalance, 'myRunningBalance');
    })(),
    channelNotifQueue: parseQueuedNotifications(fields.channelNotifQueue),
    gameNotifQueue: parseQueuedNotifications(fields.gameNotifQueue),
    dismissedChannelStatus,
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

export function sessionAmountsFromSave(save: SessionSave): {
  myContribution: bigint;
  theirContribution: bigint;
  perGameAmount: bigint;
} {
  if (save.phase === 'preferences' || save.phase === 'terminal') {
    throw new Error(`Garbled save: ${save.phase} has no session amounts`);
  }
  const myContribution = requireBigintString(save.pairing.myContribution, 'myContribution');
  const theirContribution = requireBigintString(
    save.pairing.theirContribution,
    'theirContribution',
  );
  const perGameAmount = requireBigintString(save.pairing.perGameAmount, 'perGameAmount');
  return {
    myContribution,
    theirContribution,
    perGameAmount,
  };
}

export interface ParsedSessionSave {
  model: SessionModel;
  phase: SessionSave['phase'];
  save: SessionSave;
}

export function decodeSessionSaveEnvelope(value: unknown): ParsedSessionSave {
  const envelope = requireRecord(value, 'session envelope');
  if (envelope.schema !== SESSION_SAVE_SCHEMA) {
    throw new Error(`Garbled save: unsupported schema ${String(envelope.schema)}`);
  }
  if (envelope.version !== SESSION_SAVE_ENVELOPE_VERSION) {
    throw new Error(`Garbled save: unsupported version ${String(envelope.version)}`);
  }
  if (envelope.walletReservationLedger !== undefined) {
    throw new Error('Garbled save: walletReservationLedger is not session-owned');
  }
  const identity = parseIdentity(envelope.identity);
  const preferences = parsePreferences(envelope.preferences);
  const history = parseHistory(envelope.history);
  const common = {
    schema: SESSION_SAVE_SCHEMA,
    version: SESSION_SAVE_VERSION,
    identity,
    preferences,
    history,
  } as const;
  let typedEnvelope: SessionSave;
  let presentation: SessionPresentationSave | null = null;
  let restoring = false;
  switch (envelope.phase) {
    case 'preferences':
      requireExactKeys(envelope, ENVELOPE_FIELDS.preferences, 'session envelope');
      if (
        envelope.pairing !== undefined ||
        envelope.transport !== undefined ||
        envelope.live !== undefined ||
        envelope.presentation !== undefined ||
        envelope.terminal !== undefined
      ) {
        throw new Error('Garbled save: unexpected preferences phase payload');
      }
      typedEnvelope = { ...common, phase: 'preferences' } satisfies PreferencesSessionSave;
      break;
    case 'pre-handshake':
      requireExactKeys(envelope, ENVELOPE_FIELDS['pre-handshake'], 'session envelope');
      if (
        envelope.live !== undefined ||
        envelope.presentation !== undefined ||
        envelope.terminal !== undefined
      ) {
        throw new Error('Garbled save: unexpected pre-handshake phase payload');
      }
      typedEnvelope = {
        ...common,
        phase: 'pre-handshake',
        pairing: parsePairing(envelope.pairing),
        transport: parseTransport(envelope.transport),
      } satisfies PreHandshakeSessionSave;
      break;
    case 'live':
      requireExactKeys(envelope, ENVELOPE_FIELDS.live, 'session envelope');
      if (envelope.terminal !== undefined) {
        throw new Error('Garbled save: unexpected live phase payload');
      }
      if (envelope.transport !== undefined) {
        throw new Error('Garbled save: unexpected live transport payload');
      }
      presentation = parsePresentation(envelope.presentation);
      typedEnvelope = {
        ...common,
        phase: 'live',
        pairing: parsePairing(envelope.pairing),
        live: parseLive(envelope.live),
        presentation,
      } satisfies LiveSessionSave;
      restoring = true;
      break;
    case 'terminal': {
      requireExactKeys(envelope, ENVELOPE_FIELDS.terminal, 'session envelope');
      if (
        envelope.pairing !== undefined ||
        envelope.transport !== undefined ||
        envelope.live !== undefined
      ) {
        throw new Error('Garbled save: unexpected terminal phase payload');
      }
      const terminal = requireRecord(envelope.terminal, 'terminal');
      requireExactKeys(terminal, TERMINAL_FIELDS, 'terminal');
      validateTerminalCoins(terminal.coinsOfInterest);
      const coins = terminal.coinsOfInterest as unknown[];
      presentation = parsePresentation(envelope.presentation);
      typedEnvelope = {
        ...common,
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
      throw new Error(`Garbled save: invalid phase ${String(envelope.phase)}`);
  }
  if (presentation === null) {
    return {
      phase: typedEnvelope.phase,
      save: typedEnvelope,
      model: createSessionModel({
        history: {
          humanHistory: recentEntries(history.humanHistory ?? [], HUMAN_HISTORY_LIMIT),
          wasmNotificationHistory: recentEntries(
            history.wasmNotificationHistory ?? [],
            WASM_NOTIFICATION_HISTORY_LIMIT,
          ),
          diagnosticLog: recentEntries(history.diagnosticLog ?? [], DIAGNOSTIC_LOG_LIMIT),
        },
      }),
    };
  }
  const save = presentation;
  if (typedEnvelope.phase === 'terminal' && !isTerminalChannelSnapshot(save.channelStatus)) {
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
  }

  const hasCurrentHand = activeIds.length > 0 || currentHandIds.length > 0;
  if (hasCurrentHand && save.currentHandOrigin === null) {
    throw new Error('Garbled save: current hand is missing currentHandOrigin');
  }
  if (!hasCurrentHand && save.currentHandOrigin !== null) {
    throw new Error('Garbled save: currentHandOrigin requires a current hand');
  }
  if (typedEnvelope.phase === 'live' && hasCurrentHand && decodedHandState === null) {
    throw new Error('Garbled save: live current hand is missing handState');
  }
  if (decodedHandState !== null && currentHandIds.length === 0) {
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
        hubReconciled: false,
      },
      channel: {
        status: save.channelStatus
          ? channelStatusModelFromPayload(save.channelStatus)
          : INITIAL_CHANNEL_STATUS_MODEL,
        connection: save.channelStatus
          ? { stateIdentifier: 'running', stateDetail: [] }
          : { stateIdentifier: 'starting', stateDetail: ['before handshake'] },
        cleanShutdownStarted: save.cleanShutdownStarted,
        dismissedChannelStatus: save.dismissedChannelStatus,
        queue: parseQueuedNotifications(save.channelNotifQueue),
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
        queue: parseQueuedNotifications(save.gameNotifQueue),
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
        compose,
        newHandRequested: save.newHandRequested,
      },
      history: {
        humanHistory: recentEntries(typedEnvelope.history.humanHistory ?? [], HUMAN_HISTORY_LIMIT),
        wasmNotificationHistory: recentEntries(
          typedEnvelope.history.wasmNotificationHistory ?? [],
          WASM_NOTIFICATION_HISTORY_LIMIT,
        ),
        diagnosticLog: recentEntries(
          typedEnvelope.history.diagnosticLog ?? [],
          DIAGNOSTIC_LOG_LIMIT,
        ),
      },
      myRunningBalance: parseDecimalString(save.myRunningBalance, 'myRunningBalance'),
    }),
  );
  return { model, phase: typedEnvelope.phase, save: typedEnvelope };
}

export function validateSessionSaveEnvelope(save: unknown): void {
  decodeSessionSaveEnvelope(save);
}

export function sessionModelFromSave(save: SessionSave): SessionModel {
  return decodeSessionSaveEnvelope(save).model;
}
