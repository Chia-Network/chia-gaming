import React, { useMemo } from 'react';

import { createFrozenHandBridge } from '../hooks/frozenHandBridge';
import type { SessionModel } from '../lib/session/model';
import { selectFinishedSessionDisplay } from '../lib/session/finishedSessionDisplay';
import { frozenGameMountRequest, renderGameMount } from '../lib/gameMountRegistry';

export interface FinishedSessionGameViewProps {
  model: SessionModel;
  myName?: string;
  opponentName?: string;
  iStarted?: boolean;
  iProposedHand?: boolean;
}

/**
 * Rehydrates a terminal hand only for display. Protocol lifecycle remains
 * absent: feature actions receive a frozen controller and no notifications.
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
  const frozenBridge = useMemo(() => createFrozenHandBridge(handState), [handState]);

  if (!display.canRemountHand || !handState) {
    return (
      <div
        className="flex h-full w-full items-center justify-center px-4 text-center text-canvas-solid"
        data-testid="finished-session-fallback"
      >
        {display.terminalLabel ?? 'No hand details available'}
      </div>
    );
  }

  const mount = frozenGameMountRequest(model, frozenBridge, {
    myName,
    opponentName,
    iStarted,
    iProposedHand,
  });

  return (
    <div
      className="relative h-full w-full min-h-0 pointer-events-none"
      data-testid="finished-session-game-view"
      aria-disabled
      inert
    >
      {renderGameMount(mount)}
    </div>
  );
};

export default FinishedSessionGameView;
