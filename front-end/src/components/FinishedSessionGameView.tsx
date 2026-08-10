import React, { Component, Suspense, useMemo } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

import { createFrozenHandBridge } from '../hooks/frozenHandBridge';
import type { SessionController } from '../hooks/SessionController';
import type { FrozenGameMountOptions } from '../lib/gameMount';
import type { SessionModel } from '../lib/session/model';
import { selectFinishedSessionDisplay } from '../lib/session/finishedSessionDisplay';
import { renderFrozenGameMount } from '../lib/gameMountRegistry';

export interface FinishedSessionGameViewProps {
  model: SessionModel;
  myName?: string;
  opponentName?: string;
  iStarted?: boolean;
  iProposedHand?: boolean;
}

function FinishedSessionFallback({
  label,
  reason,
  detail,
}: {
  label: string | null;
  reason: 'unavailable' | 'render-error';
  detail?: string | null;
}) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center text-canvas-solid"
      data-testid="finished-session-fallback"
    >
      {label && <p>{label}</p>}
      <p>
        {reason === 'render-error' ? 'Game details failed to render.' : 'Game details unavailable.'}
      </p>
      {detail && (
        <pre className="max-w-full overflow-auto whitespace-pre-wrap text-left text-xs">
          {detail}
        </pre>
      )}
    </div>
  );
}

interface FinishedSessionErrorBoundaryProps {
  children: ReactNode;
  fallbackLabel: string | null;
  resetKey: string;
}

interface FinishedSessionErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

export class FinishedSessionErrorBoundary extends Component<
  FinishedSessionErrorBoundaryProps,
  FinishedSessionErrorBoundaryState
> {
  state: FinishedSessionErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): FinishedSessionErrorBoundaryState {
    return { error, componentStack: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      '[FinishedSessionGameView] frozen game render crash:',
      error,
      info.componentStack,
    );
    this.setState({ componentStack: info.componentStack ?? null });
  }

  componentDidUpdate(previous: FinishedSessionErrorBoundaryProps) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, componentStack: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <FinishedSessionFallback
          label={this.props.fallbackLabel}
          reason="render-error"
          detail={[this.state.error.stack ?? this.state.error.message, this.state.componentStack]
            .filter(Boolean)
            .join('\n')}
        />
      );
    }
    return this.props.children;
  }
}

function FrozenGameMount({
  model,
  bridge,
  options,
}: {
  model: SessionModel;
  bridge: SessionController;
  options: FrozenGameMountOptions;
}) {
  return renderFrozenGameMount(model, bridge, options);
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
    return <FinishedSessionFallback label={display.terminalLabel} reason="unavailable" />;
  }

  const resetKey = `${handState.gameType}:${model.game.lastDisplayedId ?? ''}`;

  return (
    <div
      className="relative h-full w-full min-h-0 pointer-events-none"
      data-testid="finished-session-game-view"
      aria-disabled
      inert
    >
      <FinishedSessionErrorBoundary fallbackLabel={display.terminalLabel} resetKey={resetKey}>
        <Suspense
          fallback={
            <div
              className="flex h-full w-full items-center justify-center px-4 text-center text-canvas-solid"
              data-testid="finished-session-loading"
            >
              Loading hand…
            </div>
          }
        >
          <FrozenGameMount
            model={model}
            bridge={frozenBridge}
            options={{
              myName,
              opponentName,
              iStarted,
              iProposedHand,
            }}
          />
        </Suspense>
      </FinishedSessionErrorBoundary>
    </div>
  );
};

export default FinishedSessionGameView;
