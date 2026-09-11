import { bindNotificationOverlayDismissKeys } from '../../components/notificationOverlayKeyboard';

function mockWindowKeyListeners(): {
  capture: ((event: KeyboardEvent) => void) | null;
  restore: () => void;
} {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let capture: ((event: KeyboardEvent) => void) | null = null;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: (
        type: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (type === 'keydown' && options === true && typeof handler === 'function') {
          capture = handler as (event: KeyboardEvent) => void;
        }
      },
      removeEventListener: (
        type: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (type === 'keydown' && options === true && handler === capture) {
          capture = null;
        }
      },
    },
  });
  return {
    get capture() {
      return capture;
    },
    restore: () => {
      if (windowDescriptor) {
        Object.defineProperty(globalThis, 'window', windowDescriptor);
      } else {
        delete (globalThis as { window?: unknown }).window;
      }
    },
  };
}

function keyEvent(key: string, extras: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    ...extras,
  } as KeyboardEvent;
}

describe('notification overlay keyboard', () => {
  it('dismisses on Enter in the capture phase so a game handler cannot steal Return', () => {
    const mocked = mockWindowKeyListeners();
    const onDismiss = jest.fn();
    const unbind = bindNotificationOverlayDismissKeys(onDismiss);

    expect(mocked.capture).toEqual(expect.any(Function));
    const event = keyEvent('Enter');
    mocked.capture!(event);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);

    unbind();
    mocked.restore();
  });

  it('dismisses on Escape and ignores modified Enter', () => {
    const mocked = mockWindowKeyListeners();
    const onDismiss = jest.fn();
    const unbind = bindNotificationOverlayDismissKeys(onDismiss);

    mocked.capture!(keyEvent('Escape'));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    mocked.capture!(keyEvent('Enter', { ctrlKey: true }));
    mocked.capture!(keyEvent('a'));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    unbind();
    mocked.restore();
  });

  it('removes the capture listener on unbind', () => {
    const mocked = mockWindowKeyListeners();
    const onDismiss = jest.fn();
    const unbind = bindNotificationOverlayDismissKeys(onDismiss);
    unbind();

    expect(mocked.capture).toBeNull();
    mocked.restore();
  });
});
