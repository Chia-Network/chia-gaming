import type { ChannelStatus, ChannelStatusPayload } from '../../types/ChiaGaming';
import type {
  LiveSessionSave,
  PreHandshakeSessionSave,
  PreferencesSessionSave,
  SavedHandTerms,
  SessionHistorySave,
  SessionIdentitySave,
  SessionPairingSave,
  SessionPreferencesSave,
  SessionPresentationSave,
  SessionSave,
  TerminalSessionSave,
} from './saveEnvelope';
import { SESSION_SAVE_SCHEMA, SESSION_SAVE_VERSION } from './saveEnvelope';
import {
  decodePersistedGameState,
  gameHandMembershipDescription,
  isRegisteredGameType,
  validateGameHandMembership,
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
import type { BetweenHandModeModel, HandTermsModel, SessionModel } from './types';
import { isTerminalChannelSnapshot } from './selectors';
import {
  parseComposeDraftState,
  parseOptionalTermsSnapshot,
  parseProposalGroups,
  parseTermsSnapshot,
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
} from './persistencePayloads';
import {
  optionalString,
  parseDecimalString,
  parseDiscriminant,
  requireBigintString,
  requireBigint,
  requireBoolean,
  requireNullableString,
  requireRecord,
  requireString,
  requireUniqueIds,
  parseStringArray,
} from './persistencePrimitives';

export { snapshotFromSessionModel } from './sessionSnapshot';

export const SESSION_SAVE_ENVELOPE_VERSION = SESSION_SAVE_VERSION;

function parseIdentity(value: unknown): SessionIdentitySave {
  const fields = requireRecord(value, 'identity');
  return {
    playerId: requireString(fields.playerId, 'identity.playerId'),
    sessionId: optionalString(fields.sessionId, 'identity.sessionId'),
    myHubPlayerId: optionalString(fields.myHubPlayerId, 'identity.myHubPlayerId'),
  };
}

function parsePreferences(value: unknown): SessionPreferencesSave {
  const fields = requireRecord(value, 'preferences');
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
      : parseDiscriminant<'simulator' | 'walletconnect'>(
          fields.blockchainType,
          new Set(['simulator', 'walletconnect']),
          'preferences.blockchainType',
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
  };
}

function parseHistory(value: unknown): SessionHistorySave {
  const fields = requireRecord(value, 'history');
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
  const pairing: SessionPairingSave = {
    token: requireString(fields.token, 'pairing.token'),
    peerId: optionalString(fields.peerId, 'pairing.peerId'),
    gameSessionId: optionalString(fields.gameSessionId, 'pairing.gameSessionId'),
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

function parseLive(value: unknown): LiveSessionSave['live'] {
  const fields = requireRecord(value, 'live');
  if (!Array.isArray(fields.unackedMessages)) {
    throw new Error('Garbled save: invalid live.unackedMessages');
  }
  const live: LiveSessionSave['live'] = {
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
    messageNumber: requireBigint(fields.messageNumber, 'live.messageNumber'),
    remoteNumber: requireBigint(fields.remoteNumber, 'live.remoteNumber'),
    unackedMessages: fields.unackedMessages.map((message, index) => {
      const record = requireRecord(message, `live.unackedMessages[${index}]`);
      if (!(record.msg instanceof Uint8Array)) {
        throw new Error(`Garbled save: invalid live.unackedMessages[${index}].msg`);
      }
      return {
        msgno: requireBigint(record.msgno, `live.unackedMessages[${index}].msgno`),
        msg: record.msg,
      };
    }),
    durabilityWarning: optionalString(fields.durabilityWarning, 'live.durabilityWarning', true),
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
          new Set([
            'submitting_channel_spend',
            'resolving_opponent_channel_spend',
            'preempting',
            'waiting_timeout',
            'submitting_timeout_finish',
            'resolving',
          ]),
          'channelStatus.semantic_phase',
        );
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
  };
}

function savedTermsFromModel(terms: HandTermsModel): SavedHandTerms {
  const base = {
    my_contribution: terms.myContribution.toString(),
    their_contribution: terms.theirContribution.toString(),
    game_timeout: terms.gameTimeout.toString(),
  };
  return terms.gameType === 'spacepoker'
    ? {
        ...base,
        game_type: terms.gameType,
        spacepoker_unit_size: terms.unitSizeMojos.toString(),
      }
    : { ...base, game_type: terms.gameType };
}

function initialTermsFromCompose(
  compose: ReturnType<typeof parseComposeDraftState>,
): HandTermsModel {
  const common = { gameTimeout: compose.gameTimeout };
  switch (compose.selectedGame) {
    case 'calpoker':
      return {
        ...common,
        gameType: compose.selectedGame,
        myContribution: compose.calpoker.amount,
        theirContribution: compose.calpoker.amount,
      };
    case 'krunk':
      return {
        ...common,
        gameType: compose.selectedGame,
        myContribution: compose.krunk.amount,
        theirContribution: compose.krunk.amount,
      };
    case 'spacepoker': {
      const contribution = compose.spacepoker.unitSize * compose.spacepoker.stackSize;
      return {
        ...common,
        gameType: compose.selectedGame,
        myContribution: contribution,
        theirContribution: contribution,
        unitSizeMojos: compose.spacepoker.unitSize,
      };
    }
  }
}

function parsePresentation(value: unknown): SessionPresentationSave {
  const fields = requireRecord(value, 'presentation');
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
  if (!isRegisteredGameType(fields.activeGameType)) {
    throw new Error(`Garbled save: invalid activeGameType ${String(fields.activeGameType)}`);
  }
  const decodedHandState =
    fields.handState === null ? null : decodePersistedGameState(fields.handState);
  if (fields.handState !== null && decodedHandState === null) {
    throw new Error('Garbled save: invalid handState');
  }
  const lastOutcomeWin =
    fields.lastOutcomeWin === null
      ? null
      : parseDiscriminant<'win' | 'lose' | 'tie'>(
          fields.lastOutcomeWin,
          new Set(['win', 'lose', 'tie']),
          'lastOutcomeWin',
        );
  const dismissedChannelStatus =
    fields.dismissedChannelStatus === null
      ? null
      : parseDiscriminant<ChannelStatus>(
          fields.dismissedChannelStatus,
          CHANNEL_STATUSES,
          'dismissedChannelStatus',
        );
  const compose = parseComposeDraftState(fields.betweenHandCompose);
  const lastTerms =
    fields.betweenHandLastTerms === null
      ? null
      : parseTermsSnapshot(fields.betweenHandLastTerms, 'betweenHandLastTerms');
  const rejectedOnceTerms = parseOptionalTermsSnapshot(
    fields.betweenHandRejectedOnceTerms,
    'betweenHandRejectedOnceTerms',
  );
  const pendingRetryTerms = parseOptionalTermsSnapshot(
    fields.betweenHandPendingRetryTerms,
    'betweenHandPendingRetryTerms',
  );
  const proposalGroups = parseProposalGroups(fields.proposalGroups, 'proposalGroups');
  const waitingStateEnteredAt =
    fields.waitingStateEnteredAt === null
      ? null
      : requireBigint(fields.waitingStateEnteredAt, 'waitingStateEnteredAt');
  const cleanShutdownGraceStartedAt =
    fields.cleanShutdownGraceStartedAt === null
      ? null
      : requireBigint(fields.cleanShutdownGraceStartedAt, 'cleanShutdownGraceStartedAt');
  return {
    activeGameIds,
    currentHandGameIds,
    currentHandOrigin,
    lastDisplayedGameId,
    gameInstances,
    activeGameType: fields.activeGameType,
    handState: decodedHandState?.persisted ?? null,
    channelStatus: decodeChannelStatusPayload(fields.channelStatus),
    lastOutcomeWin,
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
    betweenHandCompose: {
      selected_game: compose.selectedGame,
      game_timeout: compose.gameTimeout.toString(),
      proposal_sent: compose.proposalSent,
      calpoker: { amount: compose.calpoker.amount.toString() },
      krunk: { amount: compose.krunk.amount.toString() },
      spacepoker: {
        unit_size: compose.spacepoker.unitSize.toString(),
        stack_size: compose.spacepoker.stackSize.toString(),
      },
    },
    betweenHandLastTerms: lastTerms === null ? null : savedTermsFromModel(lastTerms),
    betweenHandRejectedOnceTerms:
      rejectedOnceTerms === null ? null : savedTermsFromModel(rejectedOnceTerms),
    betweenHandPendingRetryTerms:
      pendingRetryTerms === null ? null : savedTermsFromModel(pendingRetryTerms),
    proposalGroups: proposalGroups.map((group) => ({
      primary_id: group.primaryId,
      member_ids: group.memberIds,
      origin: group.origin,
      disposition: group.disposition,
      terms: savedTermsFromModel(group.terms),
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

export interface ParsedSessionSaveV12 {
  model: SessionModel;
  phase: SessionSave['phase'];
  save: SessionSave;
}

export function decodeSessionSaveEnvelope(value: unknown): ParsedSessionSaveV12 {
  const envelope = requireRecord(value, 'session envelope');
  if (envelope.schema !== SESSION_SAVE_SCHEMA) {
    throw new Error(`Garbled save: unsupported schema ${String(envelope.schema)}`);
  }
  if (envelope.version !== SESSION_SAVE_ENVELOPE_VERSION) {
    throw new Error(`Garbled save: unsupported version ${String(envelope.version)}`);
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
      if (
        envelope.pairing !== undefined ||
        envelope.live !== undefined ||
        envelope.presentation !== undefined ||
        envelope.terminal !== undefined
      ) {
        throw new Error('Garbled save: unexpected preferences phase payload');
      }
      typedEnvelope = { ...common, phase: 'preferences' } satisfies PreferencesSessionSave;
      break;
    case 'pre-handshake':
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
      } satisfies PreHandshakeSessionSave;
      break;
    case 'live':
      if (envelope.terminal !== undefined) {
        throw new Error('Garbled save: unexpected live phase payload');
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
      if (envelope.pairing !== undefined || envelope.live !== undefined) {
        throw new Error('Garbled save: unexpected terminal phase payload');
      }
      const terminal = requireRecord(envelope.terminal, 'terminal');
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
            return {
              label: requireString(fields.label, `terminal.coinsOfInterest[${index}].label`),
              id: requireString(fields.id, `terminal.coinsOfInterest[${index}].id`),
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
  if (typedEnvelope.phase === 'live' && isTerminalChannelSnapshot(save.channelStatus)) {
    throw new Error('Garbled save: live phase cannot contain a terminal channelStatus');
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
  if (
    currentHandIds.length > 0 &&
    isRegisteredGameType(save.activeGameType) &&
    !validateGameHandMembership(save.activeGameType, currentHandIds, handState)
  ) {
    throw new Error(
      `Garbled save: ${save.activeGameType} requires ${gameHandMembershipDescription(save.activeGameType)}`,
    );
  }

  const compose = parseComposeDraftState(save.betweenHandCompose);
  const lastTerms =
    save.betweenHandLastTerms === null
      ? initialTermsFromCompose(compose)
      : parseTermsSnapshot(save.betweenHandLastTerms, 'betweenHandLastTerms');
  const hasPersistedHand = activeIds.length > 0 || currentHandIds.length > 0 || handState !== null;
  if (hasPersistedHand && save.betweenHandLastTerms === null) {
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
  const lastDisplayedId = save.lastDisplayedGameId;
  const mode = save.betweenHandMode;
  const proposalGroups = parseProposalGroups(save.proposalGroups, 'proposalGroups');
  const hasOutgoing = proposalGroups.some((group) => group.disposition === 'outgoing');
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
        handKey:
          restoredActiveIds.length > 0 || save.handState || save.betweenHandLastTerms ? 1 : 0,
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
        proposalGroups,
        rejectedOnceTerms: parseOptionalTermsSnapshot(
          save.betweenHandRejectedOnceTerms,
          'betweenHandRejectedOnceTerms',
        ),
        pendingRetryTerms: parseOptionalTermsSnapshot(
          save.betweenHandPendingRetryTerms,
          'betweenHandPendingRetryTerms',
        ),
        lastTerms,
        compose,
        newHandRequested: hasOutgoing && mode === 'decision',
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
      lastOutcomeWin: save.lastOutcomeWin ?? undefined,
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
