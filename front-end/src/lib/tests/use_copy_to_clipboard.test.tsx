import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';

const RESET_MS = 100;

describe('useCopyToClipboard', () => {
  let renderer: ReactTestRenderer | undefined;
  let api: ReturnType<typeof useCopyToClipboard>;
  let writeText: jest.Mock;
  let originalNavigator: PropertyDescriptor | undefined;

  function Harness() {
    api = useCopyToClipboard(RESET_MS);
    return null;
  }

  function setClipboard(clipboard: unknown): void {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard },
    });
  }

  function copy(text: string): Promise<void> {
    return act(async () => {
      await api.copy(text);
    });
  }

  // react-test-renderer logs its own one-time deprecation warning; ignore it.
  function hookErrors(): unknown[][] {
    return (console.error as jest.Mock).mock.calls.filter(
      ([message]) => typeof message === 'string' && message.startsWith('[useCopyToClipboard]'),
    );
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    writeText = jest.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    act(() => {
      renderer = create(createElement(Harness));
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  });

  it('reports copied after a successful write, then returns to idle', async () => {
    expect(api.state).toBe('idle');

    await copy('0xabc');

    expect(writeText).toHaveBeenCalledWith('0xabc');
    expect(api.state).toBe('copied');

    act(() => {
      jest.advanceTimersByTime(RESET_MS);
    });
    expect(api.state).toBe('idle');
  });

  it('reports failed without rejecting when the browser refuses the write', async () => {
    const denied = new Error('NotAllowedError');
    writeText.mockRejectedValue(denied);

    // A rejected write must resolve (not throw) so no unhandled rejection escapes.
    await copy('secret');

    expect(api.state).toBe('failed');
    expect(hookErrors()).toEqual([['[useCopyToClipboard] write failed', denied]]);

    act(() => {
      jest.advanceTimersByTime(RESET_MS);
    });
    expect(api.state).toBe('idle');
  });

  it('reports failed when navigator.clipboard is unavailable', async () => {
    setClipboard(undefined);

    await copy('secret');

    expect(api.state).toBe('failed');
    expect(hookErrors()).toEqual([['[useCopyToClipboard] write failed', expect.any(TypeError)]]);
  });

  it('restarts the reset timer on a repeated copy', async () => {
    await copy('one');
    act(() => {
      jest.advanceTimersByTime(RESET_MS - 40);
    });
    await copy('two');

    act(() => {
      jest.advanceTimersByTime(RESET_MS - 40);
    });
    expect(api.state).toBe('copied');

    act(() => {
      jest.advanceTimersByTime(40);
    });
    expect(api.state).toBe('idle');
  });

  it('clears the pending reset timer on unmount', async () => {
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    await copy('one');
    const resetCall = setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === RESET_MS);
    expect(resetCall).toBeGreaterThanOrEqual(0);
    const resetTimer = setTimeoutSpy.mock.results[resetCall].value;

    const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');
    act(() => renderer?.unmount());
    renderer = undefined;

    expect(clearTimeoutSpy).toHaveBeenCalledWith(resetTimer);
  });
});
