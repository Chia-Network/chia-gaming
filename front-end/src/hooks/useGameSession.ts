import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EMPTY, Subject } from 'rxjs';
import type { CalpokerOutcome } from '../features/calPoker/outcome';
import {
  createComposeDraftState,
  createSessionModel,
  DEFAULT_CHANNEL_TIMEOUT_BLOCKS,
  DEFAULT_GAME_TIMEOUT_BLOCKS,
  DEFAULT_UNROLL_TIMEOUT_BLOCKS,
  selectGameSessionView,
  selectGameSpecificView,
  selectSessionPhase,
  sessionModelFromSave,
  type ComposeDraftState,
  type HandTermsModel,
} from '../lib/session/model';
import {
  dispatchWasmNotification,
  gameplayEventForGameActionError,
  type GameplayEvent,
} from '../lib/session/gameSessionEvents';
import { createSessionMachineState } from '../lib/session/sessionMachine';
import { SessionMachineRuntime } from '../lib/session/sessionMachineRuntime';
import {
  projectTerminalSessionResult,
  type TerminalSessionPresentation,
  type UseGameSessionResult,
  useTerminalSessionPresentation,
} from '../lib/session/sessionResult';
import type { SessionMachineEvent } from '../lib/session/sessionMachineTypes';
import { log } from '../services/log';
import type { GameSessionParams, PeerConnectionResult, WasmEvent } from '../types/ChiaGaming';
import type { BlockchainPoller } from './BlockchainPoller';
import { getOrCreateSessionController, initStarted, setInitStarted } from './blobSingleton';
import type { SessionController } from './SessionController';
import type { SessionSave } from './save';
import { getDefaultFee, getPlayerId } from './save';
import { createFrozenHandBridge } from './frozenHandBridge';

export type {
  GameplayEvent,
  GameTerminalAttentionInfo,
  GameTerminalInfo,
  HandTerms,
  QueuedNotification,
} from '../lib/session/gameSessionEvents';
export {
  activeIdsAfterProposalAccepted,
  clearProposalTerms,
  clearProposalTracking,
  dispatchWasmNotification,
  gameplayEventForActionFailed,
  gameplayEventForGameActionError,
  gameplayEventForMoveRejected,
  gameplayEventsForGameStatus,
  outgoingProposalGroups,
  outgoingProposalTerms,
  parseGameStatusTerminalInfo,
  parseTermsFromNotificationValue,
  proposalGroupMap,
  removeProposalGroupFromHand,
  settledEventForInfo,
  terminalInfoFromGameSettled,
} from '../lib/session/gameSessionEvents';
export type { UseGameSessionResult } from '../lib/session/sessionResult';

export function useSessionControllerAfterCommit(
  params: GameSessionParams,
  peerConn: PeerConnectionResult,
  registerMessageHandler: (
    handler: (msgno: number, msg: Uint8Array) => void,
    ackHandler: (ack: number) => void,
    keepaliveHandler: () => void,
  ) => void,
  sessionSave?: SessionSave,
  blockchain: BlockchainPoller | null = null,
  terminalMode = false,
): SessionController | null {
  const [controller, setController] = useState<SessionController | null>(null);
  useEffect(() => {
    if (terminalMode) return;
    const next = getOrCreateSessionController(
      blockchain,
      peerConn,
      registerMessageHandler,
      getPlayerId(),
      params.myContribution,
      params.theirContribution,
      params.iStarted,
      sessionSave,
      params.pairingToken,
      params.perGameAmount,
      getDefaultFee,
      Number(params.channelTimeout ?? DEFAULT_CHANNEL_TIMEOUT_BLOCKS),
      Number(params.unrollTimeout ?? DEFAULT_UNROLL_TIMEOUT_BLOCKS),
    ).sessionController;
    if (params.myAlias) next.myAlias = params.myAlias;
    if (params.opponentAlias) next.opponentAlias = params.opponentAlias;
    setController((current) => (current === next ? current : next));
  }, [
    blockchain,
    params.channelTimeout,
    params.iStarted,
    params.myAlias,
    params.myContribution,
    params.opponentAlias,
    params.pairingToken,
    params.perGameAmount,
    params.theirContribution,
    params.unrollTimeout,
    peerConn,
    registerMessageHandler,
    sessionSave,
    terminalMode,
  ]);
  return controller;
}

export function useGameSession(
  params: GameSessionParams,
  controller: SessionController,
  appendGameLog: (line: string) => void,
  sessionSave?: SessionSave,
  blockchain: BlockchainPoller | null = null,
  terminalPresentation?: TerminalSessionPresentation | null,
): UseGameSessionResult {
  const { iStarted, perGameAmount } = params;
  const terminalState = useTerminalSessionPresentation(terminalPresentation);
  const terminalMode = terminalState.presentation != null;
  const frozenBridge = useMemo(
    () => createFrozenHandBridge(terminalState.presentation?.model.game.handState ?? null),
    [terminalState.presentation?.model.game.handState],
  );

  const restoredModel = useMemo(
    () => (sessionSave ? sessionModelFromSave(sessionSave, perGameAmount) : null),
    [sessionSave, perGameAmount],
  );
  const gameplaySubject = useRef(new Subject<GameplayEvent>()).current;
  const gameplayEvent$ = useMemo(() => gameplaySubject.asObservable(), [gameplaySubject]);
  const initialState = useMemo(() => {
    const terms: HandTermsModel = {
      gameType: 'calpoker',
      myContribution: perGameAmount,
      theirContribution: perGameAmount,
      gameTimeout: DEFAULT_GAME_TIMEOUT_BLOCKS,
    };
    return createSessionMachineState(
      restoredModel ??
        createSessionModel({
          channel: { cleanShutdownStarted: controller.cleanShutdownCalled },
          betweenHand: {
            lastTerms: terms,
            compose: createComposeDraftState(perGameAmount, terms),
          },
        }),
      {
        firstGameAccepted: sessionSave?.channelStatus?.state === 'Active',
        iProposedHand: sessionSave?.iProposedHand ?? false,
      },
    );
  }, [controller, perGameAmount, restoredModel, sessionSave]);
  const runtimeRef = useRef<SessionMachineRuntime | null>(null);
  if (!runtimeRef.current) {
    runtimeRef.current = new SessionMachineRuntime(initialState, {
      controller,
      iStarted,
      restoring: params.restoring ?? false,
      getRestoreStatus: () => controller.getRestoreStatus(),
      getRestoreError: () => controller.getRestoreError(),
      emitGameplay: (event) => gameplaySubject.next(event),
      onError: (error) => {
        console.error('[session machine effect]', error);
      },
    });
  }
  const runtime = runtimeRef.current;
  const [machineState, setMachineState] = useState(runtime.getState());
  useEffect(() => {
    runtime.setRender(setMachineState);
    return () => runtime.setRender(() => {});
  }, [runtime]);
  const dispatch = useCallback((event: SessionMachineEvent) => runtime.dispatch(event), [runtime]);
  const dispatchHostProjection = useCallback(() => {
    const status = controller.getRestoreStatus();
    dispatch({
      type: 'host-projection',
      restore: {
        restoring: params.restoring ?? false,
        status,
        error: controller.getRestoreError(),
        hubReconciled: status === 'restored',
      },
      wasmNotificationHistory: controller.wasmNotificationHistory,
      diagnosticLog: controller.diagnosticLog,
      lastOutcomeWin: controller.lastOutcomeWin,
    });
  }, [controller, dispatch, params.restoring]);

  useEffect(() => {
    if (terminalMode) return;
    return controller.onRestoreStatusChange(() => {
      dispatchHostProjection();
    });
  }, [controller, dispatchHostProjection, terminalMode]);

  useEffect(() => {
    if (terminalMode) return;
    controller.onFeatureStateTransition = (gameType, id, state) => {
      return runtime.transitionFeatureState(gameType, id, state);
    };
    controller.onSaveNeeded = () => runtime.persist();
    return () => {
      controller.onFeatureStateTransition = null;
      controller.onSaveNeeded = null;
    };
  }, [controller, dispatch, runtime, terminalMode]);

  useEffect(() => {
    if (terminalMode) return;
    const subscription = controller.getObservable().subscribe({
      next: (event: WasmEvent) => {
        switch (event.type) {
          case 'notification':
            dispatchWasmNotification(
              event.data,
              (notification) => dispatch({ type: 'wasm-notification', notification, iStarted }),
              (error) =>
                dispatch({ type: 'enqueue-error', kind: 'infra-error', message: String(error) }),
            );
            dispatchHostProjection();
            break;
          case 'error':
            dispatch({ type: 'enqueue-error', kind: 'infra-error', message: event.error });
            break;
          case 'game-action-error':
            if (event.action !== 'feature-state') {
              gameplaySubject.next(
                gameplayEventForGameActionError(event.gameId, event.action, event.error),
              );
            }
            dispatch({ type: 'enqueue-error', kind: 'action-failed', message: event.error });
            break;
          case 'durability-error':
            dispatch({ type: 'enqueue-error', kind: 'durability-error', message: event.error });
            break;
          case 'log':
            log(`[wasm] ${event.message}`);
            dispatchHostProjection();
            break;
          case 'address':
            break;
        }
      },
    });
    if (!initStarted) setInitStarted(true);
    return () => subscription.unsubscribe();
  }, [controller, dispatch, dispatchHostProjection, gameplaySubject, iStarted, terminalMode]);

  useEffect(() => {
    if (!blockchain || terminalMode) return;
    controller.attachBlockchain(blockchain);
    return () => controller.detachBlockchain(blockchain);
  }, [blockchain, controller, terminalMode]);

  useEffect(
    () => () => {
      runtime.dispose();
    },
    [runtime],
  );
  useEffect(() => {
    if (terminalMode) runtime.dispose();
  }, [runtime, terminalMode]);

  const setComposeGameTimeout = useCallback(
    (timeout: bigint) => dispatch({ type: 'set-compose-timeout', timeout }),
    [dispatch],
  );
  const setComposeGameType = useCallback(
    (gameType: HandTermsModel['gameType']) => dispatch({ type: 'select-compose-game', gameType }),
    [dispatch],
  );
  const setCalpokerComposeAmount = useCallback(
    (amount: bigint) => dispatch({ type: 'set-compose-amount', gameType: 'calpoker', amount }),
    [dispatch],
  );
  const setKrunkComposeAmount = useCallback(
    (amount: bigint) => dispatch({ type: 'set-compose-amount', gameType: 'krunk', amount }),
    [dispatch],
  );
  const setSpacepokerComposeDraft = useCallback(
    (draft: Partial<ComposeDraftState['spacepoker']>) =>
      dispatch({ type: 'set-spacepoker-compose', draft }),
    [dispatch],
  );
  const onHandOutcome = useCallback(
    (outcome: CalpokerOutcome) => dispatch({ type: 'hand-outcome', outcome }),
    [dispatch],
  );
  const onTurnChanged = useCallback(
    (id: string, isMyTurn: boolean) =>
      dispatch({
        type: 'durable-local-turn',
        id,
        isMyTurn,
        channelState: runtime.getState().model.channel.status.state,
      }),
    [dispatch, runtime],
  );

  const { model, coordination } = machineState;
  const view = selectGameSessionView(model);
  const gameSpecificView = selectGameSpecificView(model);
  const compose = model.betweenHand.compose;
  const sessionPhase = selectSessionPhase(model, coordination.hostOnChain);

  const liveResult: UseGameSessionResult = {
    sessionModel: model,
    gameConnectionState: model.channel.connection,
    perGameAmount,
    currentHandAmount: view.currentHandAmount,
    myRunningBalance: model.myRunningBalance,
    iStarted,
    playerNumber: iStarted ? 1 : 2,
    channelStatus: view.channelStatus,
    gameCoin: view.gameCoin,
    gameTerminal: view.gameTerminal,
    handKey: model.game.handKey,
    activeGameId: view.activeGameId,
    activeGameIds: view.activeGameIds,
    currentHandGameIds: model.game.currentHandIds,
    iProposedHand: coordination.iProposedHand,
    activeGameType: view.activeGameType,
    displayGameId: view.displayGameId,
    sessionController: controller,
    gameplayEvent$,
    appendGameLog,
    onHandOutcome,
    onTurnChanged,
    betweenHandMode: model.betweenHand.mode,
    cachedPeerProposal: model.betweenHand.cachedPeerProposal,
    reviewPeerProposal: model.betweenHand.reviewPeerProposal,
    lastHandTerms: model.betweenHand.lastTerms,
    composeDraftState: compose,
    chooseNewHandSameTerms: () => dispatch({ type: 'choose-same-terms' }),
    chooseDoNotUseCurrentProposal: () => dispatch({ type: 'reject-current-proposal' }),
    openComposeProposal: () => dispatch({ type: 'open-compose' }),
    setComposeGameTimeout,
    setComposeGameType,
    setCalpokerComposeAmount,
    setKrunkComposeAmount,
    setSpacepokerComposeDraft,
    composeProposalSent: compose.proposalSent,
    newHandRequested: model.betweenHand.newHandRequested,
    submitComposedProposal: (terms) => dispatch({ type: 'submit-compose', terms }),
    acceptReviewedProposal: () => dispatch({ type: 'accept-review' }),
    rejectReviewedProposal: () => dispatch({ type: 'reject-review' }),
    startCleanShutdown: () => dispatch({ type: 'start-clean-shutdown' }),
    cleanShutdownStarted: model.channel.cleanShutdownStarted,
    goOnChain: () => dispatch({ type: 'go-on-chain' }),
    betweenHands: view.betweenHands,
    lastOutcome: coordination.lastOutcome,
    restoredOutcomeWin: sessionSave?.lastOutcomeWin,
    restoreStatus: model.restore.status,
    restoreError: model.restore.error,
    sessionPhase,
    channelQueue: view.channelQueue,
    gameQueue: view.gameQueue,
    dismissChannel: () => dispatch({ type: 'dismiss-channel' }),
    dismissGame: () => dispatch({ type: 'dismiss-game-notification' }),
    gameSpecificView,
    interactionMode: 'live',
  };
  return terminalState.presentation
    ? projectTerminalSessionResult(
        liveResult,
        terminalState.presentation,
        frozenBridge,
        EMPTY,
        terminalState,
      )
    : liveResult;
}
