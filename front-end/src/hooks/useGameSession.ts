import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { GameIntent } from '@games/host';
import { dispatchWasmNotification } from '../lib/session/gameSessionEvents';
import { createSessionMachineState } from '../lib/session/sessionMachine';
import { SessionMachineRuntime } from '../lib/session/sessionMachineRuntime';
import {
  projectTerminalSessionResult,
  type TerminalSessionPresentation,
  type UseGameSessionResult,
  useTerminalSessionPresentation,
} from '../lib/session/sessionResult';
import type {
  LocalGameActionRequest,
  SessionMachineEvent,
} from '../lib/session/sessionMachineTypes';
import type { RegisteredGameType } from '../lib/session/types';
import { REGISTERED_GAMES } from '../lib/gameRegistry';
import { markClientErrorReported, wasClientErrorReported } from '../lib/clientError';
import { liveGameHandOrigin, type GameHandSource } from '../lib/gameHandSource';
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

export function runLocalGameActionWithReporting(
  request: LocalGameActionRequest,
  run: () => void,
  report: (failure: {
    gameId: string;
    action: LocalGameActionRequest['command']['type'];
    message: string;
  }) => void,
): void {
  try {
    run();
  } catch (error) {
    if (!wasClientErrorReported(error)) {
      markClientErrorReported(error);
      report({
        gameId: request.id,
        action: request.command.type,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

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
  const initialState = useMemo(() => {
    const handProposal: HandProposal = {
      gameType: REGISTERED_GAMES[0].gameType,
      playerAContribution: perGameAmount,
      playerBContribution: perGameAmount,
      senderIsPlayerA: !iStarted,
      gameTimeout: DEFAULT_GAME_TIMEOUT_BLOCKS,
      parameters: null,
    };
    return createSessionMachineState(
      restoredModel ??
        createSessionModel({
          channel: { cleanShutdownStarted: controller.cleanShutdownCalled },
          betweenHand: {
            lastHandProposal: null,
            compose: createComposeDraftState(handProposal),
          },
        }),
      {
        firstGameAccepted:
          sessionSave?.phase === 'live' &&
          sessionSave.presentation.channelStatus?.state === 'Active',
      },
    );
  }, [controller, iStarted, perGameAmount, restoredModel, sessionSave]);
  const runtimeRef = useRef<SessionMachineRuntime | null>(null);
  if (!runtimeRef.current) {
    restoredHandKeyRef.current = restoredModel?.game.handState ? restoredModel.game.handKey : null;
    runtimeRef.current = new SessionMachineRuntime(initialState, {
      controller,
      iStarted,
      restoring: params.restoring ?? false,
      getRestoreStatus: () => controller.getRestoreStatus(),
      getRestoreError: () => controller.getRestoreError(),
      onError: (error) => controller.reportRuntimeError(error),
    });
  }
  const runtime = runtimeRef.current;
  const [machineState, setMachineState] = useState(runtime.getState());
  const dispatch = useCallback((event: SessionMachineEvent) => runtime.dispatch(event), [runtime]);
  const liveGamePort = useMemo(
    () => ({
      isChannelReady: () => controller.isChannelReady(),
      dispatch: (intent: GameIntent) => {
        const game = runtime.getState().model.game;
        const gameType = game.activeGameType as RegisteredGameType;
        if (intent.type === 'state-changed') {
          runtime.commitHandStateChanged(gameType);
          return;
        }
        if (!Number.isInteger(intent.memberIndex) || intent.memberIndex < 0) {
          throw new Error(
            `Internal game action member index must be a nonnegative integer: ${intent.memberIndex}`,
          );
        }
        const id = game.currentHandIds[intent.memberIndex];
        if (id === undefined) {
          throw new Error(
            `Internal game action member index ${intent.memberIndex} is outside the current hand`,
          );
        }
        const request: LocalGameActionRequest = {
          gameType,
          id,
          command:
            intent.type === 'make-move'
              ? { type: 'make-move', readable: intent.readable }
              : intent.type === 'accept-settlement'
                ? { type: 'accept-settlement' }
                : { type: 'cheat', moverShare: intent.moverShare },
        };
        runLocalGameActionWithReporting(
          request,
          () => runtime.commitLocalGameAction(request),
          ({ action, message }) => {
            if (action === 'cheat') {
              dispatch({ type: 'enqueue-error', kind: 'infra-error', message });
              return;
            }
            dispatch({ type: 'enqueue-error', kind: 'action-failed', message });
          },
        );
      },
    }),
    [controller, dispatch, runtime],
  );
  const liveHandSource: GameHandSource = {
    frozen: false,
    hand: runtime.getGameHand(),
    port: liveGamePort,
  };
  useEffect(() => {
    runtime.setRender(setMachineState);
    return () => runtime.setRender(() => {});
  }, [runtime]);
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
  }, [controller, dispatch, dispatchHostProjection, iStarted, terminalMode]);

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
    appendGameLog,
    betweenHandMode: model.betweenHand.mode,
    incomingProposalGroup: view.incomingProposalGroup,
    lastHandProposal: model.betweenHand.lastHandProposal,
    composeDraftState: compose,
    chooseNewHandSameTerms: () => dispatch({ type: 'choose-same-terms' }),
    chooseDoNotUseCurrentProposal: () => dispatch({ type: 'reject-current-proposal' }),
    openComposeProposal: () => dispatch({ type: 'open-compose' }),
    setComposeGameTimeout,
    setComposeGameType,
    composeProposalSent: compose.proposalSent,
    newHandRequested: model.betweenHand.newHandRequested,
    submitComposedProposal: (handProposal) => dispatch({ type: 'submit-compose', handProposal }),
    acceptReviewedProposal: () => dispatch({ type: 'accept-review' }),
    rejectReviewedProposal: () => dispatch({ type: 'reject-review' }),
    startCleanShutdown: () => dispatch({ type: 'start-clean-shutdown' }),
    cleanShutdownStarted: model.channel.cleanShutdownStarted,
    goOnChain: () => dispatch({ type: 'go-on-chain' }),
    betweenHands: view.betweenHands,
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
    ? projectTerminalSessionResult(liveResult, terminalState.presentation, terminalState)
    : liveResult;
}
