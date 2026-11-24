import { createElement, createRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { NotificationOverlay } from '../../components/GameSession';
import type { QueuedNotificationModel } from '../session/types';

function render(notification: QueuedNotificationModel, onRetry?: () => void) {
  const onDismiss = jest.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      createElement(NotificationOverlay, {
        notification,
        onDismiss,
        onRetry,
        boundsRef: createRef<HTMLElement>(),
        zClass: 'z-50',
        focusBoundaryPriority: 50,
        ownsKeyboard: false,
      }),
    );
  });
  const buttons = (label: string) =>
    renderer.root.findAll((node) => node.type === 'button' && node.props.children === label);
  return { renderer, onDismiss, buttons };
}

const refusal: QueuedNotificationModel = {
  id: 1n,
  kind: 'infra-error',
  title: 'Error',
  message: 'The wallet did not fund the channel: Operation cancelled by user.',
  retry: 'channel-funding',
};

describe('notification overlay retry', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        innerWidth: 1024,
        innerHeight: 768,
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('offers Retry next to Dismiss for a retryable failure', () => {
    const onRetry = jest.fn();
    const { renderer, onDismiss, buttons } = render(refusal, onRetry);

    expect(buttons('Retry')).toHaveLength(1);
    act(() => buttons('Retry')[0].props.onClick());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => buttons('Dismiss')[0].props.onClick());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('shows only Dismiss for an ordinary notification', () => {
    const { renderer, buttons } = render({ ...refusal, retry: undefined }, jest.fn());

    expect(buttons('Retry')).toHaveLength(0);
    expect(buttons('Dismiss')).toHaveLength(1);
    act(() => renderer.unmount());
  });
});
