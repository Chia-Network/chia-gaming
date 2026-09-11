import type { GameCommandDisposition, SessionController } from '../../hooks/SessionController';
import { protocolIdForCatalog } from '../gameIdentities';
import { coinIdHex } from './gameSessionEvents';
import type {
  SessionMachineEffect,
  SessionMachineEvent,
  SessionMachineState,
  SessionControllerCommand,
  LocalGameCommand,
} from './sessionMachineTypes';

type CommandEffect = Exclude<SessionMachineEffect, { type: 'clear-derived-game-presentation' }>;

export interface SessionMachineInterpreterDependencies {
  controller: SessionController;
  iStarted: boolean;
  getState(): SessionMachineState;
  dispatch(event: SessionMachineEvent): void;
  persist(): Promise<void>;
  onError(error: unknown): void;
  enrichCoin?: typeof coinIdHex;
}

export class SessionMachineInterpreter {
  constructor(private readonly dependencies: SessionMachineInterpreterDependencies) {}

  runLocalGameCommand(command: LocalGameCommand, id: string): GameCommandDisposition {
    switch (command.type) {
      case 'make-move':
        return this.dependencies.controller.makeMove(id, command.readable);
      case 'accept-settlement':
        return this.dependencies.controller.acceptSettlement(id);
      case 'cheat':
        return this.dependencies.controller.cheat(id, command.moverShare);
    }
  }

  run(effect: CommandEffect): void {
    const dependencies = this.dependencies;
    switch (effect.type) {
      case 'controller-accept-proposal':
        this.runControllerCommand(
          'accept-proposal',
          () => dependencies.controller.acceptProposal(effect.id),
          () =>
            dependencies.dispatch({
              type: 'proposal-command-succeeded',
              command: 'accept-proposal',
              id: effect.id,
              context: effect.context,
            }),
        );
        return;
      case 'controller-cancel-proposal':
        this.runControllerCommand(
          'cancel-proposal',
          () => dependencies.controller.cancel_proposal(effect.id),
          () =>
            dependencies.dispatch({
              type: 'proposal-command-succeeded',
              command: 'cancel-proposal',
              id: effect.id,
              context: effect.context,
            }),
        );
        return;
      case 'controller-propose-game': {
        if (!dependencies.controller.isOffChainActive()) {
          this.commandFailed('propose-game', new Error('channel is not active off-chain'));
          return;
        }
        if (dependencies.getState().model.game.activeIds.length > 0) {
          this.commandFailed('propose-game', new Error('a game is already active'));
          return;
        }
        this.runControllerCommand(
          'propose-game',
          () =>
            dependencies.controller.proposeGame({
              game_type: protocolIdForCatalog(effect.handProposal.gameType),
              timeout: effect.handProposal.gameTimeout,
              player_a_contribution: effect.handProposal.playerAContribution,
              player_b_contribution: effect.handProposal.playerBContribution,
              sender_is_player_a: effect.handProposal.senderIsPlayerA,
              parameters: effect.handProposal.parameters,
            }),
          (ids) =>
            dependencies.dispatch({
              type: 'proposal-sent',
              ids,
              handProposal: effect.handProposal,
            }),
        );
        return;
      }
      case 'controller-clean-shutdown':
        this.runControllerCommand(
          'clean-shutdown',
          () => dependencies.controller.cleanShutdown(),
          () => dependencies.dispatch({ type: 'clean-shutdown-command-succeeded' }),
        );
        return;
      case 'controller-go-on-chain': {
        this.runControllerCommand(
          'go-on-chain',
          () => dependencies.controller.goOnChain(),
          (started) => {
            if (!started) {
              this.commandFailed('go-on-chain', new Error('WASM rejected go on chain'));
              return;
            }
            dependencies.dispatch({ type: 'go-on-chain-result', started: true });
          },
        );
        return;
      }
      case 'persist-session':
        void dependencies.persist().catch(dependencies.onError);
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

  private runControllerCommand<T>(
    command: SessionControllerCommand,
    run: () => T,
    succeeded: (result: T) => void,
  ): void {
    let result: T;
    try {
      result = run();
    } catch (error) {
      this.commandFailed(command, error);
      return;
    }
    succeeded(result);
  }

  private commandFailed(command: SessionControllerCommand, error: unknown): void {
    this.dependencies.dispatch({
      type: 'controller-command-failed',
      command,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
