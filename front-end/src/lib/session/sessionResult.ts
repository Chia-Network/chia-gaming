import { useCallback, useEffect, useState } from 'react';
import type { Observable } from 'rxjs';
import type { CalpokerOutcome } from '../../features/calPoker/outcome';
import type { RestoreStatus } from '../../hooks/SessionController';
import { terminalGameHandSource, type GameHandOrigin, type GameHandSource } from '../gameMount';
import type { GameConnectionState, SessionPhase } from '../../types/ChiaGaming';
import type { ComposeDraftState } from './composeDraft';
import type { GameplayEvent } from './gameSessionEvents';
import type {
  BetweenHandModeModel,
  ChannelStatusModel,
  GameCoinModel,
  GameTerminalModel,
  HandTermsModel,
  ProposalGroupModel,
  QueuedNotificationModel,
  SessionModel,
} from './types';
import type { selectGameSpecificView } from './selectors';
import {
  selectGameSessionView,
  selectIProposedHand,
  selectIncomingProposalGroup,
  selectGameSpecificView as selectTerminalGameSpecificView,
  selectSessionPhase,
} from './selectors';

export interface UseGameSessionResult {
  sessionModel: SessionModel;
  gameConnectionState: GameConnectionState;
  perGameAmount: bigint;
  currentHandAmount: bigint;
  myRunningBalance: bigint;
  iStarted: boolean;
  playerNumber: number;
  channelStatus: ChannelStatusModel;
  gameCoin: GameCoinModel;
  gameTerminal: GameTerminalModel;
  handKey: number;
  handOrigin: GameHandOrigin;
  activeGameId: string | null;
  activeGameIds: string[];
  currentHandGameIds: string[];
  iProposedHand: boolean;
  activeGameType: HandTermsModel['gameType'];
  displayGameId: string | null;
  handSource: GameHandSource;
  gameplayEvent$: Observable<GameplayEvent>;
  appendGameLog: (line: string) => void;
  onHandOutcome: (outcome: CalpokerOutcome) => void;
  onTurnChanged: (gameId: string, isMyTurn: boolean) => void;
  betweenHandMode: BetweenHandModeModel;
  incomingProposalGroup: ProposalGroupModel | null;
  lastHandTerms: HandTermsModel;
  composeDraftState: ComposeDraftState;
  chooseNewHandSameTerms: () => void;
  chooseDoNotUseCurrentProposal: () => void;
  openComposeProposal: () => void;
  setComposeGameTimeout: (value: bigint) => void;
  setComposeGameType: (value: HandTermsModel['gameType']) => void;
  setCalpokerComposeAmount: (value: bigint) => void;
  setKrunkComposeAmount: (value: bigint) => void;
  setSpacepokerComposeDraft: (draft: Partial<ComposeDraftState['spacepoker']>) => void;
  composeProposalSent: boolean;
  newHandRequested: boolean;
  submitComposedProposal: (terms: HandTermsModel) => void;
  acceptReviewedProposal: () => void;
  rejectReviewedProposal: () => void;
  startCleanShutdown: () => void;
  cleanShutdownStarted: boolean;
  goOnChain: () => void;
  betweenHands: boolean;
  lastOutcomeWin: 'win' | 'lose' | 'tie' | undefined;
  restoredOutcomeWin: 'win' | 'lose' | 'tie' | undefined;
  restoreStatus: RestoreStatus;
  restoreError: string | null;
  sessionPhase: Exclude<SessionPhase, 'none'>;
  channelQueue: QueuedNotificationModel[];
  gameQueue: QueuedNotificationModel[];
  dismissChannel: () => void;
  dismissGame: () => void;
  gameSpecificView: ReturnType<typeof selectGameSpecificView>;
}

export interface TerminalSessionPresentation {
  model: SessionModel;
  myName?: string;
  opponentName?: string;
  iStarted: boolean;
}

const NOOP = () => {};

export interface TerminalSessionPresentationState {
  presentation: TerminalSessionPresentation | null;
  dismissChannel: () => void;
  dismissGame: () => void;
}

export function useTerminalSessionPresentation(
  source: TerminalSessionPresentation | null | undefined,
): TerminalSessionPresentationState {
  const [model, setModel] = useState<SessionModel | null>(source?.model ?? null);
  useEffect(() => {
    if (!source) {
      setModel(null);
    } else {
      setModel((current) => current ?? source.model);
    }
  }, [source]);
  const dismissChannel = useCallback(() => {
    setModel((current) => {
      const terminal = current ?? source?.model;
      return terminal
        ? {
            ...terminal,
            channel: { ...terminal.channel, queue: terminal.channel.queue.slice(1) },
          }
        : current;
    });
  }, [source]);
  const dismissGame = useCallback(() => {
    setModel((current) => {
      const terminal = current ?? source?.model;
      return terminal
        ? {
            ...terminal,
            game: { ...terminal.game, queue: terminal.game.queue.slice(1) },
          }
        : current;
    });
  }, [source]);
  return {
    presentation: source ? { ...source, model: model ?? source.model } : null,
    dismissChannel,
    dismissGame,
  };
}

export function projectTerminalSessionResult(
  live: UseGameSessionResult,
  presentation: TerminalSessionPresentation,
  gameplayEvent$: Observable<GameplayEvent>,
  dismissals?: Pick<TerminalSessionPresentationState, 'dismissChannel' | 'dismissGame'>,
): UseGameSessionResult {
  const { model, iStarted } = presentation;
  const view = selectGameSessionView(model);

  return {
    ...live,
    sessionModel: model,
    gameConnectionState: model.channel.connection,
    currentHandAmount: view.currentHandAmount,
    myRunningBalance: model.myRunningBalance,
    iStarted,
    playerNumber: iStarted ? 1 : 2,
    channelStatus: view.channelStatus,
    gameCoin: view.gameCoin,
    gameTerminal: view.gameTerminal,
    handKey: model.game.handKey,
    handOrigin: 'terminal',
    activeGameId: view.activeGameId,
    activeGameIds: view.activeGameIds,
    currentHandGameIds: model.game.currentHandIds,
    iProposedHand: selectIProposedHand(model),
    activeGameType: view.activeGameType,
    displayGameId: view.displayGameId,
    handSource: terminalGameHandSource(model.game.handState),
    gameplayEvent$,
    appendGameLog: NOOP,
    onHandOutcome: NOOP,
    onTurnChanged: NOOP,
    betweenHandMode: model.betweenHand.mode,
    incomingProposalGroup: selectIncomingProposalGroup(model),
    lastHandTerms: model.betweenHand.lastTerms,
    composeDraftState: model.betweenHand.compose,
    chooseNewHandSameTerms: NOOP,
    chooseDoNotUseCurrentProposal: NOOP,
    openComposeProposal: NOOP,
    setComposeGameTimeout: NOOP,
    setComposeGameType: NOOP,
    setCalpokerComposeAmount: NOOP,
    setKrunkComposeAmount: NOOP,
    setSpacepokerComposeDraft: NOOP,
    composeProposalSent: model.betweenHand.compose.proposalSent,
    newHandRequested: model.betweenHand.newHandRequested,
    submitComposedProposal: NOOP,
    acceptReviewedProposal: NOOP,
    rejectReviewedProposal: NOOP,
    startCleanShutdown: NOOP,
    cleanShutdownStarted: model.channel.cleanShutdownStarted,
    goOnChain: NOOP,
    betweenHands: view.betweenHands,
    restoreStatus: model.restore.status,
    restoreError: model.restore.error,
    sessionPhase: selectSessionPhase(model, false),
    channelQueue: view.channelQueue,
    gameQueue: view.gameQueue,
    dismissChannel: dismissals?.dismissChannel ?? NOOP,
    dismissGame: dismissals?.dismissGame ?? NOOP,
    gameSpecificView: selectTerminalGameSpecificView(model),
  };
}
