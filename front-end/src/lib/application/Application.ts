import { AdvisoryStartParams, HubConnection } from '../../services/HubConnection';
import { deriveHubSessionId } from '../../services/hubSessionCredential';
import { log, subscribeLog } from '../../services/log';
import {
  PeerSession,
  decodePeerAppMessage,
  decodeReliableFrame,
  generateSessionId,
} from '../../services/PeerSession';
import {
  CoinOfInterestEntry,
  GameSessionParams,
  HubLiveness,
  PeerConnectionResult,
  PeerLiveness,
  SessionPhase,
} from '../../types/ChiaGaming';
import { isElectronDistribution } from '../../util/distribution';
import { hubTrustError, requestHubTrust } from '../../util/hubTrust';
import {
  acceptedHandNeedsGameTabAttention,
  channelStateNeedsGameTabAttention,
  gameModelNeedsGameTabAttention,
  peerProposalIdNeedsGameTabAttention,
} from '../gameTabAttention';
import { computeHubPresence, type HubPresence } from '../hubPresence';
import {
  isAvailableForNewSessionPrompt as checkAvailableForNewSessionPrompt,
  deferredHubRemapEscalationAction,
  hubPlayerIdRemapAction,
  isRestoreBlocked,
  restoreGateAfterTerminalFinalization,
  sessionLocksNetwork,
  shouldCancelAttemptOnDisconnect,
  shouldCancelOnPeerUnreachable,
  shouldDeferHubRemapEscalation,
  shouldMountGameSession,
  shouldReportSessionPhase,
  shouldSuppressPhaseReporting,
  shouldSwitchToHubOnResolved,
  shouldWarnOnSessionUnload,
  transitionToFreshSession,
} from '../restoreLifecycle';
import {
  applyFreshStartCheckpoint,
  captureFreshStart,
  shouldCompleteAcceptTransition,
  startFailureDisposition,
} from '../session/acceptLifecycle';
import {
  HUMAN_HISTORY_LIMIT,
  appendDiagnosticEntry,
  appendRecent,
  recentDiagnosticEntries,
  recentEntries,
} from '../session/historyLimits';
import { StorageAuthorityLostError, StorageAuthorityRequiredError } from '../session/indexedDb';
import {
  ABANDON_WAITING_STATES,
  DEFAULT_CHANNEL_TIMEOUT_BLOCKS,
  DEFAULT_UNROLL_TIMEOUT_BLOCKS,
  PRE_ACTIVE_CHANNEL_STATES,
  isChannelAbandonable,
  type GameDashboardActionKind,
  type SessionModel,
} from '../session/model';
import {
  isValidSessionAmountString,
  isValidTimeoutString,
  parseOptionalBigInt,
  parseSessionAmount,
  sessionProposalNetworkMatches,
} from '../session/peerSessionParams';
import {
  rehydrateDurableApplicationState,
  type RehydratedDurableApplicationState,
} from '../session/persistence';
import { DEFAULT_SESSION_RECEIVE_POLICY } from '../session/receivePolicy';
import {
  clearSavedSessionMarker,
  markSavedSession,
  releaseLeaseIfOwner,
} from '../session/saveCoordination';
import type { ChiaNetwork } from '../session/saveEnvelope';
import {
  type DurableApplicationState,
  type DurableRejectionTransport,
} from '../session/saveEnvelope';
import { selectGameSessionView } from '../session/selectors';
import { SessionController, RestoreStatus } from '../session/SessionController';
import type {
  SessionFrontend,
  SessionPresentation,
  TerminalSessionPresentation,
} from '../session/sessionFrontend';
import {
  createSessionController,
  configSessionController,
  restoreSession,
} from '../session/sessionHost';
import { clearGameSessionState } from '../session/sessionStateTransitions';
import {
  PendingSessionProposal,
  isAcceptSessionTransition,
  peerConnectionForSavedSession,
  transportSaveFromReliableState,
} from '../session/shellSessionState';
import { storageRepository } from '../session/storageRepository';
import { finalizeTerminalSession } from '../session/terminalFinalization';
import { ensurePeerProtocolLoaded, ensureWasmLoaded } from '../session/wasmLoader';
import { isErrorSettlementOutcome } from '../settlement';
import type { SessionWallet } from '../wallet/sessionWallet';
import { WalletConnection, type WalletEvent, type WalletView } from '../wallet/WalletConnection';
import { createAcceptLifecycle, createShellSessionState } from './applicationSession';
import { Recovery } from './Recovery';
import { createSessionRejection } from './sessionRejection';
type TabId = 'wallet' | 'hub' | 'game' | 'history' | 'log';
type ShellBlockchainType = 'simulator' | 'walletconnect' | 'cloud';
type SessionStartRequest = {
  peerId: string;
  opponentAlias?: string;
  myAmount: string;
  theirAmount: string;
  channel_timeout?: string;
  unroll_timeout?: string;
  iStarted: boolean;
  gameSessionId: string;
};
const IDLE_PEER_CONNECTION: PeerConnectionResult = {
  sendMessage: () => false,
  sendAck: () => false,
  sendKeepalive: () => false,
};
function isAbandonWaitingState(
  state: SessionModel['channel']['status']['state'] | null | undefined,
): state is SessionModel['channel']['status']['state'] {
  return !!state && ABANDON_WAITING_STATES.has(state);
}
function isSessionAbandonable(model: SessionModel | null, abandonEnabled: boolean): boolean {
  return isChannelAbandonable(model?.channel.status, abandonEnabled);
}
function savedChannelStatus(
  save: DurableApplicationState,
): SessionModel['channel']['status']['state'] | null {
  if (
    (save.session?.phase === 'live' || save.session?.phase === 'terminal') &&
    save.session.presentation.channelStatus
  ) {
    return save.session.presentation.channelStatus.state;
  }
  return null;
}
function savedMyAlias(save: DurableApplicationState | null | undefined): string | undefined {
  if (save?.session?.phase === 'live' || save?.session?.phase === 'pre-handshake') {
    return save.session.pairing.myAlias;
  }
  if (save?.session?.phase === 'terminal') return save.session.terminal.myAlias ?? undefined;
  return undefined;
}
function savedOpponentAlias(save: DurableApplicationState | null | undefined): string | undefined {
  if (save?.session?.phase === 'live' || save?.session?.phase === 'pre-handshake') {
    return save.session.pairing.opponentAlias;
  }
  if (save?.session?.phase === 'terminal') return save.session.terminal.opponentAlias ?? undefined;
  return undefined;
}
const GRACE_DELAY_MS = 10_000n;
const ABANDON_DELAY_MS = 120_000n;
export type ApplicationIntent =
  | {
      type:
        | 'resume'
        | 'reset'
        | 'takeover'
        | 'close-tab'
        | 'wallet-cancel'
        | 'wallet-disconnect'
        | 'wallet-reconnect'
        | 'hub-retry'
        | 'hub-disconnect'
        | 'accept-session'
        | 'decline-session'
        | 'toggle-publish'
        | 'confirm'
        | 'cancel-confirmation';
    }
  | { type: 'wallet-connect'; wallet: ShellBlockchainType; fresh?: boolean }
  | { type: 'wallet-finalize'; values?: Record<string, string | bigint> }
  | { type: 'hub-connect'; origin: string }
  | { type: 'tab'; tab: TabId }
  | { type: 'network'; network: ChiaNetwork }
  | { type: 'fee'; fee: bigint }
  | { type: 'fee-unit'; unit: 'mojo' | 'xch' }
  | { type: 'theme'; theme: 'light' | 'dark' }
  | { type: 'session-action'; action: GameDashboardActionKind }
  | { type: 'history'; line: string };
export type Application = ReturnType<typeof createApplication>;
export type ApplicationView = ReturnType<Application['snapshot']>;
export type ApplicationEvent = { type: 'batch-complete'; view: ApplicationView };
export type ApplicationFrontend = Pick<Application, 'snapshot' | 'subscribe' | 'dispatch'>;

export function createApplication() {
  const uniqueId = storageRepository.getPlayerId();
  const walletOwner = new WalletConnection(uniqueId, (event) => batch(() => walletEvents(event)));
  const state: {
    sessionId: string;
    activeTab: TabId;
    transactionPublishNerfed: boolean;
    terminalPresentation: TerminalSessionPresentation | null;
    finishedSessionIdentity: {
      myName: string;
      opponentName?: string;
      iStarted: boolean;
    } | null;
    cleanShutdownGraceActive: boolean;
    abandonEnabled: boolean;
    coins: CoinOfInterestEntry[];
    walletView: WalletView;
    terminalFinalizationBlocker: string | null;
    blockchainReady: boolean;
    hubLiveness: HubLiveness | null;
    peerLiveness: PeerLiveness;
    confirmDialog: {
      title: string;
      body: string;
      confirmLabel?: string;
      onConfirm: () => void;
    } | null;
    history: string[];
    logLines: string[];
    unreadGame: boolean;
    walletAlert: boolean;
    hubAlert: boolean;
    iframeUrl: string;
    defaultFee: bigint;
    feeUnit: 'mojo' | 'xch';
    network: ChiaNetwork;
    hubOrigin: string | null;
    hubConnectionError: string | null;
  } = {
    sessionId: storageRepository.loadState().identity.sessionId ?? '',
    activeTab: (() => {
      const saved = storageRepository.query('activeTab');
      if (saved === 'session') return 'game';
      const valid: TabId[] = ['wallet', 'hub', 'game', 'history', 'log'];
      return saved && valid.includes(saved as TabId) ? (saved as TabId) : 'wallet';
    })(),
    transactionPublishNerfed: false,
    terminalPresentation: null,
    finishedSessionIdentity: null,
    cleanShutdownGraceActive: false,
    abandonEnabled: false,
    coins: [],
    walletView: walletOwner.view,
    terminalFinalizationBlocker: null,
    blockchainReady: false,
    hubLiveness: null,
    peerLiveness: null,
    confirmDialog: null,
    history: [],
    logLines: [],
    unreadGame: storageRepository.query('unreadGame'),
    walletAlert: storageRepository.query('walletAlert'),
    hubAlert: storageRepository.query('hubAlert'),
    iframeUrl: 'about:blank',
    defaultFee: storageRepository.query('defaultFee'),
    feeUnit: storageRepository.query('feeUnit'),
    network: storageRepository.query('network'),
    hubOrigin: null,
    hubConnectionError: null,
  };
  function update<K extends keyof typeof state>(
    key: K,
    value: (typeof state)[K] | ((previous: (typeof state)[K]) => (typeof state)[K]),
  ) {
    const next =
      typeof value === 'function'
        ? (value as (previous: (typeof state)[K]) => (typeof state)[K])(state[key])
        : value;
    if (Object.is(state[key], next)) return;
    state[key] = next;
    publish();
  }
  let sessionController: SessionController | null = null;
  function destroySessionController() {
    sessionController?.cleanup();
    sessionController = null;
  }
  function setTransactionPublishNerf(nerfed: boolean) {
    sessionController?.setTransactionPublishNerfed(nerfed);
    update('transactionPublishNerfed', nerfed);
  }
  let started = false;
  const listeners = new Set<(event: ApplicationEvent) => void>();
  let frontend: SessionFrontend | null = null;
  let sessionPresentation: SessionPresentation | null = null;
  let detachSessionEvents: (() => void) | undefined;
  let sessionLaunchQueued = false;
  let resolvedPhaseReported = false;
  let resolving: Promise<void> | null = null;
  let batchDepth = 0;
  function batch<T>(work: () => T): T {
    batchDepth++;
    try {
      return work();
    } finally {
      batchDepth--;
      if (!batchDepth && dirty) publish();
    }
  }
  let publishing = false;
  let dirty = false;
  function publish() {
    if (!started) return;
    dirty = true;
    if (!sessionLaunchQueued) {
      sessionLaunchQueued = true;
      queueMicrotask(() => {
        sessionLaunchQueued = false;
        if (started) syncSessionExecution();
      });
    }
    if (publishing || batchDepth) return;
    publishing = true;
    try {
      do {
        dirty = false;
        updateAbandonTimer();
        updateRecovery();
        if (
          shouldMountGameSession(
            !!sessions.state.sessionConfig && !!sessions.state.peerConn,
            state.walletView.connected,
            !!sessions.state.sessionConfig?.restoring,
            sessionStarted,
          ).startSession
        )
          sessionStarted = true;
        // Derived changes above are already captured in this batch. Only a
        // listener's reentrant update needs another publication.
        dirty = false;
        const event: ApplicationEvent = { type: 'batch-complete', view: snapshot() };
        for (const listener of listeners) listener(event);
      } while (dirty);
    } finally {
      publishing = false;
    }
  }
  const setActiveTab = (tab: TabId) => {
    update('activeTab', tab);
    storageRepository.updatePreference({ key: 'activeTab', value: tab });
  };
  const sessions = createShellSessionState(publish);
  const {
    dispatch: shellDispatch,
    beginAcceptTransition,
    completeTransition,
    cancelTransition,
  } = sessions;
  const accept = createAcceptLifecycle();
  const {
    bumpStartEpoch,
    beginPersistFlight,
    endPersistFlight,
    markPersistCommitted,
    abortAccept,
  } = accept;
  let cleanShutdownGraceTimer: ReturnType<typeof setTimeout> | null = null;
  let abandonTimer: ReturnType<typeof setTimeout> | null = null;
  let abandonPending = false;
  let waitingEnteredAt: bigint | null = null;
  let waitingState: SessionModel['channel']['status']['state'] | null = null;
  const setPendingAdvisoryState = (next: AdvisoryStartParams | null) => {
    shellDispatch({ type: 'setPendingAdvisory', value: next });
  };
  const setPendingProposalState = (next: PendingSessionProposal | null) => {
    shellDispatch({ type: 'setPendingProposal', value: next });
  };
  let peerSession: PeerSession | null = null;
  let sessionBootstrap: RehydratedDurableApplicationState | undefined = undefined;
  let bootRejectionDescriptors: DurableRejectionTransport[] = [];
  let inboundSessionRejectHandler: (sessionId: string, remoteNumber: bigint) => void = () => {};
  const {
    dispose: disposeRejections,
    bindInboundProposal,
    bindPrimaryRetirement: bindOutboundRejectRetirement,
    installInboundReceipt: installInboundRejectionReceipt,
    persistInboundReceipt,
    rejectUnknownProposal,
    replay: replayRejectionPeers,
    restore: restoreRejections,
    routeFrame: routeRejectionFrame,
    sendSessionReject,
  } = createSessionRejection({
    getPrimaryPeer: () => peerSession,
    releasePrimaryPeer: (peer) => {
      if (peerSession === peer) peerSession = null;
      update('peerLiveness', null);
    },
  });
  const handleCoinsChange = (next: CoinOfInterestEntry[]) => {
    const remaining = new Map(next.map((coin) => [coin.id, coin]));
    const ordered = state.coins.flatMap((coin) => {
      const updated = remaining.get(coin.id);
      if (!updated) return [];
      remaining.delete(coin.id);
      return [updated];
    });
    ordered.push(...remaining.values());
    update('coins', ordered);
  };
  const setSessionConfig = (value: GameSessionParams | null) => {
    shellDispatch({ type: 'setSessionConfig', value });
  };
  const setPeerConn = (value: PeerConnectionResult | null) => {
    shellDispatch({ type: 'setPeerConn', value });
  };
  const setDashboardSessionModel = (
    value: SessionModel | null | ((prev: SessionModel | null) => SessionModel | null),
  ) => {
    const next = typeof value === 'function' ? value(sessions.state.dashboardSessionModel) : value;
    if (next === null) {
      handleCoinsChange([]);
    }
    shellDispatch({ type: 'setDashboardSessionModel', value: next });
  };
  const setSessionPhase = (value: SessionPhase) => {
    shellDispatch({ type: 'setSessionPhase', value });
  };
  const setSessionError = (value: boolean) => {
    shellDispatch({ type: 'setSessionError', value });
  };
  const setRestoreStatus = (value: RestoreStatus) => {
    shellDispatch({ type: 'setRestoreStatus', value });
  };
  const setRestoreError = (value: string | null) => {
    shellDispatch({ type: 'setRestoreError', value });
  };
  const stablePeerConn: PeerConnectionResult = {
    get reliableState() {
      return peerSession?.reliableState;
    },
    get reliableTransport() {
      return peerSession?.reliableTransport;
    },
    persistInboundSessionReject: (sessionId, remoteNumber) => {
      const peer = peerSession;
      if (!peer || peer.sessionId !== sessionId) {
        throw new Error('Cannot persist inbound rejection receipt without its selected peer');
      }
      return persistInboundReceipt(peer, remoteNumber);
    },
    onSessionReject: (sessionId, remoteNumber) =>
      inboundSessionRejectHandler(sessionId, remoteNumber),
    sendMessage: (n, m) => (peerSession ?? IDLE_PEER_CONNECTION).sendMessage(n, m),
    sendAck: (n) => (peerSession ?? IDLE_PEER_CONNECTION).sendAck(n),
    sendKeepalive: () => (peerSession ?? IDLE_PEER_CONNECTION).sendKeepalive(),
  };
  let walletEvents: (event: WalletEvent) => void = () => {};
  const setWalletView = (view: WalletView) => {
    const changed = state.walletView.connected !== view.connected;
    update('walletView', view);
    if (changed) updateReadiness();
  };
  const toggleTransactionPublishNerf = () => {
    if (state.transactionPublishNerfed) {
      setTransactionPublishNerf(false);
      return;
    }
    update('confirmDialog', {
      title: 'Nerf transaction publishing?',
      body: 'Dropping transaction publications can leave your game unresolved and may cause you to lose money.',
      confirmLabel: 'Enable nerfing',
      onConfirm: () => {
        setTransactionPublishNerf(true);
        update('confirmDialog', null);
      },
    });
  };
  let hubWsUp = false;
  let lastHubActivity = 0;
  let pendingHubRemapEscalation: {
    pairingToken: string;
    registeredPlayerId: string;
  } | null = null;
  const recovery = new Recovery(
    {
      onSessionId: (value) => update('sessionId', value),
      onRestore: async (save, source) => {
        const bootstrap = rehydrateDurableApplicationState(save);
        bootRejectionDescriptors = bootstrap.state.rejectionTransports;
        const resumeTab = save.session !== null ? 'game' : null;
        if (resumeTab) setActiveTab(resumeTab);
        const hasLiveSession =
          save.session?.phase === 'live' || save.session?.phase === 'pre-handshake';
        if (hasLiveSession) {
          const generation = storageRepository.lifecycleGeneration;
          await ensurePeerProtocolLoaded();
          if (!storageRepository.isGenerationCurrent(generation)) return { deferReady: true };
          batch(() => performResume(bootstrap));
        } else if (save.session?.phase === 'terminal') {
          batch(() => restoreFinishedSessionFromSave(bootstrap));
          const bcType =
            save.preferences.blockchainType ?? storageRepository.query('blockchainType');
          if (bcType) void handleConnect(bcType, true);
        } else {
          const bcType =
            save.preferences.blockchainType ?? storageRepository.query('blockchainType');
          if (bcType) void handleConnect(bcType, true);
        }
        return { deferReady: source === 'automatic' && hasLiveSession };
      },
      onFreshClaim: (save, source) => {
        const bootstrap = rehydrateDurableApplicationState(save);
        bootRejectionDescriptors = bootstrap.state.rejectionTransports;
        if (source !== 'takeover') return;
        const bcType =
          save?.preferences.blockchainType ?? storageRepository.query('blockchainType');
        if (bcType) void handleConnect(bcType, true);
      },
      onAuthorityLost: () => {
        detachSessionEvents?.();
        detachSessionEvents = undefined;
        frontend = null;
        destroySessionController();
        hubConn?.disconnect();
        hubConn = null;
        update('iframeUrl', 'about:blank');
        setHubOrigin(null);
        update('hubLiveness', null);
        walletOwner.leavePage();
        walletOwner.stopLocalActivity();
      },
      beforeHardReset: async () => {
        detachSessionEvents?.();
        detachSessionEvents = undefined;
        frontend = null;
        peerSession?.destroy();
        peerSession = null;
        update('peerLiveness', null);
        destroySessionController();
        hubConn?.disconnect();
        hubConn = null;
        await walletOwner.disconnect();
      },
    },
    () => publish(),
  );

  const setUnreadGame = (v: boolean) => {
    update('unreadGame', v);
    storageRepository.updatePreference({ key: 'unreadGame', value: v });
  };
  const setWalletAlert = (v: boolean) => {
    update('walletAlert', v);
    storageRepository.updatePreference({ key: 'walletAlert', value: v });
  };
  const setHubAlert = (v: boolean) => {
    update('hubAlert', v);
    storageRepository.updatePreference({ key: 'hubAlert', value: v });
  };
  const presenceBusy = (phase: SessionPhase, connected?: boolean): HubPresence =>
    computeHubPresence({
      sessionPhase: phase,
      walletConnected: connected ?? state.walletView.connected,
      blockchainReady: state.blockchainReady,
    });
  const hubPresenceNow = (phase?: SessionPhase, connected?: boolean): HubPresence => {
    const save = storageRepository.loadState();
    return computeHubPresence({
      sessionPhase: phase ?? sessions.state.sessionPhase,
      walletConnected: connected ?? state.walletView.connected,
      blockchainReady: state.blockchainReady,
      terminalSave: save?.session?.phase === 'terminal',
      // A peerless pre-handshake record no longer reserves the lobby.
      hasCradle:
        save?.session?.phase === 'live' ||
        (save?.session?.phase === 'pre-handshake' && !!save.session.pairing.peerId),
      pending: isAcceptSessionTransition(sessions.state.transition),
      persistInFlight: accept.persisting,
    });
  };
  let hubConn: HubConnection | null = null;
  let sessionStarted = false;
  let sessionFinishedCleanup = false;
  const handleNetworkChange = (next: ChiaNetwork) => {
    if (
      sessionLocksNetwork(
        sessions.state.sessionPhase,
        storageRepository.loadState().session?.phase,
        sessions.state.sessionConfig?.pairingToken,
      )
    ) {
      return;
    }
    update('network', next);
    storageRepository.updatePreference({ key: 'network', value: next });
  };
  const deferStateUpdate = (fn: () => void) => {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(fn);
    } else {
      setTimeout(fn, 0);
    }
  };
  const appendHistory = (line: string) => {
    deferStateUpdate(() => {
      const next = appendRecent(state.history, line, HUMAN_HISTORY_LIMIT);
      update('history', next);
      storageRepository.updateCommon({ history: { humanHistory: next } });
    });
  };
  const clearSessionPreservingHistory = () => {
    const humanHistory = state.history;
    const current = storageRepository.loadState().session;
    if (current?.phase === 'live' || current?.phase === 'pre-handshake') {
      storageRepository.retireSessionWalletReservations(current.pairing.gameSessionId);
    }
    const snapshot = storageRepository.patchApplicationState((state) =>
      clearGameSessionState(state, { humanHistory }),
    );
    return storageRepository.write(snapshot);
  };
  const syncPeerLiveness = () => {
    update('peerLiveness', peerSession?.liveness ?? null);
  };
  const markPeerInactive = () => {
    peerSession?.markInactive();
    syncPeerLiveness();
  };
  const markPeerDead = () => {
    peerSession?.markDead();
    syncPeerLiveness();
  };
  const applyHubPeerDisconnected = (playerId: string) => {
    const ps = peerSession;
    if (!ps || playerId !== ps.peerId) return;
    if (ps.liveness === 'dead') return;
    ps.markDegraded();
    syncPeerLiveness();
  };
  const restoreHubPeerConnected = (playerId: string) => {
    const peer = peerSession;
    if (!peer || peer.peerId !== playerId) return false;
    peer.notePeerActivity();
    syncPeerLiveness();
    return true;
  };
  const isAvailableForNewSessionPrompt = () => {
    return (
      checkAvailableForNewSessionPrompt(
        sessions.state.sessionPhase,
        sessions.state.pendingAdvisory !== null,
        sessions.state.pendingProposal !== null,
        peerSession !== null,
        (() => {
          const session = storageRepository.loadState().session;
          return (
            (session?.phase === 'live' || session?.phase === 'pre-handshake') &&
            !!session.pairing.peerId
          );
        })(),
        state.walletView.connected,
        state.blockchainReady,
      ) &&
      !isAcceptSessionTransition(sessions.state.transition) &&
      !accept.persisting
    );
  };
  const replayPeerUnacked = (event: 'registered' | 'peer-available' = 'registered') => {
    const peer = peerSession;
    if (!peer || peer.isDestroyed()) return;
    peer.reliableTransport.connectivity(event);
  };
  const resetPeerRelayState = (options?: { persistSession?: boolean }) => {
    peerSession?.destroy();
    peerSession = null;
    if (options?.persistSession !== false) {
      storageRepository.clearSessionPairing();
    }
    update('peerLiveness', null);
  };
  const cancelAttemptedSession = (options?: { error?: boolean }) => {
    bumpStartEpoch();
    pendingHubRemapEscalation = null;
    abandonPending = false;
    resetPeerRelayState();
    destroySessionController();
    clearSessionPreservingHistory();
    walletOwner.setSessionPolling(false);
    sessionBootstrap = undefined;
    sessionStarted = false;
    sessionFinishedCleanup = false;
    clearSessionTimers();
    setSessionPhase('none');
    setSessionConfig(null);
    setPeerConn(null);
    setDashboardSessionModel(null);
    update('terminalPresentation', null);
    setRestoreStatus('idle');
    setRestoreError(null);
    shellDispatch({ type: 'acceptAborted', error: !!options?.error });
    hubConn?.setBusy(presenceBusy('none'));
  };
  const abandonFailedStartAttempt = (options?: { error?: boolean }) => {
    bumpStartEpoch();
    abandonPending = false;
    resetPeerRelayState();
    shellDispatch({ type: 'acceptAborted', error: !!options?.error });
    // Stay busy while the aborted start may still be inside storageRepository.replaceSession.bind(storageRepository) /
    // restore — otherwise a new Accept can race checkpoint cleanup.
    hubConn?.setBusy(
      accept.persisting
        ? { busy: true, reasons: ['starting'] as const }
        : presenceBusy(sessions.state.sessionPhase),
    );
  };
  const acceptAbortHandlers = {
    getTransition: () => sessions.state.transition,
    abandonPeerOnly: abandonFailedStartAttempt,
    cancelAttempt: cancelAttemptedSession,
    sendSessionReject,
  };
  const abortAcceptIfActive = (options?: { error?: boolean; peerId?: string }): boolean => {
    return abortAccept(acceptAbortHandlers, options);
  };
  inboundSessionRejectHandler = (sessionId, remoteNumber) => {
    const selected = peerSession;
    const peerId = selected?.peerId ?? 'unknown';
    const conn = hubConn;
    if (selected && conn && selected.sessionId === sessionId) {
      installInboundRejectionReceipt(
        conn,
        selected.peerId,
        sessionId,
        selected.reliableState.messageNumber,
        remoteNumber,
      );
    }
    log(`[Shell] session_reject from=${peerId}: durably cancelled`);
    markPeerDead();
    if (abortAcceptIfActive({ error: true })) return;
    cancelAttemptedSession({ error: true });
  };
  const startFreshSessionWithPeer = async (
    request: SessionStartRequest & {
      pairingToken: string;
    },
  ) => {
    beginPersistFlight();
    let epoch = accept.epoch;
    try {
      const conn = hubConn;
      if (!conn) throw new Error('hub connection unavailable during session start');
      const walletProviderScope = walletOwner.providerScope();
      if (!walletProviderScope) throw new Error('Wallet provider scope is unavailable');
      epoch = accept.epoch;
      const myContribution = parseSessionAmount(request.myAmount);
      const theirContribution = parseSessionAmount(request.theirAmount);
      const minContribution =
        myContribution < theirContribution ? myContribution : theirContribution;
      const perGame = minContribution / 10n || 1n;
      const sessionId = request.gameSessionId;
      const token = request.pairingToken;
      const hubSessionId = storageRepository.getSessionId();
      const existing = peerSession;
      if (
        existing &&
        !existing.isDestroyed() &&
        existing.peerId === request.peerId &&
        existing.sessionId === sessionId
      ) {
        // Reuse provisional PeerSession created when the proposal arrived (preserves buffered messages).
      } else {
        existing?.destroy();
        peerSession = new PeerSession(request.peerId, sessionId, conn);
      }
      peerSession!.reliableTransport.acceptSession(
        {
          proposer_amount: request.iStarted ? request.myAmount : request.theirAmount,
          responder_amount: request.iStarted ? request.theirAmount : request.myAmount,
          channel_timeout: request.channel_timeout,
          unroll_timeout: request.unroll_timeout,
          network: storageRepository.query('network'),
        },
        request.iStarted,
      );
      const channelTimeout = parseOptionalBigInt(request.channel_timeout);
      const unrollTimeout = parseOptionalBigInt(request.unroll_timeout);
      const diagnosticLog = storageRepository.loadState().history.diagnosticLog;
      const wasmNotificationHistory = storageRepository.loadState().history.wasmNotificationHistory;
      const outcome = await transitionToFreshSession({
        reportBusy: () => conn.setBusy(hubPresenceNow()),
        shouldAbort: () => epoch !== accept.epoch,
        retireTerminalDisplay: () =>
          batch(() => {
            sessionStarted = false;
            sessionFinishedCleanup = false;
            clearSessionTimers();
            setSessionPhase('none');
            setSessionError(false);
            setRestoreStatus('idle');
            setRestoreError(null);
            setDashboardSessionModel(null);
            update('terminalPresentation', null);
            setSessionConfig(null);
            setPeerConn(null);
            destroySessionController();
          }),
        persistLiveCheckpoint: async () => {
          const commit = peerSession!.reliableTransport.prepareCommit();
          await captureFreshStart({
            epoch,
            getCurrentEpoch: () => accept.epoch,
            checkpoint: {
              walletProviderScope,
              pairing: {
                token,
                peerId: request.peerId,
                gameSessionId: sessionId,
                iStarted: request.iStarted,
                myContribution: myContribution.toString(),
                theirContribution: theirContribution.toString(),
                perGameAmount: perGame.toString(),
                opponentAlias: request.opponentAlias,
                ...(channelTimeout !== undefined
                  ? { channelTimeout: channelTimeout.toString() }
                  : {}),
                ...(unrollTimeout !== undefined ? { unrollTimeout: unrollTimeout.toString() } : {}),
              },
              transport: transportSaveFromReliableState(peerSession!.reliableState),
              identity: {
                sessionId: hubSessionId,
                ...(conn.getPlayerId() ? { myHubPlayerId: conn.getPlayerId()! } : {}),
              },
              history: {
                ...(state.history.length > 0 ? { humanHistory: state.history } : {}),
                ...(diagnosticLog && diagnosticLog.length > 0 ? { diagnosticLog } : {}),
                ...(wasmNotificationHistory && wasmNotificationHistory.length > 0
                  ? { wasmNotificationHistory }
                  : {}),
              },
            },
            onCommitted: markPersistCommitted,
          });
          const peer = peerSession;
          if (peer?.sessionId === sessionId) {
            peer.reliableTransport.completeCommit(commit, true);
          }
        },
        mountLiveSession: () =>
          batch(() => {
            walletOwner.setSessionPolling(true);
            shellDispatch({
              type: 'liveMounted',
              sessionConfig: {
                iStarted: request.iStarted,
                myContribution,
                theirContribution,
                perGameAmount: perGame,
                restoring: false,
                pairingToken: token,
                myAlias: undefined,
                opponentAlias: request.opponentAlias,
                channelTimeout,
                unrollTimeout,
              },
              peerConn: stablePeerConn,
            });
            update('peerLiveness', null);
          }),
      });
      if (outcome === 'aborted') {
        log(
          `[Shell] startFreshSessionWithPeer aborted: cancelled after persist peer=${request.peerId}`,
        );
        return;
      }
    } catch (error) {
      console.error('[Shell] session start failed', error);
      log(
        `[Shell] session start failed peer=${request.peerId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      sendSessionReject(request.peerId);
      if (startFailureDisposition(accept.committed) === 'cancel-attempt') {
        cancelAttemptedSession({ error: true });
      } else {
        // Persist never committed: finished freeze + terminal checkpoint remain.
        abandonFailedStartAttempt({ error: true });
      }
    } finally {
      endPersistFlight();
      // Abandon kept the hub busy while this callback drained; release now.
      if (epoch !== accept.epoch) {
        hubConn?.setBusy(presenceBusy(sessions.state.sessionPhase));
      }
    }
  };
  const acceptPendingAdvisory = (advisory: AdvisoryStartParams) => {
    const conn = hubConn;
    if (!conn || sessions.state.pendingAdvisory !== advisory) return;
    const pairingToken = `peer_${advisory.peer_id}_${Date.now()}`;
    void beginAcceptTransition('accept-advisory', pairingToken, async () => {
      try {
        const gameSessionId = generateSessionId();
        await startFreshSessionWithPeer({
          peerId: advisory.peer_id,
          opponentAlias: advisory.peer_alias,
          myAmount: advisory.my_amount,
          theirAmount: advisory.their_amount,
          channel_timeout: advisory.channel_timeout,
          unroll_timeout: advisory.unroll_timeout,
          iStarted: true,
          gameSessionId,
          pairingToken,
        });
      } catch (error) {
        // Setup threw before startFreshSessionWithPeer could clean up.
        // Do not leave the lobby stuck.
        console.error('[Shell] accept-advisory failed', error);
        log(
          `[Shell] accept-advisory failed peer=${advisory.peer_id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        sendSessionReject(advisory.peer_id);
        abandonFailedStartAttempt({ error: true });
      }
    });
  };
  const declinePendingAdvisory = (advisory: AdvisoryStartParams) => {
    setPendingAdvisoryState(null);
    sendSessionReject(advisory.peer_id);
  };
  const acceptPendingProposal = (proposal: PendingSessionProposal) => {
    if (sessions.state.pendingProposal !== proposal) return;
    const pairingToken = `peer_${proposal.from_id}_${Date.now()}`;
    void beginAcceptTransition('accept-proposal', pairingToken, async () => {
      try {
        await startFreshSessionWithPeer({
          peerId: proposal.from_id,
          opponentAlias: proposal.from_alias,
          myAmount: proposal.responder_amount,
          theirAmount: proposal.proposer_amount,
          channel_timeout: proposal.channel_timeout,
          unroll_timeout: proposal.unroll_timeout,
          iStarted: false,
          gameSessionId: proposal.game_session_id,
          pairingToken,
        });
      } catch (error) {
        console.error('[Shell] accept-proposal failed', error);
        sendSessionReject(proposal.from_id);
        abandonFailedStartAttempt({ error: true });
      }
    });
  };
  const declinePendingProposal = (proposal: PendingSessionProposal) => {
    setPendingProposalState(null);
    void sendSessionReject(proposal.from_id);
    cancelAttemptedSession();
  };
  const setHubOrigin = (origin: string | null) => {
    update('hubOrigin', origin);
    updateReadiness();
  };
  let hubConnectAttempt = 0;
  const invalidateHubConnectAttempts = () => {
    hubConnectAttempt++;
  };
  const connectToHub = async (
    origin: string,
    options: {
      resetSession?: boolean;
    } = {},
  ) => {
    const connectAttempt = ++hubConnectAttempt;
    hubConn?.disconnect();
    hubConn = null;
    update('hubConnectionError', null);
    if (options.resetSession) {
      storageRepository.clearHubIdentity();
    }
    let hubSessionId: string;
    try {
      await ensurePeerProtocolLoaded();
      hubSessionId = await deriveHubSessionId(storageRepository.getSessionId(), origin);
    } catch (error) {
      if (connectAttempt !== hubConnectAttempt) return;
      update(
        'hubConnectionError',
        error instanceof Error ? error.message : 'Failed to derive hub session credential',
      );
      update('hubLiveness', 'disconnected');
      return;
    }
    if (connectAttempt !== hubConnectAttempt) return;
    update('sessionId', hubSessionId);
    setHubOrigin(origin);
    storageRepository.updatePreference({ key: 'hubUrl', value: origin });
    update('iframeUrl', new URL('/', origin).toString());
    update('hubLiveness', 'reconnecting');
    let conn: HubConnection;
    try {
      conn = new HubConnection(
        origin,
        hubSessionId,
        (event) =>
          batch(() => {
            switch (event.type) {
              case 'advisory-start': {
                const params = event.params;

                hubWsUp = true;
                lastHubActivity = Date.now();
                update('hubLiveness', 'connected');
                // Hub advisory while we are already mid-matchmaking/session: ignore.
                // Do not session_reject the peer — advisory is not a peer request.
                if (!isAvailableForNewSessionPrompt()) {
                  log(
                    `[Shell] advisory_start ignored: unavailable peer=${params.peer_id} phase=${sessions.state.sessionPhase}`,
                  );
                  return;
                }
                if (
                  !isValidTimeoutString(params.channel_timeout) ||
                  !isValidTimeoutString(params.unroll_timeout)
                ) {
                  log(`[Shell] advisory_start ignored: invalid timeouts peer=${params.peer_id}`);
                  return;
                }
                if (
                  !isValidSessionAmountString(params.my_amount) ||
                  !isValidSessionAmountString(params.their_amount)
                ) {
                  log(`[Shell] advisory_start ignored: invalid amounts peer=${params.peer_id}`);
                  return;
                }
                setPendingAdvisoryState(params);
                setActiveTab('game');

                return;
              }
              case 'peer-message': {
                const fromId = event.fromId;
                const fromAlias = event.fromAlias;
                const payload = event.payload;

                if (routeRejectionFrame(fromId, payload)) return;
                const frame = decodeReliableFrame(payload);
                const selected = peerSession;
                if (selected && selected.peerId === fromId) {
                  selected.deliverRawPeerMessage(fromId, payload);
                  syncPeerLiveness();
                  return;
                }
                if (
                  frame?.tag !== 0x01 ||
                  frame.msgno !== 1 ||
                  frame.data.byteLength > DEFAULT_SESSION_RECEIVE_POLICY.maxPeerBodyBytes
                ) {
                  return;
                }
                let proposal;
                try {
                  proposal = decodePeerAppMessage(frame.data);
                } catch {
                  return;
                }
                if (proposal?.type !== 'session_proposal') return;
                if (
                  !isAvailableForNewSessionPrompt() ||
                  !isValidTimeoutString(proposal.channel_timeout) ||
                  !isValidTimeoutString(proposal.unroll_timeout) ||
                  !isValidSessionAmountString(proposal.proposer_amount) ||
                  !isValidSessionAmountString(proposal.responder_amount) ||
                  !sessionProposalNetworkMatches(
                    proposal.network,
                    storageRepository.query('network'),
                  )
                ) {
                  rejectUnknownProposal(conn, fromId, frame.sessionId, payload);
                  return;
                }
                const peerAlias = fromAlias || fromId;
                const pairingToken = `peer_${fromId}_${Date.now()}`;
                const provisional = new PeerSession(fromId, frame.sessionId, conn);
                peerSession = provisional;
                bindInboundProposal({
                  conn,
                  peer: provisional,
                  persistProposal: async () => {
                    const checkpoint = {
                      walletProviderScope: (() => {
                        const scope = walletOwner.providerScope();
                        if (!scope) throw new Error('Wallet provider scope is unavailable');
                        return scope;
                      })(),
                      pairing: {
                        token: pairingToken,
                        peerId: fromId,
                        gameSessionId: frame.sessionId,
                        iStarted: false,
                        myContribution: proposal.responder_amount,
                        theirContribution: proposal.proposer_amount,
                        perGameAmount: (
                          (BigInt(proposal.responder_amount) < BigInt(proposal.proposer_amount)
                            ? BigInt(proposal.responder_amount)
                            : BigInt(proposal.proposer_amount)) / 10n || 1n
                        ).toString(),
                        opponentAlias: peerAlias,
                        channelTimeout: proposal.channel_timeout,
                        unrollTimeout: proposal.unroll_timeout,
                      },
                      transport: transportSaveFromReliableState(provisional.reliableState),
                    };
                    const snapshot = storageRepository.patchApplicationState((state) =>
                      applyFreshStartCheckpoint(state, checkpoint),
                    );
                    await storageRepository.write(snapshot);
                    if (peerSession !== provisional) return;
                    setPendingProposalState({
                      from_id: fromId,
                      from_alias: peerAlias,
                      proposer_amount: proposal.proposer_amount,
                      responder_amount: proposal.responder_amount,
                      channel_timeout: proposal.channel_timeout,
                      unroll_timeout: proposal.unroll_timeout,
                      game_session_id: frame.sessionId,
                    });
                    setActiveTab('game');
                    syncPeerLiveness();
                  },
                  rejected: () => {
                    log(`[Shell] session_reject from=${fromId}: durably cancelled`);
                    markPeerDead();
                    if (abortAcceptIfActive({ error: true })) return;
                    cancelAttemptedSession({ error: true });
                  },
                  failed: (reason) => {
                    console.error('[Shell] invalid provisional reliable session', reason);
                    if (peerSession === provisional) {
                      if (abortAcceptIfActive({ error: true })) return;
                      // No Accept owns rollback of this failed consent checkpoint.
                      void storageRepository.clearSession();
                      abandonFailedStartAttempt({ error: true });
                    }
                  },
                });
                provisional.deliverRawPeerMessage(fromId, payload);

                return;
              }
              case 'delivery-failure': {
                const to = event.to;

                console.warn('[Shell] delivery_failure to=%s', to);
                const ps = peerSession;
                if (!ps || to !== ps.peerId) return;
                if (abortAcceptIfActive()) {
                  markPeerDead();
                  return;
                }
                const channelState = sessions.state.dashboardSessionModel?.channel.status.state;
                // A saved funding offer can be released before React projects its
                // status. Preserve that commitment when delivery fails in that gap.
                const savedSession = storageRepository.loadState().session;
                const savedChannelState =
                  savedSession?.phase === 'live' &&
                  savedSession.pairing.peerId === ps.peerId &&
                  savedSession.pairing.gameSessionId === ps.sessionId
                    ? savedSession.presentation.channelStatus?.state
                    : undefined;
                if (
                  shouldCancelOnPeerUnreachable(
                    sessions.state.sessionPhase,
                    channelState,
                    abandonPending,
                  ) &&
                  shouldCancelOnPeerUnreachable(
                    sessions.state.sessionPhase,
                    savedChannelState,
                    abandonPending,
                  )
                ) {
                  // Matchmaking / channel setup: abandon the attempt.
                  markPeerDead();
                  cancelAttemptedSession();
                  return;
                }
                // Live or settling session: peer may be mid-reload. Degrade only —
                // CONNECTIVITY: delivery failures do not auto-kill or go on-chain.
                // notePeerActivity recovers when traffic resumes.
                ps.markDegraded();
                syncPeerLiveness();

                return;
              }
              case 'alias-updated': {
                const alias = event.alias;

                if (storageRepository.query('alias') !== alias)
                  storageRepository.updatePreference({ key: 'alias', value: alias });

                return;
              }
              case 'peer-available': {
                const playerId = event.playerId;

                if (restoreHubPeerConnected(playerId)) {
                  if (sessionController) sessionController.reportPeerConnectivity('peer-available');
                  else replayPeerUnacked('peer-available');
                }
                replayRejectionPeers(playerId);

                return;
              }
              case 'peer-unavailable': {
                const playerId = event.playerId;

                if (peerSession?.peerId === playerId) {
                  peerSession.reliableTransport.connectivity('peer-unavailable');
                }
                applyHubPeerDisconnected(playerId);

                return;
              }
              case 'registered': {
                const playerId = event.playerId;

                hubWsUp = true;
                lastHubActivity = Date.now();
                update('hubLiveness', 'connected');
                const save = storageRepository.loadState();
                const pairing =
                  save?.session?.phase === 'live' || save?.session?.phase === 'pre-handshake'
                    ? save.session.pairing
                    : undefined;
                const prevMine = save.identity.myHubPlayerId;
                const channelState = sessions.state.dashboardSessionModel?.channel.status.state;
                const pairingToken = pairing?.token ?? sessions.state.sessionConfig?.pairingToken;
                const remapAction = hubPlayerIdRemapAction(
                  prevMine,
                  playerId,
                  save?.session?.phase,
                  sessions.state.sessionPhase,
                  channelState,
                  !!pairingToken,
                  abandonPending,
                );
                if (prevMine && prevMine !== playerId) {
                  if (abortAcceptIfActive()) {
                    console.warn(
                      '[Shell] hub player_id remapped during pre-cradle handshake (%s → %s); rematch required',
                      prevMine,
                      playerId,
                    );
                    log(
                      `[hub] player_id remapped during pre-cradle handshake (${prevMine} → ${playerId}); rematch required`,
                    );
                    storageRepository.updateCommon({
                      identity: { myHubPlayerId: playerId },
                    });
                    return;
                  }
                  if (remapAction === 'cancel-attempt') {
                    console.warn(
                      '[Shell] hub player_id remapped during pre-cradle handshake (%s → %s); rematch required',
                      prevMine,
                      playerId,
                    );
                    log(
                      `[hub] player_id remapped during pre-cradle handshake (${prevMine} → ${playerId}); rematch required`,
                    );
                    storageRepository.updateCommon({
                      identity: { myHubPlayerId: playerId },
                    });
                    cancelAttemptedSession();
                    return;
                  }
                  if (remapAction === 'go-on-chain') {
                    console.warn(
                      '[Shell] hub player_id remapped during live session (%s → %s); resolving on-chain',
                      prevMine,
                      playerId,
                    );
                    const controllerRestoreStatus = sessionController?.getRestoreStatus();
                    if (
                      shouldDeferHubRemapEscalation(
                        !!sessions.state.sessionConfig?.restoring,
                        controllerRestoreStatus,
                      )
                    ) {
                      if (!pairingToken) {
                        throw new Error('Live hub player_id remap is missing its pairing token');
                      }
                      pendingHubRemapEscalation = {
                        pairingToken,
                        registeredPlayerId: playerId,
                      };
                    } else if (controllerRestoreStatus === 'failed') {
                      pendingHubRemapEscalation = null;
                      setSessionError(true);
                    } else if (sessionController?.goOnChain('hub-remap')) {
                      pendingHubRemapEscalation = null;
                      storageRepository.updateCommon({
                        identity: { myHubPlayerId: playerId },
                      });
                      setSessionPhase('on-chain');
                      conn.setBusy(presenceBusy('on-chain'));
                    } else {
                      pendingHubRemapEscalation = null;
                      setSessionError(true);
                    }
                    markPeerDead();
                    return;
                  }
                  if (remapAction === 'ignore') markPeerDead();
                }
                storageRepository.updateCommon({
                  identity: { myHubPlayerId: playerId },
                });
                // Registration uses the same presence calculation as reconnects.
                const restoreBusy = hubPresenceNow();
                if (!peerSession && pairing?.peerId && conn) {
                  peerSession = new PeerSession(
                    pairing.peerId,
                    pairing.gameSessionId,
                    conn,
                    undefined,
                    sessionController?.reliableTransport ??
                      (save?.session?.phase === 'live'
                        ? {
                            messageNumber: save.session.live.messageNumber,
                            remoteNumber: save.session.live.remoteNumber,
                            unackedMessages: structuredClone(save.session.live.unackedMessages),
                            disposition: save.session.live.disposition,
                          }
                        : save?.session?.phase === 'pre-handshake'
                          ? structuredClone(save.session.transport)
                          : undefined),
                  );
                  if (peerSession.reliableState.disposition === 'outbound-reject') {
                    bindOutboundRejectRetirement(peerSession);
                  }
                  // Restore does not pass through the fresh-session busy update.
                  conn.setBusy(restoreBusy);
                } else if (
                  save?.session?.phase === 'live' ||
                  save?.session?.phase === 'pre-handshake'
                ) {
                  conn.setBusy(restoreBusy);
                }
                if (peerSession && (!prevMine || prevMine === playerId)) {
                  if (sessionController) sessionController.reportPeerConnectivity('registered');
                  else replayPeerUnacked();
                }
                replayRejectionPeers();

                return;
              }
              case 'attention': {
                if (state.activeTab !== 'hub') {
                  setHubAlert(true);
                }

                return;
              }
              case 'closed': {
                peerSession?.reliableTransport.connectivity('disconnected');
                hubWsUp = false;
                markPeerInactive();
                update('hubLiveness', 'disconnected');
                update('hubConnectionError', `Unable to connect to hub at ${origin}.`);

                return;
              }
              case 'disconnected': {
                peerSession?.reliableTransport.connectivity('disconnected');
                hubWsUp = false;
                update('hubLiveness', 'reconnecting');

                return;
              }
              case 'reconnected': {
                peerSession?.reliableTransport.connectivity('reconnected');
                hubWsUp = true;
                lastHubActivity = Date.now();
                update('hubLiveness', 'connected');

                return;
              }
              case 'activity': {
                lastHubActivity = Date.now();

                return;
              }
              case 'keepalive': {
                sessionController?.sendPeerKeepalive();

                return;
              }
            }
          }),
        () => {
          // A leftover cradle must not keep us busy after the session resolved
          // (wallet/handshake failures often leave Failed + persisted cradle).
          // Backend not ready for play also stays busy. Accept-pending + persist-drain
          // must also stay busy: identify/reconnect re-applies getPresence and would
          // otherwise undo explicit setBusy.
          return hubPresenceNow();
        },
      );
    } catch (err) {
      console.error('[Shell] HubConnection failed for origin=%s', origin, err);
      storageRepository.updatePreference({ key: 'hubUrl', value: undefined });
      setHubOrigin(null);
      update('iframeUrl', 'about:blank');
      update('hubLiveness', null);
      update(
        'hubConnectionError',
        err instanceof Error ? err.message : `Unable to connect to hub at ${origin}.`,
      );
      return;
    }
    hubConn = conn;
    peerSession?.attachCarrier(conn);
    void restoreRejections(conn, bootRejectionDescriptors).catch((error) => {
      console.error('[Shell] failed to restore rejection tombstones', error);
    });
  };
  const requestHubConnect = async (origin: string) => {
    const trust = await requestHubTrust(origin);
    const trustError = hubTrustError(trust, origin);
    if (trustError !== null) {
      update('hubConnectionError', trustError);
      return;
    }
    if (trust === 'granted') {
      storageRepository.regenerateSessionId();
      storageRepository.updatePreference({ key: 'hubUrl', value: origin });
      window.location.reload();
      return;
    }
    if (
      (state.peerLiveness === 'connected' || state.peerLiveness === 'degraded') &&
      sessions.state.sessionPhase === 'off-chain'
    ) {
      update('confirmDialog', {
        title: 'Disconnect from hub?',
        body: 'Disconnecting from this hub will end your peer connection. Your game stays off-chain — resolve it on-chain from the dashboard if needed.',
        onConfirm: () => {
          update('confirmDialog', null);
          connectToHub(origin, { resetSession: true });
        },
      });
    } else if (state.peerLiveness === 'connected' || state.peerLiveness === 'degraded') {
      update('confirmDialog', {
        title: 'Disconnect from hub?',
        body: 'This will end your peer connection.',
        onConfirm: () => {
          update('confirmDialog', null);
          connectToHub(origin, { resetSession: true });
        },
      });
    } else {
      connectToHub(origin, { resetSession: true });
    }
  };
  const handleConnect = async (type: ShellBlockchainType, silent = false, fresh = false) => {
    if (await walletOwner.connect(type, silent, fresh)) {
      if (!silent) setActiveTab('hub');
    }
  };
  walletEvents = (event) => {
    switch (event.type) {
      case 'view':
        setWalletView(event.view);
        break;
      case 'connected':
        hubConn?.setBusy(hubPresenceNow(sessions.state.sessionPhase, true));
        break;
      case 'connection':
        if (event.connected) {
          setWalletAlert(false);
          hubConn?.setBusy(hubPresenceNow(sessions.state.sessionPhase, true));
        } else {
          if (!event.recovering && state.activeTab !== 'wallet') setWalletAlert(true);
          hubConn?.setBusy(presenceBusy(sessions.state.sessionPhase, false));
        }
        break;
      case 'readiness': {
        const ready = !!state.hubOrigin && walletOwner.view.connected && event.ready;
        update('blockchainReady', ready);
        hubConn?.setBusy(hubPresenceNow());
        break;
      }
      case 'attention':
        setWalletAlert(true);
        break;
      case 'fee-changed':
        update('defaultFee', storageRepository.query('defaultFee'));
        break;
      case 'detaching': {
        sessionController?.setWallet(null);
        update('blockchainReady', false);
        break;
      }
    }
  };
  const onGameActivity = () => {
    if (state.activeTab !== 'game') {
      deferStateUpdate(() => {
        setUnreadGame(true);
      });
    }
  };
  const stopSessionTimers = () => {
    if (cleanShutdownGraceTimer !== null) {
      clearTimeout(cleanShutdownGraceTimer);
      cleanShutdownGraceTimer = null;
    }
    if (abandonTimer !== null) {
      clearTimeout(abandonTimer);
      abandonTimer = null;
    }
  };
  const clearSessionTimers = () => {
    stopSessionTimers();
    waitingEnteredAt = null;
    waitingState = null;
    update('abandonEnabled', false);
    update('cleanShutdownGraceActive', false);
  };
  const cancelDashboardSession = (options?: { retainFinishedGuard?: boolean }) => {
    bumpStartEpoch();
    abandonPending = false;
    const saved = storageRepository.loadState();
    const peerId =
      peerSession?.peerId ??
      (saved?.session?.phase === 'live' || saved?.session?.phase === 'pre-handshake'
        ? saved.session.pairing.peerId
        : undefined);
    // Terminal/clean finish must not send session_reject — that signal means
    // decline/abort. Cooperative close already completed through the protocol;
    // the peer may still need acknowledgement of its final reliable close.
    const retainRejectTransport = !!peerId && !options?.retainFinishedGuard;
    const finishCancellation = () => {
      if (!retainRejectTransport) {
        resetPeerRelayState();
      }
      destroySessionController();
      if (!retainRejectTransport) {
        clearSessionPreservingHistory();
      }
      sessionBootstrap = undefined;
      sessionStarted = false;
      sessionFinishedCleanup = !!options?.retainFinishedGuard;
      clearSessionTimers();
      setSessionPhase('none');
      setSessionError(false);
      setSessionConfig(null);
      setPeerConn(null);
      setDashboardSessionModel(null);
      update('terminalPresentation', null);
      setRestoreStatus('idle');
      setRestoreError(null);
      setPendingAdvisoryState(null);
      setPendingProposalState(null);
      cancelTransition();
      hubConn?.setBusy(presenceBusy('none'));
    };
    if (retainRejectTransport) {
      void sendSessionReject(peerId);
      finishCancellation();
    } else {
      finishCancellation();
    }
  };
  const abandonActiveChannel = () => {
    abandonPending = true;
    const state = sessions.state.dashboardSessionModel?.channel.status.state;
    if (state && PRE_ACTIVE_CHANNEL_STATES.has(state)) {
      const saved = storageRepository.loadState();
      const peerId =
        peerSession?.peerId ??
        (saved?.session?.phase === 'live' || saved?.session?.phase === 'pre-handshake'
          ? saved.session.pairing.peerId
          : undefined);
      if (peerId) sendSessionReject(peerId);
    }
    sessionController?.abandon();
  };
  const finishResolvedSessionDisplay = async (hasError: boolean): Promise<boolean> => {
    const controller = sessionController;
    if (!controller) {
      setSessionError(true);
      return false;
    }
    const durableState = storageRepository.loadState();
    const alias =
      sessions.state.sessionConfig?.myAlias ??
      savedMyAlias(durableState) ??
      storageRepository.query('alias');
    const identity = {
      myName: alias ?? '',
      opponentName: sessions.state.sessionConfig?.opponentAlias ?? savedOpponentAlias(durableState),
      iStarted:
        sessions.state.sessionConfig?.iStarted ??
        (durableState.session?.phase === 'live' || durableState.session?.phase === 'pre-handshake'
          ? durableState.session.pairing.iStarted
          : false),
    };
    let terminal;
    try {
      terminal = await finalizeTerminalSession(
        { controller, identity },
        {
          teardown: (finished) => {
            if (sessionController !== finished) {
              throw new Error('Terminal finalization lost ownership of its session');
            }
            destroySessionController();
          },
        },
      );
    } catch (error) {
      if (
        error instanceof StorageAuthorityLostError ||
        error instanceof StorageAuthorityRequiredError
      ) {
        destroySessionController();
      }
      update(
        'terminalFinalizationBlocker',
        error instanceof Error ? error.message : 'Session finalization is blocked.',
      );
      setSessionError(true);
      return false;
    }
    return batch(() => {
      update('terminalFinalizationBlocker', null);
      handleCoinsChange(terminal.coins);
      setDashboardSessionModel(terminal.model);
      update('finishedSessionIdentity', terminal.identity);
      update('terminalPresentation', {
        model: terminal.model,
        myName: terminal.identity.myName,
        opponentName: terminal.identity.opponentName,
        iStarted: terminal.identity.iStarted,
      });
      abandonPending = false;
      sessionFinishedCleanup = true;
      setSessionPhase('resolved');
      setSessionError(hasError);
      hubConn?.setBusy(presenceBusy('resolved'));
      // Stop the live peer route and cradle; do not send session_reject and do
      // not wipe the dashboard model (that would flash "No Session").
      resetPeerRelayState({ persistSession: false });
      sessionBootstrap = undefined;
      clearSessionTimers();
      // Drop the restore mount flag before resetting status. A resumed
      // session keeps params.restoring=true; resetting gates alone would re-arm
      // restoreBlocked and GameSession would show "Restoring session..." over
      // the terminal presentation (visible on slash because hasError stays on game).
      const restoreGate = restoreGateAfterTerminalFinalization();
      const liveConfig = sessions.state.sessionConfig;
      if (liveConfig?.restoring) {
        setSessionConfig({ ...liveConfig, restoring: restoreGate.restoring });
      }
      setRestoreStatus(restoreGate.restoreStatus);
      setRestoreError(null);
      return true;
    });
  };
  const handleSessionPhaseChange = (
    phase: SessionPhase,
    hasError?: boolean,
  ): void | Promise<boolean> => {
    if (phase === 'resolved') {
      if (sessionFinishedCleanup) return Promise.resolve(true);
      const previousPhase = sessions.state.sessionPhase;
      const switchHub = shouldSwitchToHubOnResolved(previousPhase, !!hasError);
      const bcType = state.walletView.walletType;
      if (bcType) walletOwner.watchBalance();
      return finishResolvedSessionDisplay(!!hasError).then((finished) => {
        if (finished && switchHub) setActiveTab('hub');
        return finished;
      });
    }
    setSessionPhase(phase);
    setSessionError(!!hasError);
    hubConn?.setBusy(presenceBusy(phase));
  };
  const handleRestoreStatusChange = (status: RestoreStatus, error: string | null) => {
    setRestoreStatus(status);
    setRestoreError(error);
    setDashboardSessionModel((prev) =>
      prev ? { ...prev, restore: { ...prev.restore, status, error } } : prev,
    );
    if (status === 'failed') {
      markSavedSession();
      setSessionError(true);
    }
    const currentSave = storageRepository.loadState();
    const currentPairingToken =
      sessions.state.sessionConfig?.pairingToken ??
      (currentSave?.session?.phase === 'live' || currentSave?.session?.phase === 'pre-handshake'
        ? currentSave.session.pairing.token
        : undefined);
    const pendingAction = deferredHubRemapEscalationAction(
      pendingHubRemapEscalation?.pairingToken ?? null,
      currentPairingToken,
      status,
    );
    if (pendingAction === 'discard') {
      pendingHubRemapEscalation = null;
    } else if (pendingAction === 'escalate') {
      const pending = pendingHubRemapEscalation;
      pendingHubRemapEscalation = null;
      if (!pending) {
        throw new Error('Deferred hub remap escalation is missing its pending identity');
      }
      if (!sessionController?.goOnChain('hub-remap')) {
        setSessionError(true);
        markPeerDead();
        return;
      }
      storageRepository.updateCommon({
        identity: { myHubPlayerId: pending.registeredPlayerId },
      });
      setSessionPhase('on-chain');
      hubConn?.setBusy(presenceBusy('on-chain'));
      markPeerDead();
    }
  };
  const handleSessionModelChange = (model: SessionModel) => {
    setDashboardSessionModel(model);
    const pairingToken = sessions.state.sessionConfig?.pairingToken;
    if (pairingToken && shouldCompleteAcceptTransition(model)) {
      completeTransition(pairingToken);
    }
  };
  const handleTabChange = (tabId: TabId) => {
    setActiveTab(tabId);
    if (tabId === 'game') setUnreadGame(false);
    if (tabId === 'wallet') setWalletAlert(false);
    if (tabId === 'hub') setHubAlert(false);
  };
  const restoreFinishedSessionFromSave = (bootstrap: RehydratedDurableApplicationState) => {
    const save = bootstrap.state;
    if (
      save.session?.phase !== 'terminal' ||
      !Array.isArray(save.session.terminal.coinsOfInterest)
    ) {
      throw new Error('Garbled terminal save: missing frozen coin list');
    }
    const terminal = save.session.terminal;
    setActiveTab('game');
    const channelState = savedChannelStatus(save);
    const hasError = channelState === 'Failed' || channelState === 'ResolvedStale';
    sessionFinishedCleanup = true;
    setSessionPhase('resolved');
    setSessionError(hasError);
    const model = structuredClone(bootstrap.model);
    setDashboardSessionModel(model);
    handleCoinsChange(terminal.coinsOfInterest);
    update('finishedSessionIdentity', {
      myName: terminal.myAlias ?? storageRepository.query('alias') ?? '',
      opponentName: terminal.opponentAlias ?? undefined,
      iStarted: terminal.iStarted,
    });
    update('terminalPresentation', null);
    sessionBootstrap = undefined;
    sessionStarted = false;
    setSessionConfig(null);
    setPeerConn(null);
    setRestoreStatus('idle');
    setRestoreError(null);
    hubConn?.setBusy(presenceBusy('resolved'));
  };
  const performResume = (bootstrap: RehydratedDurableApplicationState) => {
    const save = bootstrap.state;
    setActiveTab('game');
    const bcType =
      save.preferences.blockchainType ?? (isElectronDistribution() ? 'walletconnect' : 'simulator');
    setRestoreStatus('restoring');
    setRestoreError(null);
    setSessionPhase('none');
    setSessionError(false);
    // Cradle-less pairingToken saves are a pre-handshake checkpoint: mount
    // GameSession without sessionSave so getOrCreate runs newSession, not restore.
    sessionBootstrap = save.session?.phase === 'live' ? bootstrap : undefined;
    if (save.session === null || save.session.phase === 'terminal') {
      throw new Error(
        `Garbled save: ${save.session?.phase ?? 'no-session'} has no session amounts`,
      );
    }
    const myContribution = BigInt(save.session.pairing.myContribution);
    const theirContribution = BigInt(save.session.pairing.theirContribution);
    const perGame = BigInt(save.session.pairing.perGameAmount);
    const transportDisposition =
      save.session?.phase === 'live'
        ? save.session.live.disposition
        : save.session?.phase === 'pre-handshake'
          ? save.session.transport.disposition
          : null;
    if (
      (save.session?.phase === 'live' || save.session?.phase === 'pre-handshake') &&
      transportDisposition === 'active'
    ) {
      const pairing = save.session.pairing;
      setSessionConfig({
        iStarted: pairing.iStarted,
        myContribution,
        theirContribution,
        perGameAmount: perGame,
        restoring: save.session.phase === 'live',
        pairingToken: pairing.token,
        myAlias: pairing.myAlias,
        opponentAlias: pairing.opponentAlias,
        channelTimeout: parseOptionalBigInt(pairing.channelTimeout),
        unrollTimeout: parseOptionalBigInt(pairing.unrollTimeout),
      });
      setPeerConn(peerConnectionForSavedSession(stablePeerConn, save.session));
    } else if (transportDisposition !== null) {
      setSessionConfig(null);
      setPeerConn(null);
      setRestoreStatus('restored');
      if (
        save.session?.phase === 'pre-handshake' &&
        save.session.transport.disposition === 'proposal-received' &&
        save.session.pairing.peerId
      ) {
        const pairing = save.session.pairing;
        setPendingProposalState({
          from_id: pairing.peerId!,
          from_alias: pairing.opponentAlias ?? pairing.peerId!,
          proposer_amount: pairing.theirContribution,
          responder_amount: pairing.myContribution,
          channel_timeout: pairing.channelTimeout,
          unroll_timeout: pairing.unrollTimeout,
          game_session_id: pairing.gameSessionId,
        });
      }
    }
    const savedHistory = save.history.humanHistory;
    const savedLog = save.history.diagnosticLog;
    if (savedHistory) update('history', recentEntries(savedHistory, HUMAN_HISTORY_LIMIT));
    if (savedLog) update('logLines', recentDiagnosticEntries(savedLog));
    // Restore abandon timer only if the persisted channel is still in that waiting state.
    if (abandonTimer !== null) {
      clearTimeout(abandonTimer);
      abandonTimer = null;
    }
    const restoredChannelStatus = savedChannelStatus(save);
    const restoredPresentation = save.session?.phase === 'live' ? save.session.presentation : null;
    const presentationTimingOwner = sessionController;
    if (
      restoredPresentation?.waitingStateEnteredAt != null &&
      isAbandonWaitingState(restoredChannelStatus)
    ) {
      const elapsed = BigInt(Date.now()) - restoredPresentation.waitingStateEnteredAt;
      waitingEnteredAt = restoredPresentation.waitingStateEnteredAt;
      waitingState = restoredChannelStatus;
      if (elapsed >= ABANDON_DELAY_MS) {
        update('abandonEnabled', true);
      } else {
        abandonTimer = setTimeout(
          () => {
            abandonTimer = null;
            const currentState =
              sessions.state.dashboardSessionModel?.channel.status.state ?? restoredChannelStatus;
            if (currentState !== restoredChannelStatus) return;
            update('abandonEnabled', true);
          },
          Number(ABANDON_DELAY_MS - elapsed),
        );
      }
    } else {
      waitingEnteredAt = null;
      waitingState = null;
      update('abandonEnabled', false);
      if (restoredPresentation?.waitingStateEnteredAt != null) {
        presentationTimingOwner?.setPresentationTiming({ waitingStateEnteredAt: null });
      }
    }
    // Restore clean shutdown grace from persisted timestamp
    if (restoredPresentation?.cleanShutdownGraceStartedAt != null) {
      const elapsed = BigInt(Date.now()) - restoredPresentation.cleanShutdownGraceStartedAt;
      if (elapsed < GRACE_DELAY_MS) {
        update('cleanShutdownGraceActive', true);
        cleanShutdownGraceTimer = setTimeout(
          () => {
            cleanShutdownGraceTimer = null;
            update('cleanShutdownGraceActive', false);
            presentationTimingOwner?.setPresentationTiming({
              cleanShutdownGraceStartedAt: null,
            });
          },
          Number(GRACE_DELAY_MS - elapsed),
        );
      }
    }
    void walletOwner.resume(bcType);
  };
  const handleCloseTab = () => {
    hubConn?.disconnect();
    hubConn = null;
    void walletOwner.disconnect();
    walletOwner.stopLocalActivity();
    recovery.closeTab();
  };
  const cancelPendingMatchmaking = ({ preserveHub }: { preserveHub: boolean }) => {
    const durableState = storageRepository.loadState();
    const channelState =
      sessions.state.dashboardSessionModel?.channel.status.state ??
      savedChannelStatus(durableState);
    const hasPendingPrompt =
      sessions.state.pendingAdvisory !== null || sessions.state.pendingProposal !== null;
    const hasAttempt =
      peerSession !== null ||
      !!sessions.state.sessionConfig?.pairingToken ||
      durableState.session?.phase === 'live' ||
      durableState.session?.phase === 'pre-handshake';
    const accepting = isAcceptSessionTransition(sessions.state.transition);
    const shouldCancel = shouldCancelAttemptOnDisconnect(
      hasAttempt,
      sessions.state.sessionPhase,
      channelState,
      abandonPending,
    );
    if (hasPendingPrompt || shouldCancel || accepting) {
      const peerId =
        peerSession?.peerId ??
        sessions.state.pendingProposal?.from_id ??
        sessions.state.pendingAdvisory?.peer_id ??
        (durableState.session?.phase === 'live' || durableState.session?.phase === 'pre-handshake'
          ? durableState.session.pairing.peerId
          : undefined);
      if (accepting) {
        if (!preserveHub) storageRepository.updatePreference({ key: 'hubUrl', value: undefined });
        // abortAccept owns reject for Accept branches.
        abortAcceptIfActive(peerId ? { peerId } : undefined);
      } else {
        if (peerId) sendSessionReject(peerId);
        if (shouldCancel) {
          if (!preserveHub) storageRepository.updatePreference({ key: 'hubUrl', value: undefined });
          cancelAttemptedSession();
        } else {
          if (hasPendingPrompt) {
            setPendingAdvisoryState(null);
            setPendingProposalState(null);
            // Proposal path creates PeerSession before accept; drop it without
            // clearSessionPreservingHistory (keeps terminal snapshot / freeze).
            resetPeerRelayState();
          }
          if (!preserveHub) storageRepository.updatePreference({ key: 'hubUrl', value: undefined });
        }
      }
    } else if (!preserveHub) {
      storageRepository.updatePreference({ key: 'hubUrl', value: undefined });
    }
  };
  const doDisconnectHub = () => {
    invalidateHubConnectAttempts();
    cancelPendingMatchmaking({ preserveHub: false });
    hubConn?.disconnect();
    hubConn = null;
    storageRepository.clearHubIdentity();
    update('sessionId', '');
    setHubOrigin(null);
    update('iframeUrl', 'about:blank');
    update('hubLiveness', null);
    markPeerInactive();
  };
  const doDisconnectWallet = async () => {
    update('blockchainReady', false);
    await walletOwner.disconnect();
    // Pre-game wallet disconnect: drop the boot marker so reload does not
    // force Resume just for a prior blockchainType. Mid-session / resumable
    // state must keep the marker — otherwise boot skips Resume while the
    // cradle remains in IDB and can be clobbered by incidental saves.
    const durableSession = storageRepository.loadState().session;
    const hasResumableSession =
      sessions.state.sessionPhase !== 'none' ||
      durableSession?.phase === 'live' ||
      durableSession?.phase === 'pre-handshake' ||
      !!sessions.state.sessionConfig?.pairingToken;
    if (!hasResumableSession) {
      clearSavedSessionMarker();
    }
    // Clear the wallet preference without retiring the independently owned session.
    storageRepository.updateCommon({ preferences: { blockchainType: undefined } });
    // A wallet connection does not own the session or its pending consent.
    // Keep the handshake and peer transport; funding resumes when a wallet returns.
    hubConn?.setBusy(presenceBusy(sessions.state.sessionPhase, false));
  };
  const handleDisconnectWallet = () => {
    // Wallet disconnect no longer cascades to the hub or peer: the session
    // stays mounted and we appear busy. Warn only that chain ops stall while a
    // session is live.
    if (sessions.state.sessionPhase !== 'none') {
      update('confirmDialog', {
        title: 'Disconnect wallet?',
        body: 'You are in a session. Blockchain operations will stall until you reconnect a wallet, and you will appear busy to the hub.',
        onConfirm: () => {
          update('confirmDialog', null);
          doDisconnectWallet();
        },
      });
    } else {
      doDisconnectWallet();
    }
  };
  const handleDisconnectHub = () => {
    if (
      (state.peerLiveness === 'connected' || state.peerLiveness === 'degraded') &&
      sessions.state.sessionPhase === 'off-chain'
    ) {
      update('confirmDialog', {
        title: 'Disconnect from hub?',
        body: 'Disconnecting from this hub will end your peer connection. Your game stays off-chain — resolve it on-chain from the dashboard if needed.',
        onConfirm: () => {
          update('confirmDialog', null);
          doDisconnectHub();
        },
      });
    } else if (state.peerLiveness === 'connected' || state.peerLiveness === 'degraded') {
      update('confirmDialog', {
        title: 'Disconnect from hub?',
        body: 'This will end your peer connection.',
        onConfirm: () => {
          update('confirmDialog', null);
          doDisconnectHub();
        },
      });
    } else {
      doDisconnectHub();
    }
  };
  const startCleanShutdownGrace = () => {
    const presentationTimingOwner = sessionController;
    if (cleanShutdownGraceTimer !== null) {
      clearTimeout(cleanShutdownGraceTimer);
    }
    update('cleanShutdownGraceActive', true);
    presentationTimingOwner?.setPresentationTiming({
      cleanShutdownGraceStartedAt: BigInt(Date.now()),
    });
    cleanShutdownGraceTimer = setTimeout(() => {
      cleanShutdownGraceTimer = null;
      update('cleanShutdownGraceActive', false);
      presentationTimingOwner?.setPresentationTiming({ cleanShutdownGraceStartedAt: null });
    }, Number(GRACE_DELAY_MS));
  };
  const requestDashboardCleanShutdown = () => {
    startCleanShutdownGrace();
    setDashboardSessionModel((prev) =>
      prev ? { ...prev, channel: { ...prev.channel, cleanShutdownStarted: true } } : prev,
    );
    sessionController?.cleanShutdown();
  };
  const performDashboardGoOnChain = () => {
    if (!sessionController?.goOnChain('dashboard')) return;
    setSessionPhase('on-chain');
    hubConn?.setBusy(presenceBusy('on-chain'));
    peerSession?.markDead();
    syncPeerLiveness();
  };
  const requestDashboardGoOnChain = () => {
    const channelState = sessions.state.dashboardSessionModel?.channel.status.state;
    const isShutdownEscalation = channelState === 'ShuttingDown';
    update('confirmDialog', {
      title: isShutdownEscalation ? 'Go on-chain?' : 'Resolve on-chain?',
      body: isShutdownEscalation
        ? 'Clean shutdown is waiting for your opponent. Going on-chain abandons the cooperative close and resolves the session on-chain.'
        : 'You are in the middle of a hand. Going on-chain will force moves to happen but they may be much slower. Do you wish to proceed?',
      confirmLabel: 'Go On Chain',
      onConfirm: () => {
        update('confirmDialog', null);
        performDashboardGoOnChain();
      },
    });
  };
  const handleDashboardAction = (kind: GameDashboardActionKind) => {
    if (recovery.view.state.kind !== 'ready') return;
    switch (kind) {
      case 'cancel': {
        // During Accept, Cancel before the checkpoint write lands must not wipe
        // a finished freeze — same disposition as a pre-persist start failure.
        if (isAcceptSessionTransition(sessions.state.transition)) {
          const saved = storageRepository.loadState();
          const peerId =
            peerSession?.peerId ??
            (saved?.session?.phase === 'live' || saved?.session?.phase === 'pre-handshake'
              ? saved.session.pairing.peerId
              : undefined);
          // abortAccept owns reject for Accept Cancel.
          if (abortAcceptIfActive(peerId ? { peerId } : undefined)) break;
        }
        cancelDashboardSession();
        break;
      }
      case 'clean-shutdown':
        requestDashboardCleanShutdown();
        break;
      case 'go-on-chain':
        requestDashboardGoOnChain();
        break;
      case 'abandon':
        if (!isSessionAbandonable(sessions.state.dashboardSessionModel, state.abandonEnabled)) {
          update('confirmDialog', null);
          break;
        }
        update('confirmDialog', {
          title: 'Abandon session?',
          body: 'This will end the session immediately. Abandoning may result in a loss of funds if the on-chain resolution requires your participation.',
          confirmLabel: 'Abandon',
          onConfirm: () => {
            update('confirmDialog', null);
            if (!isSessionAbandonable(sessions.state.dashboardSessionModel, state.abandonEnabled))
              return;
            abandonActiveChannel();
          },
        });
        break;
      case 'none':
        break;
    }
  };
  const handleReconnect = () => {
    if (!state.walletView.walletType || state.walletView.connecting) return;
    handleConnect(state.walletView.walletType);
  };
  let lastChannelState: SessionModel['channel']['status']['state'] | null = null;
  function updateAbandonTimer() {
    const channelState = sessions.state.dashboardSessionModel?.channel.status.state ?? null;
    // Only channel transitions change this timer; unrelated publications must
    // not cancel a deadline restored before the first session projection.
    if (channelState === lastChannelState) return;
    lastChannelState = channelState;
    if (isAbandonWaitingState(channelState)) {
      if (waitingEnteredAt === null || waitingState !== channelState) {
        if (abandonTimer !== null) {
          clearTimeout(abandonTimer);
          abandonTimer = null;
        }
        const now = BigInt(Date.now());
        waitingEnteredAt = now;
        waitingState = channelState;
        update('abandonEnabled', false);
        sessionController?.setPresentationTiming({ waitingStateEnteredAt: now });
        abandonTimer = setTimeout(() => {
          abandonTimer = null;
          if (sessions.state.dashboardSessionModel?.channel.status.state !== channelState) return;
          update('abandonEnabled', true);
        }, Number(ABANDON_DELAY_MS));
      }
    } else if (channelState !== null) {
      if (abandonTimer !== null) {
        clearTimeout(abandonTimer);
        abandonTimer = null;
      }
      if (waitingEnteredAt !== null) {
        waitingEnteredAt = null;
        waitingState = null;
        sessionController?.setPresentationTiming({ waitingStateEnteredAt: null });
      }
      update('abandonEnabled', false);
    }
  }
  let stopHubLifecycle: (() => void) | undefined;
  let bootKind: string | undefined;
  function updateRecovery() {
    if (bootKind !== recovery.view.state.kind) {
      bootKind = recovery.view.state.kind;
      stopHubLifecycle?.();
      stopHubLifecycle = (() => {
        if (recovery.view.state.kind !== 'ready' && recovery.view.state.kind !== 'autoResuming') {
          hubConn?.disconnect();
          hubConn = null;
          return;
        }
        const origin = storageRepository.query('hubUrl');
        let cancelled = false;
        if (origin && !hubConn) {
          void requestHubTrust(origin).then((trust) => {
            if (cancelled) return;
            const trustError = hubTrustError(trust, origin);
            if (trustError !== null) {
              if (trust === 'invalid') {
                storageRepository.updatePreference({ key: 'hubUrl', value: undefined });
              }
              update('hubConnectionError', trustError);
              return;
            }
            if (trust === 'granted') {
              storageRepository.updatePreference({ key: 'hubUrl', value: origin });
              window.location.reload();
              return;
            }
            connectToHub(origin);
          });
        }
        return () => {
          cancelled = true;
          invalidateHubConnectAttempts();
          hubConn?.disconnect();
          hubConn = null;
        };
      })();
    }
    (() => {
      if (recovery.view.state.kind !== 'autoResuming') return;
      if (!sessions.state.sessionConfig || !sessions.state.peerConn) return;
      if (sessions.state.restoreStatus === 'failed') {
        recovery.revealReady();
        return;
      }
      const restoring = !!sessions.state.sessionConfig.restoring;
      const blocked = isRestoreBlocked(restoring, sessions.state.restoreStatus);
      const { keepSession } = shouldMountGameSession(
        true,
        state.walletView.connected,
        restoring,
        sessionStarted,
      );
      if (keepSession && !blocked) {
        recovery.revealReady();
      }
    })();
  }
  function updateReadiness() {
    const ready = !!state.hubOrigin && state.walletView.connected && walletOwner.ready();
    update('blockchainReady', ready);
    hubConn?.setBusy(hubPresenceNow());
  }
  function syncSessionExecution() {
    if (
      recovery.view.startingOver ||
      (recovery.view.state.kind !== 'ready' && recovery.view.state.kind !== 'autoResuming')
    )
      return;
    const params = sessions.state.sessionConfig;
    const peer = sessions.state.peerConn;
    if (!params || !peer) {
      detachSessionEvents?.();
      detachSessionEvents = undefined;
      frontend = null;
      sessionPresentation = null;
      return;
    }
    if (state.terminalPresentation || sessionFinishedCleanup) return;
    const mount = shouldMountGameSession(
      true,
      state.walletView.connected,
      !!params.restoring,
      sessionStarted,
    );
    if (!mount.keepSession) return;
    if (mount.startSession) sessionStarted = true;
    const wallet = walletOwner.sessionAccess();
    const created = sessionController === null;
    const controller = (sessionController ??= createSessionController(
      wallet,
      peer,
      uniqueId,
      params.myContribution,
      params.theirContribution,
      params.iStarted,
      sessionBootstrap,
      params.pairingToken,
      params.perGameAmount,
      () => storageRepository.query('defaultFee'),
    ));
    if (params.myAlias) controller.myAlias = params.myAlias;
    if (params.opponentAlias) controller.opponentAlias = params.opponentAlias;
    if (frontend !== controller.frontend) {
      detachSessionEvents?.();
      frontend = controller.frontend;
      resolvedPhaseReported = false;
      resolving = null;
      if (created) {
        controller.setTransactionPublishNerfed(state.transactionPublishNerfed);
        startSession(controller, wallet, params);
      }
      const source = frontend;
      detachSessionEvents = source.subscribe((event) => {
        if (frontend !== source) return;
        if (event.type === 'batch-complete') batch(() => presentSession(event.presentation));
        else if (event.type === 'readiness') {
          if (sessionPresentation) {
            sessionPresentation = { ...sessionPresentation, channelReady: event.ready };
            publish();
          }
        } else if (event.type === 'publishing-policy') {
          update('transactionPublishNerfed', event.nerfed);
        } else if (sessionPresentation) reportSessionPhase(sessionPresentation);
      });
      batch(() => presentSession(source.snapshot()));
    }
    controller.setWallet(wallet);
  }
  function startSession(
    controller: SessionController,
    wallet: SessionWallet | null,
    params: GameSessionParams,
  ) {
    if (sessionBootstrap?.state.session?.phase === 'live') {
      const bootstrap = sessionBootstrap;
      const restore = async () => {
        try {
          await restoreSession(controller, bootstrap, await ensureWasmLoaded());
        } catch (error) {
          console.error('[sessionController] restoreSession error:', error);
          log(`[sessionController] restoreSession error: ${String(error)}`);
          if (sessionController === controller) destroySessionController();
          throw error;
        }
      };
      void controller.beginRestore(restore()).catch(() => {});
      return;
    }
    void (async () => {
      try {
        if (!wallet) throw new Error('Cannot start a new session without a blockchain connection');
        // Preserve the accepted checkpoint before an asset fetch can trigger a deploy reload.
        await storageRepository.checkpointDomainMutations();
        if (sessionController !== controller) return;
        const snapshot = storageRepository.patchApplicationState(clearGameSessionState);
        await storageRepository.write(snapshot);
        if (sessionController !== controller) return;
        const wasm = await ensureWasmLoaded();
        if (sessionController !== controller) return;
        await configSessionController(
          controller,
          params.iStarted,
          wasm,
          wallet,
          Number(params.channelTimeout ?? DEFAULT_CHANNEL_TIMEOUT_BLOCKS),
          Number(params.unrollTimeout ?? DEFAULT_UNROLL_TIMEOUT_BLOCKS),
        );
      } catch (error) {
        if (sessionController !== controller) return;
        const message =
          error instanceof Error
            ? error.stack || error.message
            : typeof error === 'object' && error !== null && 'data' in error
              ? ((error as any).data?.error ?? String(error))
              : String(error);
        console.error('[sessionController] newSession error:', message);
        log(`[sessionController] newSession error: ${message}`);
        controller.receiveEvent({ type: 'error', error: message });
      }
    })();
  }
  function reportSessionPhase(presentation: SessionPresentation) {
    const { model, phase } = presentation;
    const blocked = shouldSuppressPhaseReporting(
      isRestoreBlocked(!!sessions.state.sessionConfig?.restoring, sessions.state.restoreStatus),
      state.terminalPresentation != null,
    );
    if (!shouldReportSessionPhase(phase, blocked, resolvedPhaseReported)) return;
    const terminal = selectGameSessionView(model).gameTerminal;
    const hasError =
      model.channel.status.state === 'Failed' ||
      model.channel.status.state === 'ResolvedStale' ||
      terminal.type === 'game-error' ||
      (terminal.type === 'settled' &&
        terminal.outcome != null &&
        isErrorSettlementOutcome(terminal.outcome));
    if (phase !== 'resolved') {
      handleSessionPhaseChange(phase, hasError);
      return;
    }
    if (resolving) return;
    // Terminal finalization waits for the runtime's current drain before sealing it.
    const source = frontend;
    const report = Promise.resolve()
      .then(async (): Promise<boolean> => {
        if (frontend !== source) return false;
        return (await handleSessionPhaseChange(phase, hasError)) === true;
      })
      .then((completed) => {
        if (frontend === source && completed === true) resolvedPhaseReported = true;
      })
      .finally(() => {
        if (resolving === report) resolving = null;
      });
    resolving = report;
  }
  function presentSession(next: SessionPresentation) {
    const previous = sessionPresentation;
    sessionPresentation = next;
    handleRestoreStatusChange(next.model.restore.status, next.model.restore.error);
    handleSessionModelChange(next.model);
    if (!state.terminalPresentation) handleCoinsChange(next.coins);
    reportSessionPhase(next);
    if (previous) {
      const before = selectGameSessionView(previous.model),
        after = selectGameSessionView(next.model);
      if (
        gameModelNeedsGameTabAttention(previous.model.game, next.model.game) ||
        acceptedHandNeedsGameTabAttention(
          previous.model.game.handKey,
          next.model.game.handKey,
          next.model.game.currentHandIds,
        ) ||
        after.gameQueue.length > before.gameQueue.length ||
        after.channelQueue.length > before.channelQueue.length ||
        (next.model.betweenHand.mode === 'review-incoming-proposal' &&
          previous.model.betweenHand.mode !== 'review-incoming-proposal') ||
        peerProposalIdNeedsGameTabAttention(
          before.incomingProposal?.id ?? null,
          after.incomingProposal?.id ?? null,
        ) ||
        (channelStateNeedsGameTabAttention(next.model.channel.status.state) &&
          !channelStateNeedsGameTabAttention(previous.model.channel.status.state))
      )
        onGameActivity();
    }
    publish();
  }
  function snapshot() {
    const { peerConn: _peer, ...sessionState } = sessions.state;
    const { confirmDialog, ...presentation } = state;
    return {
      ...presentation,
      ...sessionState,
      alias: storageRepository.query('alias'),
      theme: storageRepository.query('theme'),
      keepSession: shouldMountGameSession(
        !!sessions.state.sessionConfig && !!sessions.state.peerConn,
        state.walletView.connected,
        !!sessions.state.sessionConfig?.restoring,
        sessionStarted,
      ).keepSession,
      sessionPresentation,
      sessionFrontend: frontend ? { dispatch: frontend.dispatch, game: frontend.game } : null,
      bootState:
        recovery.view.state.kind === 'tabConflict'
          ? { kind: 'tabConflict' as const, midSession: recovery.view.state.midSession }
          : recovery.view.state,
      resuming: recovery.view.resuming,
      startingOver: recovery.view.startingOver,
      networkLocked: sessionLocksNetwork(
        sessions.state.sessionPhase,
        storageRepository.loadState().session?.phase,
        sessions.state.sessionConfig?.pairingToken,
      ),
      restoreBlocked: isRestoreBlocked(
        !!sessions.state.sessionConfig?.restoring,
        sessions.state.restoreStatus,
      ),
      confirmDialog: confirmDialog
        ? {
            title: confirmDialog.title,
            body: confirmDialog.body,
            confirmLabel: confirmDialog.confirmLabel,
          }
        : null,
    };
  }
  function dispatch(intent: ApplicationIntent): void | Promise<void> {
    return batch(() => applyIntent(intent));
  }
  function applyIntent(intent: ApplicationIntent): void | Promise<void> {
    switch (intent.type) {
      case 'resume':
        return recovery.resume();
      case 'reset':
        return recovery.retryHardReset();
      case 'takeover':
        return recovery.takeOver();
      case 'close-tab':
        return handleCloseTab();
      case 'wallet-connect':
        return handleConnect(intent.wallet, false, intent.fresh ?? false);
      case 'wallet-finalize':
        return walletOwner.finalize(intent.values).then((connected) => {
          if (connected) setActiveTab('hub');
        });
      case 'wallet-cancel':
        return walletOwner.cancel();
      case 'wallet-disconnect':
        return handleDisconnectWallet();
      case 'wallet-reconnect':
        return handleReconnect();
      case 'hub-connect':
        return requestHubConnect(intent.origin);
      case 'hub-retry':
        if (state.hubOrigin) connectToHub(state.hubOrigin);
        return;
      case 'hub-disconnect':
        return handleDisconnectHub();
      case 'accept-session':
        if (sessions.state.pendingAdvisory)
          return acceptPendingAdvisory(sessions.state.pendingAdvisory);
        if (sessions.state.pendingProposal)
          return acceptPendingProposal(sessions.state.pendingProposal);
        return;
      case 'decline-session':
        if (sessions.state.pendingAdvisory)
          return declinePendingAdvisory(sessions.state.pendingAdvisory);
        if (sessions.state.pendingProposal)
          return declinePendingProposal(sessions.state.pendingProposal);
        return;
      case 'tab':
        return handleTabChange(intent.tab);
      case 'network':
        return handleNetworkChange(intent.network);
      case 'fee':
        storageRepository.updatePreference({ key: 'defaultFee', value: intent.fee });
        update('defaultFee', intent.fee);
        return;
      case 'fee-unit':
        storageRepository.updatePreference({ key: 'feeUnit', value: intent.unit });
        update('feeUnit', intent.unit);
        return;
      case 'theme':
        storageRepository.updatePreference({ key: 'theme', value: intent.theme });
        publish();
        return;
      case 'session-action':
        return handleDashboardAction(intent.action);
      case 'toggle-publish':
        return toggleTransactionPublishNerf();
      case 'history':
        return appendHistory(intent.line);
      case 'confirm':
        return state.confirmDialog?.onConfirm();
      case 'cancel-confirmation':
        update('confirmDialog', null);
        return;
    }
  }
  return {
    snapshot,
    dispatch,
    start() {
      started = true;
      const cleanup = [
        walletOwner.start(),
        recovery.start(),
        subscribeLog((line) =>
          deferStateUpdate(() => {
            const next = appendDiagnosticEntry(state.logLines, line);
            update('logLines', next);
            storageRepository.updateCommon({ history: { diagnosticLog: next } });
          }),
        ),
        (() => {
          const onBeforeUnload = (event: BeforeUnloadEvent) => {
            if (!shouldWarnOnSessionUnload(sessions.state.sessionPhase)) return;
            event.preventDefault();
            event.returnValue = '';
          };
          const cleanup = (event: PageTransitionEvent) => {
            if (event.persisted) return;
            releaseLeaseIfOwner();
            hubConn?.disconnect();
            // WalletConnect / Cloud Wallet sessions are durable across reloads.
            // Calling disconnect() on WC sends session_delete; on Cloud it wipes OAuth tokens.
            walletOwner.leavePage();
          };
          window.addEventListener('beforeunload', onBeforeUnload);
          window.addEventListener('pagehide', cleanup);
          return () => {
            window.removeEventListener('beforeunload', onBeforeUnload);
            window.removeEventListener('pagehide', cleanup);
          };
        })(),
        stopSessionTimers,
        (() => {
          const id = setInterval(() => {
            const now = Date.now();
            const activityFresh = lastHubActivity > 0 && now - lastHubActivity <= 45000;
            update('hubLiveness', (prev) => {
              if (prev === null || prev === 'disconnected') return prev;
              if (!hubWsUp) return 'reconnecting';
              return activityFresh ? 'connected' : 'inactive';
            });
            const ps = peerSession;
            if (ps && ps.liveness !== 'dead' && ps.liveness !== null) {
              const stale = ps.lastActivity > 0 && now - ps.lastActivity > 30000;
              if (stale && ps.liveness === 'connected') {
                ps.markDegraded();
                update('peerLiveness', 'degraded');
              }
            }
          }, 5000);
          return () => clearInterval(id);
        })(),
      ];
      publish();
      return () => {
        started = false;
        for (const stop of cleanup) stop?.();
        stopHubLifecycle?.();
        bootKind = undefined;
        disposeRejections();
        detachSessionEvents?.();
        detachSessionEvents = undefined;
        frontend = null;
      };
    },
    subscribe(listener: (event: ApplicationEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
