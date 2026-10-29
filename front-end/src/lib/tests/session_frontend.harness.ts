import type { SessionController } from '../session/SessionController';
import { useLayoutEffect, useState } from 'react';
import type { SessionPresentation } from '../session/sessionFrontend';

export function observeSessionProjection(
  runtime: SessionController,
  render: (presentation: SessionPresentation) => void,
): () => void {
  return runtime.frontend.subscribe((event) => {
    if (event.type === 'batch-complete') render(event.presentation);
  });
}

/** Replace Rust execution at its output boundary; React does not drive the host. */
export function stubApplicationSession(model: import('../session/model').SessionModel) {
  let presentation: SessionPresentation = {
    model,
    phase: 'off-chain',
    hand: null,
    coins: [],
    channelReady: false,
  };
  const listeners = new Set<
    (event: import('../session/sessionFrontend').SessionFrontendEvent) => void
  >();
  const frontend: import('../session/sessionFrontend').SessionFrontend = {
    snapshot: () => presentation,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: jest.fn(),
    game: { dispatch: jest.fn(), isChannelReady: () => false },
  };
  return {
    controller: {
      frontend,
      cleanup: jest.fn(),
      setPresentationTiming: jest.fn(),
      setTransactionPublishNerfed: jest.fn(),
      beginRestore: jest.fn((promise) => promise),
      getRestoreStatus: () => presentation.model.restore.status,
      getRestoreError: () => presentation.model.restore.error,
      reportPeerConnectivity: jest.fn(() => true),
      sendPeerKeepalive: jest.fn(),
      attachBlockchain: jest.fn(),
      detachBlockchain: jest.fn(),
    } as unknown as import('../session/SessionController').SessionController,
    publish(next: import('../session/model').SessionModel) {
      presentation = { ...presentation, model: next };
      for (const listener of listeners) listener({ type: 'batch-complete', presentation });
    },
  };
}

export function useTestSessionPresentation(
  frontend: import('../session/sessionFrontend').SessionFrontend,
) {
  const [presentation, setPresentation] = useState(frontend.snapshot);
  useLayoutEffect(() => {
    setPresentation(frontend.snapshot());
    return frontend.subscribe((event) => {
      if (event.type === 'batch-complete') setPresentation(event.presentation);
    });
  }, [frontend]);
  return presentation;
}
