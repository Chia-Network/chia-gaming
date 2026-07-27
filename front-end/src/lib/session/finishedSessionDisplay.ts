import type { SessionModel } from './model';

/**
 * Keep persisted bigint payloads out of React's enumerable prop inspection.
 * The session shell deliberately does not inspect the game-owned payload.
 */
export function sessionModelForReactProps(model: SessionModel): SessionModel {
  const game = { ...model.game };
  const handState = game.handState;
  delete (game as { handState?: unknown }).handState;
  Object.defineProperty(game, 'handState', {
    value: handState,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return { ...model, game };
}

export interface FinishedSessionDisplay {
  terminalLabel: string | null;
  canRemountHand: boolean;
}

/** Shell-only decision: a validated feature mount receives the opaque payload. */
export function selectFinishedSessionDisplay(model: SessionModel): FinishedSessionDisplay {
  const handState = model.game.handState;
  const hasSupportedVersion = handState?.version === 1n;
  const hasCalpokerSnapshot = handState?.gameType !== 'calpoker'
    || (
      typeof handState.state === 'object'
      && handState.state !== null
      && 'displaySnapshot' in handState.state
      && handState.state.displaySnapshot != null
      && typeof handState.state.displaySnapshot === 'object'
      && 'playerBestHandCardIds' in handState.state.displaySnapshot
      && Array.isArray(handState.state.displaySnapshot.playerBestHandCardIds)
      && 'opponentBestHandCardIds' in handState.state.displaySnapshot
      && Array.isArray(handState.state.displaySnapshot.opponentBestHandCardIds)
      && 'playerHaloCardIds' in handState.state.displaySnapshot
      && Array.isArray(handState.state.displaySnapshot.playerHaloCardIds)
      && 'opponentHaloCardIds' in handState.state.displaySnapshot
      && Array.isArray(handState.state.displaySnapshot.opponentHaloCardIds)
      && 'playerHand' in handState.state
      && Array.isArray(handState.state.playerHand)
      && handState.state.playerHand.every(card => typeof card === 'bigint')
      && 'opponentHand' in handState.state
      && Array.isArray(handState.state.opponentHand)
      && handState.state.opponentHand.every(card => typeof card === 'bigint')
    );
  const hasSpacePokerSnapshot = handState?.gameType !== 'spacepoker'
    || (
      typeof handState.state === 'object'
      && handState.state !== null
      && 'gameState' in handState.state
      && typeof handState.state.gameState === 'object'
      && handState.state.gameState !== null
      && 'communityCards' in handState.state
      && Array.isArray(handState.state.communityCards)
      && 'handHistory' in handState.state
      && Array.isArray(handState.state.handHistory)
    );

  return {
    terminalLabel: model.game.terminal.label,
    canRemountHand: handState != null
      && handState.gameType !== 'krunk'
      && (handState.gameType === 'calpoker' || handState.gameType === 'spacepoker')
      && hasSupportedVersion
      && hasCalpokerSnapshot
      && hasSpacePokerSnapshot,
  };
}
