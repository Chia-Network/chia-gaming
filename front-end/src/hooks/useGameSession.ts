import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EMPTY, Subject } from 'rxjs';
import {
  createComposeDraftState,
  createSessionModel,
  DEFAULT_CHANNEL_TIMEOUT_BLOCKS,
  DEFAULT_GAME_TIMEOUT_BLOCKS,
  DEFAULT_UNROLL_TIMEOUT_BLOCKS,
  selectGameSessionView,
  selectGameSpecificView,
  selectIProposedHand,
  selectSessionPhase,
  sessionModelFromSave,
  type HandProposal,
} from '../lib/session/model';
import type { ComposeDraftValue, GameplayEvent, HandWinOutcome } from '@games/host';
import { dispatchWasmNotification } from '../lib/session/gameSessionEvents';
import { gameplayEventForGameActionError } from '../lib/wasm/gameplayEvents';
import { createSessionMachineState } from '../lib/session/sessionMachine';
import { SessionMachineRuntime } from '../lib/session/sessionMachineRuntime';
import {
  projectTerminalSessionResult,
  type TerminalSessionPresentation,
  type UseGameSessionResult,
  useTerminalSessionPresentation,
} from '../lib/session/sessionResult';
import type { SessionMachineEvent } from '../lib/session/sessionMachineTypes';
import type { RegisteredGameType } from '../lib/session/types';
import { REGISTERED_GAMES } from '../lib/gameRegistry';
import { liveGameHandOrigin, type GameHandSource } from '@games/host';
import { log } from '../services/log';
import type { GameSessionParams, PeerConnectionResult, WasmEvent } from '../types/ChiaGaming';
import type { BlockchainPoller } from './BlockchainPoller';
import { getOrCreateSessionController, initStarted, setInitStarted } from './blobSingleton';
import type { SessionController } from './SessionController';
import type { SessionSave } from './save';
import { getDefaultFee, getPlayerId } from './save';

export type {
  GameTerminalAttentionInfo,
  GameTerminalInfo,
  QueuedNotification,
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

  const restoredModel = useMemo(
    () => (sessionSave ? sessionModelFromSave(sessionSave) : null),
    [sessionSave],
  );
  const restoredHandKeyRef = useRef<number | null>(null);
  const gameplaySubject = useRef(new Subject<GameplayEvent>()).current;
  const gameplayEvent$ = useMemo(() => gameplaySubject.asObservable(), [gameplaySubject]);
  const initialState = useMemo(() => {
    const handProposal: HandProposal = {
      gameType: REGISTERED_GAMES[0].gameType,
      myContribution: perGameAmount,
      theirContribution: perGameAmount,
      gameTimeout: DEFAULT_GAME_TIMEOUT_BLOCKS,
    };
    return createSessionMachineState(
      restoredModel ??
        createSessionModel({
          channel: { cleanShutdownStarted: controller.cleanShutdownCalled },
          betweenHand: {
            lastHandProposal: null,
            compose: createComposeDraftState(perGameAmount, handProposal),
          },
        }),
      {
        firstGameAccepted:
          sessionSave?.phase === 'live' &&
          sessionSave.presentation.channelStatus?.state === 'Active',
      },
    );
  }, [controller, perGameAmount, restoredModel, sessionSave]);
  const runtimeRef = useRef<SessionMachineRuntime | null>(null);
  if (!runtimeRef.current) {
    restoredHandKeyRef.current = restoredModel?.game.handState ? restoredModel.game.handKey : null;
    runtimeRef.current = new SessionMachineRuntime(initialState, {
      controller,
      iStarted,
      restoring: params.restoring ?? false,
      getRestoreStatus: () => controller.getRestoreStatus(),
      getRestoreError: () => controller.getRestoreError(),
      emitGameplay: (event) => gameplaySubject.next(event),
      onError: (error) => controller.reportRuntimeError(error),
    });
  }
  const runtime = runtimeRef.current;
  const [machineState, setMachineState] = useState(runtime.getState());
  const liveGamePort = useMemo(
    () => ({
      isChannelReady: () => controller.isChannelReady(),
      nerf: () => controller.nerf(),
      transitionFeatureState: (gameType: string, id: string, state: unknown) =>
        runtime.transitionFeatureState(gameType as RegisteredGameType, id, state),
      transitionFeatureStateWithLocalTurn: (
        gameType: string,
        id: string,
        state: unknown,
        isMyTurn: boolean,
      ) =>
        runtime.transitionFeatureStateWithLocalTurn(
          gameType as RegisteredGameType,
          id,
          state,
          isMyTurn,
        ),
      commitLocalGameAction: (request: Parameters<typeof runtime.commitLocalGameAction>[0]) =>
        runtime.commitLocalGameAction(request),
    }),
    [controller, runtime],
  );
  const liveHandSource = useMemo<GameHandSource>(
    () => ({
      interactionMode: 'live',
      handState: machineState.model.game.handState,
      port: liveGamePort,
    }),
    [liveGamePort, machineState.model.game.handState],
  );
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
    controller.onSaveNeeded = () => runtime.persist();
    return () => {
      controller.onSaveNeeded = null;
    };
  }, [controller, runtime, terminalMode]);

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
    (gameType: HandProposal['gameType']) => dispatch({ type: 'select-compose-game', gameType }),
    [dispatch],
  );
  const updateSelectedComposeDraft = useCallback(
    (draft: Partial<ComposeDraftValue>) =>
      dispatch({ type: 'update-selected-compose-draft', draft }),
    [dispatch],
  );
  const onHandOutcome = useCallback(
    (outcome: HandWinOutcome) =>
      dispatch({ type: 'hand-outcome', outcomeWin: outcome.my_win_outcome }),
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
    handOrigin: liveGameHandOrigin(restoredHandKeyRef.current, model.game.handKey),
    activeGameId: view.activeGameId,
    activeGameIds: view.activeGameIds,
    currentHandGameIds: model.game.currentHandIds,
    iProposedHand: selectIProposedHand(model),
    activeGameType: view.activeGameType,
    displayGameId: view.displayGameId,
    handSource: liveHandSource,
    gameplayEvent$,
    appendGameLog,
    onHandOutcome,
    onTurnChanged,
    betweenHandMode: model.betweenHand.mode,
    incomingProposalGroup: view.incomingProposalGroup,
    lastHandProposal: model.betweenHand.lastHandProposal,
    composeDraftState: compose,
    chooseNewHandSameTerms: () => dispatch({ type: 'choose-same-terms' }),
    chooseDoNotUseCurrentProposal: () => dispatch({ type: 'reject-current-proposal' }),
    openComposeProposal: () => dispatch({ type: 'open-compose' }),
    setComposeGameTimeout,
    setComposeGameType,
    updateSelectedComposeDraft,
    composeProposalSent: compose.proposalSent,
    newHandRequested: model.betweenHand.newHandRequested,
    submitComposedProposal: (handProposal) => dispatch({ type: 'submit-compose', handProposal }),
    acceptReviewedProposal: () => dispatch({ type: 'accept-review' }),
    rejectReviewedProposal: () => dispatch({ type: 'reject-review' }),
    startCleanShutdown: () => dispatch({ type: 'start-clean-shutdown' }),
    cleanShutdownStarted: model.channel.cleanShutdownStarted,
    goOnChain: () => dispatch({ type: 'go-on-chain' }),
    betweenHands: view.betweenHands,
    lastOutcomeWin: coordination.lastOutcomeWin,
    restoredOutcomeWin:
      sessionSave?.phase === 'live' || sessionSave?.phase === 'terminal'
        ? (sessionSave.presentation.lastOutcomeWin ?? undefined)
        : undefined,
    restoreStatus: model.restore.status,
    restoreError: model.restore.error,
    sessionPhase,
    channelQueue: view.channelQueue,
    gameQueue: view.gameQueue,
    dismissChannel: () => dispatch({ type: 'dismiss-channel' }),
    dismissGame: () => dispatch({ type: 'dismiss-game-notification' }),
    gameSpecificView,
  };
  return terminalState.presentation
    ? projectTerminalSessionResult(liveResult, terminalState.presentation, EMPTY, terminalState)
    : liveResult;
}
