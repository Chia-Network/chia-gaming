import type { GameIntent, LiveGamePort } from '@games/host';
import type { CoinOfInterestEntry, SessionPhase } from '../../types/ChiaGaming';
import type { RegisteredGameHand } from '../gameRegistry';
import type { SessionMachineEvent } from './sessionMachineTypes';
import type { SessionModel } from './types';

export type SessionIntent = Extract<
  SessionMachineEvent,
  {
    type:
      | 'choose-same-terms'
      | 'reject-current-proposal'
      | 'open-compose'
      | 'set-compose-timeout'
      | 'select-compose-game'
      | 'submit-compose'
      | 'accept-review'
      | 'reject-review'
      | 'start-clean-shutdown'
      | 'go-on-chain'
      | 'dismiss-channel'
      | 'dismiss-game-notification';
  }
>;

export interface SessionPresentation {
  model: SessionModel;
  phase: Exclude<SessionPhase, 'none'>;
  hand: RegisteredGameHand | null;
  coins: CoinOfInterestEntry[];
  channelReady: boolean;
}

export type SessionFrontendEvent =
  | { type: 'batch-complete'; presentation: SessionPresentation }
  | { type: 'terminal-retry' }
  | { type: 'readiness'; ready: boolean };

/** View attachment has no ownership of the running session or its resources. */
export interface SessionFrontend {
  snapshot(): SessionPresentation;
  subscribe(listener: (event: SessionFrontendEvent) => void): () => void;
  dispatch(intent: SessionIntent): void;
  readonly game: LiveGamePort;
}

export type { GameIntent };

export interface TerminalSessionPresentation {
  model: SessionModel;
  myName?: string;
  opponentName?: string;
  iStarted: boolean;
}
