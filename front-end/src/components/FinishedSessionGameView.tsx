import React, { useMemo } from 'react';

import GameHandHost from './GameHandHost';
import { createFrozenHandBridge } from '../hooks/frozenHandBridge';
import type { SessionModel } from '../lib/session/model';
import { selectFinishedSessionDisplay } from '../lib/session/finishedSessionDisplay';

export interface FinishedSessionGameViewProps {
  model: SessionModel;
  myName?: string;
  opponentName?: string;
  /** Matches live GameSession: starter is player 1. */
  iStarted?: boolean;
  /** Preserves the Krunk atomic group's Alice/Bob game ordering. */
  iProposedHand?: boolean;
}

/**
 * Reload recovery for a resolved session. A live resolved session keeps its
 * existing GameSession subtree mounted and transitions it to frozen mode.
 *
 * handState stays on the stub controller — never as a React prop — because
 * React's prop describe path JSON.stringifies arrays and throws on BigInt.
 */
const FinishedSessionGameView: React.FC<FinishedSessionGameViewProps> = ({
  model,
  myName,
  opponentName,
  iStarted = false,
  iProposedHand = false,
}) => {
  const display = selectFinishedSessionDisplay(model);
  const handState = model.game.handState;
  const gameType = handState?.gameType ?? model.game.activeGameType;
  const playerNumber = iStarted ? 1 : 2;
  const gameId = model.game.lastDisplayedId
    ?? model.game.currentHandIds[0]
    ?? model.game.activeIds[0]
    ?? 'finished';

  const frozenBridge = useMemo(
    () => createFrozenHandBridge(handState),
    // handKey changes when a new hand starts; handState identity updates on persist.
    [model.game.handKey, handState],
  );
  const gameSettlementOutcomes = Object.fromEntries(
    Object.entries(model.game.instances).map(([id, instance]) => [
      id,
      instance.terminal.outcome,
    ]),
  );

  if (!display.canRemountHand || !handState) {
    return (
      <div
        className='flex h-full w-full items-center justify-center text-canvas-solid px-4 text-center'
        data-testid='finished-session-fallback'
      >
        {display.terminalLabel ?? 'No hand details available'}
      </div>
    );
  }

  return (
    <div
      className='relative flex h-full w-full min-h-0 flex-col'
      data-testid='finished-session-game-view'
    >
      <GameHandHost
        mode='frozen'
        gameType={gameType}
        sessionController={frozenBridge}
        gameId={gameId}
        currentHandGameIds={model.game.currentHandIds}
        activeGameIds={model.game.activeIds}
        iStarted={iStarted}
        iProposedHand={iProposedHand}
        playerNumber={playerNumber}
        perGameAmount={model.betweenHand.lastTerms.myContribution}
        lastHandTerms={model.betweenHand.lastTerms}
        myName={myName}
        opponentName={opponentName}
        settlementOutcome={model.game.terminal.outcome}
        gameSettlementOutcomes={gameSettlementOutcomes}
        handKey={model.game.handKey}
      />
    </div>
  );
};

export default FinishedSessionGameView;
