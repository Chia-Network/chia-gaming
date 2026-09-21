import { isDenseNumericByteObject } from '../reactPropSafe';
import {
  HUMAN_HISTORY_LIMIT,
  recentDiagnosticEntries,
  recentEntries,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from './historyLimits';
import {
  SESSION_SAVE_SCHEMA,
  SESSION_SAVE_VERSION,
  type LiveSessionSave,
  type PreHandshakeSessionSave,
  type SessionHistorySave,
  type SessionIdentitySave,
  type SessionPairingSave,
  type SessionPreferencesSave,
  type SessionPresentationSave,
  type SessionSave,
  type SessionTransportSave,
  type TerminalSessionSave,
} from './saveEnvelope';
import { decodeSessionSaveEnvelope } from './persistence';
import type { WalletProviderScope } from '../../types/ChiaGaming';

export type CommonSaveFields = Pick<SessionSave, 'identity' | 'preferences' | 'history'>;
export type CommonSessionPatch = {
  identity?: Partial<SessionIdentitySave>;
  preferences?: Partial<SessionPreferencesSave>;
  history?: Partial<SessionHistorySave>;
};
export type SessionStateUpdate =
  | {
      scope: 'common';
      identity?: Partial<SessionIdentitySave>;
      preferences?: Partial<SessionPreferencesSave>;
      history?: Partial<SessionHistorySave>;
    }
  | {
      scope: 'live';
      walletProviderScope: WalletProviderScope;
      pairing: SessionPairingSave;
      live: LiveSessionSave['live'];
      presentation: SessionPresentationSave;
      history?: Partial<SessionHistorySave>;
    };
export interface SessionReplacement {
  walletProviderScope: WalletProviderScope;
  pairing: SessionPairingSave;
  transport: SessionTransportSave;
  identity?: Partial<SessionIdentitySave>;
  history?: Partial<SessionHistorySave>;
}
export interface TerminalFields {
  walletProviderScope: WalletProviderScope;
  terminal: TerminalSessionSave['terminal'];
  presentation: SessionPresentationSave;
}
export interface PreservedSessionCheckpoint {
  walletProviderScope: WalletProviderScope;
  pairing: SessionPairingSave;
  transport: SessionTransportSave;
}

export function isDurableSession(
  state: SessionSave | null,
): state is Exclude<SessionSave, { phase: 'preferences' }> {
  return state !== null && state.phase !== 'preferences';
}

export function decodeCurrentSession(state: unknown): SessionSave | null {
  try {
    return decodeSessionSaveEnvelope(state).save;
  } catch {
    return null;
  }
}

export function commonSaveFields(state: SessionSave): CommonSaveFields {
  return {
    identity: structuredClone(state.identity),
    preferences: structuredClone(state.preferences),
    history: structuredClone(state.history),
  };
}

export function freshSessionState(previous: SessionSave): SessionSave {
  return {
    schema: SESSION_SAVE_SCHEMA,
    version: SESSION_SAVE_VERSION,
    phase: 'preferences',
    ...commonSaveFields(previous),
  };
}

export function capSessionHistories<T extends SessionSave>(state: T): T {
  const next = structuredClone(state);
  if (next.history.humanHistory) {
    next.history.humanHistory = recentEntries(next.history.humanHistory, HUMAN_HISTORY_LIMIT);
  }
  if (next.history.wasmNotificationHistory) {
    next.history.wasmNotificationHistory = recentEntries(
      next.history.wasmNotificationHistory,
      WASM_NOTIFICATION_HISTORY_LIMIT,
    );
  }
  if (next.history.diagnosticLog) {
    next.history.diagnosticLog = recentDiagnosticEntries(next.history.diagnosticLog);
  }
  return next;
}

export function assertPersistableSession(obj: unknown, path = 'SessionSave'): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'number') {
    throw new Error(`[save] BUG: found number where bigint expected at "${path}" (value=${obj})`);
  }
  if (ArrayBuffer.isView(obj) || typeof obj !== 'object') return;
  if (!Array.isArray(obj) && isDenseNumericByteObject(obj)) {
    throw new Error(
      `[save] BUG: degraded numeric-keyed byte object at "${path}" (refusing to persist)`,
    );
  }
  if (Array.isArray(obj)) {
    obj.forEach((entry, index) => assertPersistableSession(entry, `${path}[${index}]`));
    return;
  }
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    assertPersistableSession((obj as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

export function mergeClaimedSession(
  record: SessionSave | null,
  fallback: SessionSave,
  patch: CommonSessionPatch,
): SessionSave {
  const base = record ?? fallback;
  return capSessionHistories({
    ...base,
    identity: { ...base.identity, ...patch.identity },
    preferences: { ...base.preferences, ...patch.preferences },
    history: { ...base.history, ...patch.history },
  });
}

export function mergeDurableSession(record: SessionSave, memory: SessionSave): SessionSave {
  if (!isDurableSession(record)) {
    return {
      ...memory,
      identity: {
        playerId: memory.identity.playerId || record.identity.playerId,
        sessionId: memory.identity.sessionId || record.identity.sessionId,
        myHubPlayerId: memory.identity.myHubPlayerId || record.identity.myHubPlayerId,
      },
    };
  }
  return capSessionHistories({
    ...record,
    identity: {
      playerId: memory.identity.playerId || record.identity.playerId,
      sessionId: memory.identity.sessionId || record.identity.sessionId,
      myHubPlayerId: memory.identity.myHubPlayerId || record.identity.myHubPlayerId,
    },
    preferences: {
      ...record.preferences,
      ...definedEntries(memory.preferences),
    },
    history: {
      humanHistory: memory.history.humanHistory ?? record.history.humanHistory,
      diagnosticLog: memory.history.diagnosticLog ?? record.history.diagnosticLog,
      wasmNotificationHistory:
        memory.history.wasmNotificationHistory ?? record.history.wasmNotificationHistory,
    },
  });
}

export function mergeInspectedSession(
  record: SessionSave,
  local: SessionSave,
  patch: CommonSessionPatch,
): SessionSave {
  const merged = mergeClaimedSession(record, local, patch);
  return {
    ...merged,
    identity: {
      playerId: local.identity.playerId || record.identity.playerId,
      sessionId: local.identity.sessionId || record.identity.sessionId,
      myHubPlayerId: local.identity.myHubPlayerId || record.identity.myHubPlayerId,
    },
    preferences: {
      ...record.preferences,
      ...definedEntries(local.preferences),
      ...patch.preferences,
    },
  };
}

export function applySessionUpdate(state: SessionSave, update: SessionStateUpdate): SessionSave {
  if (update.scope === 'common') {
    return capSessionHistories({
      ...state,
      identity: { ...state.identity, ...update.identity },
      preferences: { ...state.preferences, ...update.preferences },
      history: { ...state.history, ...update.history },
    });
  }
  const common = commonSaveFields(state);
  return capSessionHistories({
    schema: SESSION_SAVE_SCHEMA,
    version: SESSION_SAVE_VERSION,
    phase: 'live',
    ...common,
    walletProviderScope: structuredClone(update.walletProviderScope),
    pairing: structuredClone(update.pairing),
    live: structuredClone(update.live),
    presentation: structuredClone(update.presentation),
    history: { ...common.history, ...update.history },
  });
}

export function patchSessionTransport(
  state: SessionSave,
  transport: SessionTransportSave,
): SessionSave {
  if (state.phase === 'pre-handshake') {
    return { ...state, transport: structuredClone(transport) };
  }
  if (state.phase === 'live') {
    return { ...state, live: { ...state.live, ...structuredClone(transport) } };
  }
  throw new Error(`Cannot patch session transport while session phase is ${state.phase}`);
}

export function clearSessionPeer(state: SessionSave): SessionSave {
  if (state.phase !== 'live' && state.phase !== 'pre-handshake') return state;
  return { ...state, pairing: { ...state.pairing, peerId: undefined } };
}

export function createPreHandshakeSession(
  state: SessionSave,
  checkpoint: SessionReplacement,
): PreHandshakeSessionSave {
  const common = commonSaveFields(state);
  return capSessionHistories({
    schema: SESSION_SAVE_SCHEMA,
    version: SESSION_SAVE_VERSION,
    phase: 'pre-handshake',
    ...common,
    identity: { ...common.identity, ...checkpoint.identity },
    history: { ...common.history, ...checkpoint.history },
    walletProviderScope: structuredClone(checkpoint.walletProviderScope),
    pairing: structuredClone(checkpoint.pairing),
    transport: structuredClone(checkpoint.transport),
  });
}

export function createTerminalSession(
  state: SessionSave,
  fields: TerminalFields,
): TerminalSessionSave {
  return capSessionHistories({
    schema: SESSION_SAVE_SCHEMA,
    version: SESSION_SAVE_VERSION,
    phase: 'terminal',
    ...commonSaveFields(state),
    walletProviderScope: structuredClone(fields.walletProviderScope),
    terminal: structuredClone(fields.terminal),
    presentation: structuredClone(fields.presentation),
  });
}

export function preservationCheckpoint(state: SessionSave): PreservedSessionCheckpoint | null {
  if (state.phase === 'pre-handshake') {
    return {
      walletProviderScope: structuredClone(state.walletProviderScope),
      pairing: structuredClone(state.pairing),
      transport: structuredClone(state.transport),
    };
  }
  if (state.phase !== 'live') return null;
  return {
    walletProviderScope: structuredClone(state.walletProviderScope),
    pairing: structuredClone(state.pairing),
    transport: {
      messageNumber: state.live.messageNumber,
      remoteNumber: state.live.remoteNumber,
      unackedMessages: structuredClone(state.live.unackedMessages),
      disposition: state.live.disposition,
      terminalHandoff: structuredClone(state.live.terminalHandoff),
    },
  };
}

export function commonPatch(before: SessionSave, after: SessionSave): CommonSessionPatch {
  return {
    identity: changedFields(before.identity, after.identity),
    preferences: changedFields(before.preferences, after.preferences),
    history: changedFields(before.history, after.history),
  };
}

function changedFields<T extends object>(before: T, after: T): Partial<T> {
  return Object.fromEntries(
    Object.keys(after).flatMap((key) =>
      comparable(before[key as keyof T]) === comparable(after[key as keyof T])
        ? []
        : [[key, structuredClone(after[key as keyof T])]],
    ),
  ) as Partial<T>;
}

function comparable(value: unknown): string | undefined {
  return JSON.stringify(value, (_name, entry) => (typeof entry === 'bigint' ? `${entry}n` : entry));
}

function definedEntries<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
