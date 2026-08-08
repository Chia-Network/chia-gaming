import type { ChannelStatus } from '../../types/ChiaGaming';
import type { SessionSave } from '../../hooks/save';
import {
  decodePersistedGameState,
  decodePersistedGameTerms,
  encodeGameTermsExtras,
  isRegisteredGameType,
  persistedGameStateIds,
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

export const SESSION_SAVE_ENVELOPE_VERSION = 11n;

function parseBigintString(value: string | undefined, fallback: bigint): bigint {
  if (!value) return fallback;
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
}

function parsePositiveBigintString(value: string | undefined, fallback: bigint): bigint {
  const parsed = parseBigintString(value, fallback);
  return parsed > 0n ? parsed : fallback;
}

function requireBigintString(value: string | undefined, label: string): bigint {
  if (!value) throw new Error(`Garbled save: missing ${label}`);
  try {
    return BigInt(value);
  } catch {
    throw new Error(`Garbled save: invalid ${label}: ${value}`);
  }
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

function parseTermsSnapshot(
  saved: SavedHandTerms | null | undefined,
  fallback: HandTermsModel,
): HandTermsModel {
  if (!saved) return fallback;
  const gameType = saved.game_type ?? fallback.gameType;
  if (!isRegisteredGameType(gameType)) {
    throw new Error(`Garbled save: unknown game type ${gameType}`);
  }
  const myContribution = parseBigintString(saved.my_contribution, fallback.myContribution);
  const terms = decodePersistedGameTerms(
    gameType,
    {
      myContribution,
      theirContribution: parseBigintString(saved.their_contribution, fallback.theirContribution),
      gameTimeout: parsePositiveBigintString(saved.game_timeout, fallback.gameTimeout),
    },
    { spacepoker_unit_size: saved.spacepoker_unit_size },
  );
  if (!terms) throw new Error(`Garbled save: invalid ${gameType} terms`);
  return terms;
}

function parseOptionalTermsSnapshot(
  saved: SavedHandTerms | null | undefined,
  fallback: HandTermsModel,
): HandTermsModel | null {
  return saved ? parseTermsSnapshot(saved, fallback) : null;
}

function parseProposalSnapshot(
  saved: SavedProposal | null | undefined,
  fallbackTerms: HandTermsModel,
): BetweenHandProposalModel | null {
  if (!saved) return null;
  if (!Array.isArray(saved.groupIds) || saved.groupIds.length === 0) {
    throw new Error(`Garbled save: proposal ${saved.id} missing non-empty groupIds`);
  }
  return {
    id: saved.id,
    groupIds: saved.groupIds,
    terms: parseTermsSnapshot(saved, fallbackTerms),
  };
}

function parseNotificationId(id: unknown): bigint {
  if (typeof id === 'bigint') return id;
  if (typeof id === 'number' && Number.isInteger(id)) return BigInt(id);
  if (typeof id === 'string') {
    try {
      return BigInt(id);
    } catch {
      throw new Error(`Garbled save: invalid notification id: ${id}`);
    }
  }
  throw new Error(`Garbled save: missing notification id`);
}

function parseQueuedNotifications(queue: unknown): QueuedNotificationModel[] {
  if (!Array.isArray(queue)) return [];
  return queue.map((notification) => {
    const n = notification as QueuedNotificationModel & { id?: unknown };
    return {
      ...n,
      id: parseNotificationId(n.id),
    };
  });
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
  try {
    if (BigInt(instance.amount) < 0n) throw new Error();
  } catch {
    throw new Error(`Garbled save: invalid gameInstances.${key}.amount: ${instance.amount}`);
  }
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

function requireUniqueIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && id.length > 0)) {
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
      return BigInt(value) >= 0n;
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

export function validateSessionSaveEnvelope(save: SessionSave): void {
  if (save.version !== SESSION_SAVE_ENVELOPE_VERSION) {
    throw new Error(`Garbled save: unsupported version ${String(save.version)}`);
  }
  if (typeof save.playerId !== 'string' || save.playerId.length === 0) {
    throw new Error('Garbled save: invalid playerId');
  }

  const activeIds = requireUniqueIds(save.activeGameIds ?? [], 'activeGameIds');
  const currentHandIds = requireUniqueIds(save.currentHandGameIds ?? [], 'currentHandGameIds');
  const currentSet = new Set(currentHandIds);
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

  if (save.handState != null) {
    const decodedHandState = decodePersistedGameState(save.handState);
    if (!decodedHandState) throw new Error('Garbled save: invalid handState');
    if (
      typeof save.activeGameType !== 'string' ||
      save.activeGameType !== decodedHandState.gameType
    ) {
      throw new Error('Garbled save: activeGameType does not match handState.gameType');
    }
    const payloadIds = persistedGameStateIds(decodedHandState);
    if (payloadIds === null) throw new Error('Garbled save: invalid handState game IDs');
    for (const id of payloadIds) {
      if (!currentSet.has(id)) {
        throw new Error(`Garbled save: handState references unrelated game ${id}`);
      }
    }
  } else if (
    (activeIds.length > 0 || currentHandIds.length > 0) &&
    (typeof save.activeGameType !== 'string' || save.activeGameType.length === 0)
  ) {
    throw new Error('Garbled save: missing activeGameType');
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
  }
}

export function sessionModelFromSave(save: SessionSave, perGameAmount = 0n): SessionModel {
  validateSessionSaveEnvelope(save);
  const fallbackTerms: HandTermsModel = {
    gameType: 'calpoker',
    myContribution: perGameAmount,
    theirContribution: perGameAmount,
    gameTimeout: DEFAULT_GAME_TIMEOUT_BLOCKS,
  };
  const lastTerms = parseTermsSnapshot(save.betweenHandLastTerms, fallbackTerms);
  const activeIds = save.activeGameIds ?? [];
  if (!Array.isArray(activeIds)) {
    throw new Error('Garbled save: invalid activeGameIds');
  }
  if (!activeIds.every((id) => typeof id === 'string')) {
    throw new Error('Garbled save: activeGameIds must contain strings');
  }
  const restoredActiveIds = [...activeIds];
  const savedCurrentHandIds = save.currentHandGameIds ?? restoredActiveIds;
  if (!Array.isArray(savedCurrentHandIds)) {
    throw new Error('Garbled save: invalid currentHandGameIds');
  }
  const currentHandIds = [...savedCurrentHandIds];
  if (!currentHandIds.every((id) => typeof id === 'string')) {
    throw new Error('Garbled save: currentHandGameIds must contain strings');
  }
  const instances: Record<string, GameInstanceModel> = Object.fromEntries(
    Object.entries(save.gameInstances ?? {}).map(([id, instance]) => [
      id,
      parseSavedGameInstance(id, instance),
    ]),
  );
  for (const id of new Set([
    ...restoredActiveIds,
    ...currentHandIds,
    ...(save.lastDisplayedGameId === undefined ? [] : [save.lastDisplayedGameId]),
  ])) {
    if (!instances[id]) {
      throw new Error(`Garbled save: game ${id} is missing its keyed instance`);
    }
  }
  const lastDisplayedId =
    save.lastDisplayedGameId ??
    restoredActiveIds[0] ??
    currentHandIds[0] ??
    Object.keys(instances)[0] ??
    null;
  const handState =
    save.handState == null
      ? null
      : (() => {
          const decoded = decodePersistedGameState(save.handState);
          if (!decoded) throw new Error('Garbled save: invalid handState');
          return decoded;
        })();

  return normalizeSessionPresentation(
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
      betweenHand: (() => {
        const mode = (save.betweenHandMode as BetweenHandModeModel | undefined) ?? 'decision';
        const outgoingProposalTerms = save.outgoingProposalTerms
          ? Object.fromEntries(
              Object.entries(save.outgoingProposalTerms).map(([id, saved]) => [
                id,
                parseTermsSnapshot(saved, lastTerms),
              ]),
            )
          : {};
        if (
          Object.keys(outgoingProposalTerms).length > 0 &&
          save.outgoingProposalGroupIds === undefined
        ) {
          throw new Error('Garbled save: outgoing proposal terms missing group IDs');
        }
        const outgoingProposalGroupIds = (save.outgoingProposalGroupIds ?? []).map(
          (groupIds, index) => {
            if (!Array.isArray(groupIds) || groupIds.length === 0) {
              throw new Error(`Garbled save: outgoing proposal group ${index} missing IDs`);
            }
            return [...groupIds];
          },
        );
        const groupedOutgoingIds = outgoingProposalGroupIds.flat();
        const outgoingProposalIds = [
          ...groupedOutgoingIds,
          ...Object.keys(outgoingProposalTerms).filter((id) => !groupedOutgoingIds.includes(id)),
        ];
        const hasOutgoing = outgoingProposalIds.length > 0;
        const acceptedProposalGroupIds = (save.acceptedProposalGroupIds ?? []).map(
          (groupIds, index) => {
            if (!Array.isArray(groupIds) || groupIds.length === 0) {
              throw new Error(`Garbled save: accepted proposal group ${index} missing IDs`);
            }
            return [...groupIds];
          },
        );
        return {
          mode,
          cachedPeerProposal: parseProposalSnapshot(save.betweenHandCachedPeerProposal, lastTerms),
          reviewPeerProposal: parseProposalSnapshot(save.betweenHandReviewPeerProposal, lastTerms),
          rejectedOnceTerms: parseOptionalTermsSnapshot(
            save.betweenHandRejectedOnceTerms,
            lastTerms,
          ),
          pendingRetryTerms: parseOptionalTermsSnapshot(
            save.betweenHandPendingRetryTerms,
            lastTerms,
          ),
          lastTerms,
          composePerHandAmount: parseBigintString(save.betweenHandComposePerHand, perGameAmount),
          composeGameTimeout: parsePositiveBigintString(
            save.betweenHandComposeGameTimeout,
            lastTerms.gameTimeout,
          ),
          composeGameType: isRegisteredGameType(save.betweenHandComposeGameType)
            ? save.betweenHandComposeGameType
            : lastTerms.gameType,
          composeProposalSent: hasOutgoing && mode === 'compose-proposal',
          newHandRequested: hasOutgoing && mode === 'decision',
          outgoingProposalIds,
          outgoingProposalGroupIds,
          acceptedProposalGroupIds,
          outgoingProposalTerms,
        };
      })(),
      history: {
        humanHistory: recentEntries(save.humanHistory ?? [], HUMAN_HISTORY_LIMIT),
        wasmNotificationHistory: recentEntries(
          save.wasmNotificationHistory ?? [],
          WASM_NOTIFICATION_HISTORY_LIMIT,
        ),
        diagnosticLog: recentEntries(save.diagnosticLog ?? [], DIAGNOSTIC_LOG_LIMIT),
      },
      myRunningBalance: parseBigintString(save.myRunningBalance, 0n),
      lastOutcomeWin: save.lastOutcomeWin,
    }),
  );
}

export function snapshotFromSessionModel(model: SessionModel): Partial<SessionSave> {
  const termsSnapshot = (terms: HandTermsModel) => ({
    my_contribution: terms.myContribution.toString(),
    their_contribution: terms.theirContribution.toString(),
    game_timeout: terms.gameTimeout.toString(),
    game_type: terms.gameType,
    ...encodeGameTermsExtras(terms),
  });

  const persistedGameIds = Array.from(
    new Set([
      ...model.game.activeIds,
      ...model.game.currentHandIds,
      ...(model.game.lastDisplayedId === null ? [] : [model.game.lastDisplayedId]),
    ]),
  );
  for (const id of persistedGameIds) {
    if (!model.game.instances[id]) {
      throw new Error(`Session invariant broken: game ${id} is missing its keyed instance`);
    }
  }

  return {
    humanHistory:
      model.history.humanHistory.length > 0
        ? recentEntries(model.history.humanHistory, HUMAN_HISTORY_LIMIT)
        : undefined,
    wasmNotificationHistory:
      model.history.wasmNotificationHistory.length > 0
        ? recentEntries(model.history.wasmNotificationHistory, WASM_NOTIFICATION_HISTORY_LIMIT)
        : undefined,
    diagnosticLog:
      model.history.diagnosticLog.length > 0
        ? recentEntries(model.history.diagnosticLog, DIAGNOSTIC_LOG_LIMIT)
        : undefined,
    activeGameIds: model.game.activeIds,
    activeGameType: model.game.activeGameType,
    handState: model.game.handState,
    currentHandGameIds:
      model.game.currentHandIds.length > 0 ? model.game.currentHandIds : undefined,
    lastDisplayedGameId: model.game.lastDisplayedId ?? undefined,
    gameInstances:
      persistedGameIds.length > 0
        ? Object.fromEntries(
            persistedGameIds.map((id) => {
              const instance = model.game.instances[id];
              return [
                id,
                {
                  id: instance.id,
                  amount: instance.amount,
                  coinHex: instance.coinHex,
                  presentation: instance.presentation,
                  terminal: instance.terminal,
                },
              ];
            }),
          )
        : undefined,
    myRunningBalance: model.myRunningBalance !== 0n ? model.myRunningBalance.toString() : undefined,
    channelNotifQueue:
      model.channel.queue.length > 0
        ? model.channel.queue.map(({ id, kind, title, message }) => ({ id, kind, title, message }))
        : undefined,
    gameNotifQueue:
      model.game.queue.length > 0
        ? model.game.queue.map(({ id, kind, title, message }) => ({ id, kind, title, message }))
        : undefined,
    dismissedChannelStatus: model.channel.dismissedChannelStatus ?? undefined,
    cleanShutdownStarted: model.channel.cleanShutdownStarted || undefined,
    betweenHandMode: model.betweenHand.mode,
    betweenHandComposePerHand: model.betweenHand.composePerHandAmount.toString(),
    betweenHandComposeGameTimeout: model.betweenHand.composeGameTimeout.toString(),
    betweenHandComposeGameType: model.betweenHand.composeGameType,
    betweenHandLastTerms: termsSnapshot(model.betweenHand.lastTerms),
    betweenHandRejectedOnceTerms: model.betweenHand.rejectedOnceTerms
      ? termsSnapshot(model.betweenHand.rejectedOnceTerms)
      : undefined,
    betweenHandPendingRetryTerms: model.betweenHand.pendingRetryTerms
      ? termsSnapshot(model.betweenHand.pendingRetryTerms)
      : undefined,
    betweenHandCachedPeerProposal: model.betweenHand.cachedPeerProposal
      ? {
          id: model.betweenHand.cachedPeerProposal.id,
          groupIds: model.betweenHand.cachedPeerProposal.groupIds,
          ...termsSnapshot(model.betweenHand.cachedPeerProposal.terms),
        }
      : undefined,
    betweenHandReviewPeerProposal: model.betweenHand.reviewPeerProposal
      ? {
          id: model.betweenHand.reviewPeerProposal.id,
          groupIds: model.betweenHand.reviewPeerProposal.groupIds,
          ...termsSnapshot(model.betweenHand.reviewPeerProposal.terms),
        }
      : undefined,
    outgoingProposalGroupIds:
      model.betweenHand.outgoingProposalGroupIds.length > 0
        ? model.betweenHand.outgoingProposalGroupIds.map((groupIds) => [...groupIds])
        : undefined,
    acceptedProposalGroupIds:
      model.betweenHand.acceptedProposalGroupIds.length > 0
        ? model.betweenHand.acceptedProposalGroupIds.map((groupIds) => [...groupIds])
        : undefined,
    outgoingProposalTerms:
      Object.keys(model.betweenHand.outgoingProposalTerms).length > 0
        ? Object.fromEntries(
            Object.entries(model.betweenHand.outgoingProposalTerms).map(([id, terms]) => [
              id,
              termsSnapshot(terms),
            ]),
          )
        : undefined,
  };
}
