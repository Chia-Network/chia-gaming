/**
 * Tests for the connection error event flow:
 *   blobSingleton callback → rxjs Subject → useWasmBlob subscription (debounced toasts)
 *
 * These tests replicate the exact logic from blobSingleton.ts and useWasmBlob.ts
 * without needing React or WASM dependencies.
 */
import { Subject } from 'rxjs';

type WasmEvent =
  | { type: 'notification'; data: any }
  | { type: 'error'; error: string }
  | { type: 'finished' }
  | { type: 'address'; data: any }
  | { type: 'connection_error'; error: string }
  | { type: 'connection_restored' };

// --- blobSingleton callback logic (extracted) ---

function makeBlobCallback(emitter: { next: (evt: WasmEvent) => void }) {
  return (msg: string) => {
    if (msg) {
      emitter.next({ type: 'connection_error', error: msg });
    } else {
      emitter.next({ type: 'connection_restored' });
    }
  };
}

// --- useWasmBlob subscription logic (extracted) ---

interface ToastInput {
  title: string;
  description?: string;
  variant?: 'default' | 'destructive';
}

function makeSubscriptionHandler(toastFn: (input: ToastInput) => void) {
  let connectionErrorShown = false;

  return (evt: WasmEvent) => {
    switch (evt.type) {
      case 'connection_error':
        if (!connectionErrorShown) {
          connectionErrorShown = true;
          toastFn({
            title: 'Connection Lost',
            description: 'Attempting to reconnect...',
            variant: 'destructive',
          });
        }
        break;
      case 'connection_restored':
        if (connectionErrorShown) {
          connectionErrorShown = false;
          toastFn({
            title: 'Connection Restored',
            description: 'Reconnected to game server',
          });
        }
        break;
    }
  };
}

// --- Tests ---

describe('blobSingleton callback → rxjs event conversion', () => {
  it('converts non-empty message to connection_error event', () => {
    const subject = new Subject<WasmEvent>();
    const events: WasmEvent[] = [];
    subject.subscribe({ next: (evt) => events.push(evt) });

    const callback = makeBlobCallback({ next: (evt) => subject.next(evt) });
    callback('Connection error: net::ERR_CONNECTION_REFUSED');

    expect(events).toEqual([
      { type: 'connection_error', error: 'Connection error: net::ERR_CONNECTION_REFUSED' },
    ]);
  });

  it('converts empty message to connection_restored event', () => {
    const subject = new Subject<WasmEvent>();
    const events: WasmEvent[] = [];
    subject.subscribe({ next: (evt) => events.push(evt) });

    const callback = makeBlobCallback({ next: (evt) => subject.next(evt) });
    callback('');

    expect(events).toEqual([{ type: 'connection_restored' }]);
  });

  it('handles full error-then-restore cycle', () => {
    const subject = new Subject<WasmEvent>();
    const events: WasmEvent[] = [];
    subject.subscribe({ next: (evt) => events.push(evt) });

    const callback = makeBlobCallback({ next: (evt) => subject.next(evt) });
    callback('Connection error: refused');
    callback('Disconnected: transport close');
    callback('');

    expect(events).toEqual([
      { type: 'connection_error', error: 'Connection error: refused' },
      { type: 'connection_error', error: 'Disconnected: transport close' },
      { type: 'connection_restored' },
    ]);
  });
});

describe('useWasmBlob toast debounce logic', () => {
  it('fires destructive toast on first connection_error', () => {
    const toasts: ToastInput[] = [];
    const handler = makeSubscriptionHandler((t) => toasts.push(t));

    handler({ type: 'connection_error', error: 'fail' });

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toEqual({
      title: 'Connection Lost',
      description: 'Attempting to reconnect...',
      variant: 'destructive',
    });
  });

  it('debounces repeated connection_error events (only one toast per episode)', () => {
    const toasts: ToastInput[] = [];
    const handler = makeSubscriptionHandler((t) => toasts.push(t));

    handler({ type: 'connection_error', error: 'attempt 1' });
    handler({ type: 'connection_error', error: 'attempt 2' });
    handler({ type: 'connection_error', error: 'attempt 3' });

    expect(toasts).toHaveLength(1);
    expect(toasts[0].title).toBe('Connection Lost');
  });

  it('fires toast on connection_restored after error', () => {
    const toasts: ToastInput[] = [];
    const handler = makeSubscriptionHandler((t) => toasts.push(t));

    handler({ type: 'connection_error', error: 'fail' });
    handler({ type: 'connection_restored' });

    expect(toasts).toHaveLength(2);
    expect(toasts[1]).toEqual({
      title: 'Connection Restored',
      description: 'Reconnected to game server',
    });
  });

  it('does not fire restored toast without prior error', () => {
    const toasts: ToastInput[] = [];
    const handler = makeSubscriptionHandler((t) => toasts.push(t));

    handler({ type: 'connection_restored' });

    expect(toasts).toHaveLength(0);
  });

  it('resets debounce after restore, allowing new error toast', () => {
    const toasts: ToastInput[] = [];
    const handler = makeSubscriptionHandler((t) => toasts.push(t));

    handler({ type: 'connection_error', error: 'episode 1' });
    handler({ type: 'connection_restored' });
    handler({ type: 'connection_error', error: 'episode 2' });

    expect(toasts).toHaveLength(3);
    expect(toasts.map((t) => t.title)).toEqual([
      'Connection Lost',
      'Connection Restored',
      'Connection Lost',
    ]);
  });

  it('ignores unrelated event types', () => {
    const toasts: ToastInput[] = [];
    const handler = makeSubscriptionHandler((t) => toasts.push(t));

    handler({ type: 'notification', data: {} });
    handler({ type: 'error', error: 'wasm error' });
    handler({ type: 'finished' });

    expect(toasts).toHaveLength(0);
  });

  it('full integration: blobSingleton callback → rxjs → toast handler', () => {
    const subject = new Subject<WasmEvent>();
    const toasts: ToastInput[] = [];
    const handler = makeSubscriptionHandler((t) => toasts.push(t));
    subject.subscribe({ next: handler });

    const callback = makeBlobCallback({ next: (evt) => subject.next(evt) });

    callback('Connection error: net::ERR_CONNECTION_REFUSED');
    callback('Connection error: net::ERR_CONNECTION_REFUSED');
    callback('');
    callback('Connection error: server restarted');

    expect(toasts).toHaveLength(3);
    expect(toasts.map((t) => t.title)).toEqual([
      'Connection Lost',
      'Connection Restored',
      'Connection Lost',
    ]);
  });
});
