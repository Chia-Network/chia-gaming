import type { SessionController } from '../../hooks/SessionController';
import { encodeGameProposalParameters, validateGameTerms } from '../gameRegistry';
import { coinIdHex, type GameplayEvent } from './gameSessionEvents';
import type {
  SessionMachineEffect,
  SessionMachineEvent,
  SessionMachineState,
} from './sessionMachineTypes';

type CommandEffect = Exclude<
  SessionMachineEffect,
  { type: 'set-hand-state' } | { type: 'clear-derived-game-presentation' }
>;

export interface SessionMachineInterpreterDependencies {
  controller: SessionController;
  iStarted: boolean;
  getState(): SessionMachineState;
  dispatch(event: SessionMachineEvent): void;
  persist(): Promise<void>;
  emitGameplay(event: GameplayEvent): void;
  onError(error: unknown): void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  enrichCoin?: typeof coinIdHex;
}

export class SessionMachineInterpreter {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly dependencies: SessionMachineInterpreterDependencies) {}

  run(effect: CommandEffect): void {
    const dependencies = this.dependencies;
    switch (effect.type) {
      case 'controller-accept-proposal':
        dependencies.controller.acceptProposal(effect.id);
        return;
      case 'controller-cancel-proposal':
        this.cancelProposal(effect.id);
        return;
      case 'controller-propose-game': {
        if (!dependencies.controller.isOffChainActive()) return;
        if (!validateGameTerms(effect.terms)) return;
        if (dependencies.getState().model.game.activeIds.length > 0) return;
        const ids = dependencies.controller.proposeGame({
          game_type: effect.terms.gameType,
          timeout: effect.terms.gameTimeout,
          parameters: encodeGameProposalParameters(effect.terms, dependencies.iStarted),
        });
        dependencies.dispatch({ type: 'proposal-sent', ids, terms: effect.terms });
        return;
      }
      case 'controller-clean-shutdown':
        dependencies.controller.cleanShutdown();
        return;
      case 'controller-go-on-chain': {
        const started = dependencies.controller.goOnChain();
        dependencies.dispatch({ type: 'go-on-chain-result', started });
        return;
      }
      case 'controller-set-last-outcome':
        dependencies.controller.lastOutcomeWin = effect.outcome.my_win_outcome;
        return;
      case 'timer-schedule': {
        this.cancelTimer(effect.key);
        const timer = (dependencies.setTimer ?? setTimeout)(() => {
          this.timers.delete(effect.key);
          dependencies.dispatch({
            type: 'rejection-fallback-fired',
            generation: effect.generation,
          });
        }, effect.delayMs);
        if (typeof timer === 'object' && 'unref' in timer) timer.unref();
        this.timers.set(effect.key, timer);
        return;
      }
      case 'timer-cancel':
        this.cancelTimer(effect.key);
        return;
      case 'persist-session':
        void dependencies.persist().catch(dependencies.onError);
        return;
      case 'emit-gameplay':
        dependencies.emitGameplay(effect.event);
        return;
      case 'request-coin-enrichment':
        void (dependencies.enrichCoin ?? coinIdHex)(effect.coin)
          .then((coinHex) => {
            dependencies.dispatch({
              type: 'coin-enrichment-completed',
              target: effect.target,
              id: effect.id,
              generation: effect.generation,
              coinHex,
              channelState: effect.channelState,
            });
          })
          .catch(dependencies.onError);
        return;
    }
  }

  dispose(): void {
    for (const key of this.timers.keys()) this.cancelTimer(key);
  }

  private cancelProposal(id: string): void {
    try {
      this.dependencies.controller.cancel_proposal(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no proposal with id|cancel for unknown proposal|not in off-chain phase/i.test(message)) {
        return;
      }
      throw error;
    }
  }

  private cancelTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      (this.dependencies.clearTimer ?? clearTimeout)(timer);
      this.timers.delete(key);
    }
  }
}
