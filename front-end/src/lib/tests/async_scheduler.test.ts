import { AsyncJobQueue } from '../AsyncScheduler';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('AsyncJobQueue generations', () => {
  it('abandons a forever-pending active job and discards queued jobs exactly once', async () => {
    const active = deferred();
    const discarded = jest.fn();
    const calls: string[] = [];
    const queue = new AsyncJobQueue();

    queue.enqueue({
      label: 'old-active',
      run: async () => {
        calls.push('old-active');
        await active.promise;
      },
    });
    queue.enqueue({
      label: 'old-queued',
      run: async () => {
        calls.push('old-queued');
      },
      onDiscard: discarded,
    });

    queue.abandonActive();
    queue.enqueue({
      label: 'new',
      run: async () => {
        calls.push('new');
      },
    });
    await flushMicrotasks();

    expect(calls).toEqual(['old-active', 'new']);
    expect(discarded).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores a late abandoned-job %s while the current generation is active',
    async (completion) => {
      const oldActive = deferred();
      const newActive = deferred();
      const onError = jest.fn();
      const calls: string[] = [];
      const queue = new AsyncJobQueue({ onError });

      queue.enqueue({
        label: 'old-active',
        run: () => oldActive.promise,
      });
      queue.abandonActive();
      queue.enqueue({
        label: 'new-active',
        run: async () => {
          calls.push('new-active');
          await newActive.promise;
        },
      });
      queue.enqueue({
        label: 'new-queued',
        run: async () => {
          calls.push('new-queued');
        },
      });

      if (completion === 'resolve') {
        oldActive.resolve();
      } else {
        oldActive.reject(new Error('stale failure'));
      }
      await flushMicrotasks();

      expect(calls).toEqual(['new-active']);
      expect(onError).not.toHaveBeenCalled();

      newActive.resolve();
      await flushMicrotasks();
      expect(calls).toEqual(['new-active', 'new-queued']);
      expect(onError).not.toHaveBeenCalled();
    },
  );
});
