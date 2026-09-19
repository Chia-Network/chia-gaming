import type { SessionController } from '../../hooks/SessionController';
import type { ReliableCommitCoordinator } from '../../services/PeerSession';

export interface TestCommitCoordinatorOptions {
  persist?: () => void | Promise<void>;
}

interface PendingExternalEffect {
  readonly launcher: () => Promise<void>;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Controller-only tests do not have a SessionMachineRuntime to own their
 * durability boundary. This coordinator preserves the runtime's reliable
 * commit and released-effect contract without adding a production fallback.
 */
export function attachControllerOnlyTestCommitCoordinator(
  controller: SessionController,
  options: TestCommitCoordinatorOptions = {},
): ReliableCommitCoordinator {
  let dirty = false;
  const pendingExternalEffects = new Map<string, PendingExternalEffect>();
  let flushing: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void coordinator.flush().catch(() => {});
    }, 0);
  };

  const coordinator: ReliableCommitCoordinator = {
    requestCommit: () => {
      dirty = true;
      schedule();
    },
    enqueue: (work) => {
      work();
    },
    releaseAfterPersistence: (key, launcher) => {
      const pending = pendingExternalEffects.get(key);
      if (pending) return pending.promise;

      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((settle, fail) => {
        resolve = settle;
        reject = fail;
      });
      pendingExternalEffects.set(key, { launcher, promise, resolve, reject });
      dirty = true;
      schedule();
      return promise;
    },
    flush: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flushing = flushing
        .catch(() => {})
        .then(async () => {
          while (dirty) {
            try {
              dirty = false;
              controller.flushDeferredWork();
              const commit = controller.prepareReliableCommit();
              const externalEffects = [...pendingExternalEffects.entries()];
              const releaseExternalEffects = () => {
                for (const [key, effect] of externalEffects) {
                  if (pendingExternalEffects.get(key) !== effect) continue;
                  pendingExternalEffects.delete(key);
                  let completion: Promise<void>;
                  try {
                    completion = effect.launcher();
                  } catch (error) {
                    effect.reject(error);
                    continue;
                  }
                  void Promise.resolve(completion).then(effect.resolve, effect.reject);
                }
              };

              try {
                const rejection = controller.prepareInboundSessionRejectPersistence();
                if (rejection) {
                  await rejection.write();
                } else {
                  await Promise.resolve(options.persist?.());
                }
              } catch (error) {
                controller.completeReliableCommit(commit, false);
                releaseExternalEffects();
                throw error;
              }
              controller.completeReliableCommit(commit, true);
              releaseExternalEffects();
            } catch (error) {
              dirty = true;
              controller.reportDurabilityError(error);
              throw error;
            }
          }
        });
      return flushing;
    },
  };

  controller.attachTransactionCoordinator(coordinator);
  return coordinator;
}
