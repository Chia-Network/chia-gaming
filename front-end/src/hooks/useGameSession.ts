import { useCallback } from 'react';
import type { GameHandSource } from '../lib/gameHandSource';
import {
  selectGameSessionView,
  selectGameSpecificView,
  selectIProposedHand,
  type HandProposal,
} from '../lib/session/model';
import type { SessionFrontend } from '../lib/session/sessionFrontend';
import type { GameSessionParams } from '../types/ChiaGaming';
import {
  projectTerminalSessionResult,
  useTerminalSessionPresentation,
  type TerminalSessionPresentation,
  type UseGameSessionResult,
} from './sessionView';

export type { GameTerminalInfo, QueuedNotification } from '../lib/session/gameSessionEvents';
export type { UseGameSessionResult } from './sessionView';

export function useGameSession(
  params: GameSessionParams,
  frontend: Pick<SessionFrontend, 'dispatch' | 'game'>,
  appendGameLog: (line: string) => void,
  terminalPresentation: TerminalSessionPresentation | null | undefined,
  presentation: import('../lib/session/sessionFrontend').SessionPresentation,
): UseGameSessionResult {
  const { iStarted, perGameAmount } = params;
  const terminalState = useTerminalSessionPresentation(terminalPresentation);

  const dispatch = frontend.dispatch;
  const liveHandSource: GameHandSource = {
    frozen: false,
    hand: presentation.hand,
    port: frontend.game,
  };
  const setComposeGameTimeout = useCallback(
    (timeout: bigint) => dispatch({ type: 'set-compose-timeout', timeout }),
    [dispatch],
  );
  const setComposeGameType = useCallback(
    (gameType: HandProposal['gameType']) => dispatch({ type: 'select-compose-game', gameType }),
    [dispatch],
  );
  const { model } = presentation;
  const view = selectGameSessionView(model);
  const gameSpecificView = selectGameSpecificView(model);
  const compose = model.betweenHand.compose;
  const sessionPhase = presentation.phase;

  const liveResult: UseGameSessionResult = {
    sessionModel: model,
    gameConnectionState: model.channel.connection,
    perGameAmount,
    currentHandAmount: view.currentHandAmount,
    iStarted,
    playerNumber: iStarted ? 1 : 2,
    channelStatus: view.channelStatus,
    gameCoin: view.gameCoin,
    gameTerminal: view.gameTerminal,
    handKey: model.game.handKey,
    activeGameId: view.activeGameId,
    activeGameIds: view.activeGameIds,
    currentHandGameIds: model.game.currentHandIds,
    iProposedHand: selectIProposedHand(model),
    activeGameType: view.activeGameType,
    displayGameId: view.displayGameId,
    handSource: liveHandSource,
    appendGameLog,
    betweenHandMode: model.betweenHand.mode,
    incomingProposal: view.incomingProposal,
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
    acceptReviewedProposal: (id) => dispatch({ type: 'accept-review', id }),
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
