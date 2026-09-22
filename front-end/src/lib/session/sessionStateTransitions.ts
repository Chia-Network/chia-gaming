import {
  HUMAN_HISTORY_LIMIT,
  recentDiagnosticEntries,
  recentEntries,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from './historyLimits';
import {
  type DurableApplicationState,
  type SessionHistorySave,
  type SessionIdentitySave,
  type SessionPreferencesSave,
  type SessionTransportSave,
  type PreHandshakeSessionSave,
} from './saveEnvelope';
export type CommonSessionPatch = {
  identity?: Partial<SessionIdentitySave>;
  preferences?: Partial<SessionPreferencesSave>;
  history?: Partial<SessionHistorySave>;
};
export function freshSessionState(previous: DurableApplicationState): DurableApplicationState {
  return { ...previous, session: null };
}

export function capSessionHistories<T extends DurableApplicationState>(state: T): T {
  return {
    ...state,
    history: {
      ...state.history,
      humanHistory: state.history.humanHistory
        ? recentEntries(state.history.humanHistory, HUMAN_HISTORY_LIMIT)
        : undefined,
      wasmNotificationHistory: state.history.wasmNotificationHistory
        ? recentEntries(state.history.wasmNotificationHistory, WASM_NOTIFICATION_HISTORY_LIMIT)
        : undefined,
      diagnosticLog: state.history.diagnosticLog
        ? recentDiagnosticEntries(state.history.diagnosticLog)
        : undefined,
    },
  };
}

export function mergeClaimedSession(
  record: DurableApplicationState | null,
  fallback: DurableApplicationState,
  patch: CommonSessionPatch,
): DurableApplicationState {
  const base = record ?? fallback;
  return capSessionHistories({
    ...base,
    identity: { ...base.identity, ...patch.identity },
    preferences: { ...base.preferences, ...patch.preferences },
    history: { ...base.history, ...patch.history },
  });
}

export function applyCommonPatch(
  state: DurableApplicationState,
  patch: CommonSessionPatch,
): DurableApplicationState {
  return capSessionHistories({
    ...state,
    identity: { ...state.identity, ...patch.identity },
    preferences: { ...state.preferences, ...patch.preferences },
    history: { ...state.history, ...patch.history },
  });
}

export function patchSessionTransport(
  state: DurableApplicationState,
  transport: SessionTransportSave,
): DurableApplicationState {
  if (state.session?.phase === 'pre-handshake') {
    return {
      ...state,
      session: { ...state.session, transport: structuredClone(transport) },
    };
  }
  if (state.session?.phase === 'live') {
    return {
      ...state,
      session: {
        ...state.session,
        live: { ...state.session.live, ...structuredClone(transport) },
      },
    };
  }
  throw new Error(
    `Cannot patch session transport while session phase is ${String(state.session?.phase)}`,
  );
}

export function clearSessionPeer(state: DurableApplicationState): DurableApplicationState {
  if (state.session?.phase !== 'live' && state.session?.phase !== 'pre-handshake') return state;
  return {
    ...state,
    session: {
      ...state.session,
      pairing: { ...state.session.pairing, peerId: undefined },
    },
  };
}

function preservationCheckpoint(state: DurableApplicationState): PreHandshakeSessionSave | null {
  if (state.session?.phase === 'pre-handshake') {
    return state.session;
  }
  if (state.session?.phase !== 'live') return null;
  return {
    phase: 'pre-handshake',
    pairing: state.session.pairing,
    transport: {
      messageNumber: state.session.live.messageNumber,
      remoteNumber: state.session.live.remoteNumber,
      unackedMessages: state.session.live.unackedMessages,
      disposition: state.session.live.disposition,
      terminalHandoff: state.session.live.terminalHandoff,
    },
  };
}

export function clearGameSessionState(
  state: DurableApplicationState,
  history?: Partial<SessionHistorySave>,
): DurableApplicationState {
  const current = applyCommonPatch(state, { history });
  const session = preservationCheckpoint(current);
  return {
    ...current,
    session,
  };
}

export function commonPatch(
  before: DurableApplicationState,
  after: DurableApplicationState,
): CommonSessionPatch {
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
