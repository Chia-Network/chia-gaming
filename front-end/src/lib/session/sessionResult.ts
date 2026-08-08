import type { Observable } from 'rxjs';
import type { CalpokerOutcome } from '../../features/calPoker/outcome';
import type { SessionController, RestoreStatus } from '../../hooks/SessionController';
import type { GameConnectionState, SessionPhase } from '../../types/ChiaGaming';
import type { ComposeDraftState } from './composeDraft';
import type { GameplayEvent } from './gameSessionEvents';
import type {
  BetweenHandModeModel,
  BetweenHandProposalModel,
  ChannelStatusModel,
  GameCoinModel,
  GameTerminalModel,
  HandTermsModel,
  QueuedNotificationModel,
  SessionModel,
} from './types';
import type { selectGameSpecificView } from './selectors';

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
  activeGameId: string | null;
  activeGameIds: string[];
  currentHandGameIds: string[];
  iProposedHand: boolean;
  activeGameType: HandTermsModel['gameType'];
  displayGameId: string | null;
  sessionController: SessionController;
  gameplayEvent$: Observable<GameplayEvent>;
  appendGameLog: (line: string) => void;
  onHandOutcome: (outcome: CalpokerOutcome) => void;
  onTurnChanged: (gameId: string, isMyTurn: boolean) => void;
  betweenHandMode: BetweenHandModeModel;
  cachedPeerProposal: BetweenHandProposalModel | null;
  reviewPeerProposal: BetweenHandProposalModel | null;
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
  lastOutcome: CalpokerOutcome | undefined;
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
