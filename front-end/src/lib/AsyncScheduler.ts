export type AsyncQueueJob = {
  label: string;
  run: () => Promise<void>;
  onDiscard?: () => void;
};

export type AsyncJobQueueOptions = {
  gapMs?: number;
  onError?: (job: AsyncQueueJob, err: unknown) => void;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AsyncRequestStartGate {
  private turn: Promise<void> = Promise.resolve();
  private lastStartAt: number | null = null;

  constructor(private readonly gapMs: number) {}

  async wait(): Promise<void> {
    let release!: () => void;
    const previousTurn = this.turn;
    this.turn = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previousTurn;
    try {
      if (this.lastStartAt !== null) {
        const remainingMs = this.lastStartAt + this.gapMs - performance.now();
        if (remainingMs > 0) await delay(remainingMs);
      }
      this.lastStartAt = performance.now();
    } finally {
      release();
    }
  }
}

export class AsyncJobQueue {
  private frontQueue: AsyncQueueJob[] = [];
  private queue: AsyncQueueJob[] = [];
  private generation = 0;
  private pumpingGeneration: number | null = null;
  private readonly gapMs: number;
  private readonly onError?: (job: AsyncQueueJob, err: unknown) => void;

  constructor(options: AsyncJobQueueOptions = {}) {
    this.gapMs = options.gapMs ?? 0;
    this.onError = options.onError;
  }

  enqueue(job: AsyncQueueJob): void {
    this.queue.push(job);
    void this.pump();
  }

  enqueueFront(job: AsyncQueueJob): void {
    this.frontQueue.push(job);
    void this.pump();
  }

  clearQueued(): void {
    for (const job of [...this.frontQueue, ...this.queue]) job.onDiscard?.();
    this.frontQueue = [];
    this.queue = [];
  }

  abandonActive(): void {
    const discarded = [...this.frontQueue, ...this.queue];
    this.frontQueue = [];
    this.queue = [];
    this.generation++;
    this.pumpingGeneration = null;
    for (const job of discarded) job.onDiscard?.();
    void this.pump();
  }

  resetForTests(): void {
    this.frontQueue = [];
    this.queue = [];
    this.generation++;
    this.pumpingGeneration = null;
  }

  private async pump(): Promise<void> {
    const generation = this.generation;
    if (this.pumpingGeneration === generation) return;
    this.pumpingGeneration = generation;
    try {
      while (
        generation === this.generation &&
        (this.frontQueue.length > 0 || this.queue.length > 0)
      ) {
        if (this.gapMs > 0) await delay(this.gapMs);
        if (generation !== this.generation) return;
        const job = this.frontQueue.shift() ?? this.queue.shift();
        if (!job) continue;
        try {
          await job.run();
        } catch (e) {
          if (generation === this.generation) this.onError?.(job, e);
        }
      }
    } finally {
      if (generation === this.generation) {
        this.pumpingGeneration = null;
        if (this.frontQueue.length > 0 || this.queue.length > 0) void this.pump();
      }
    }
  }
}

export type GapTimerState = {
  intervalMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  timerActive: boolean;
};

export function makeGapTimer(intervalMs: number): GapTimerState {
  return {
    intervalMs,
    timer: null,
    timerActive: false,
  };
}

export function scheduleGapTimer(
  state: GapTimerState,
  cb: () => void,
  shouldSchedule = true,
): void {
  if (!shouldSchedule || state.timerActive) return;
  state.timerActive = true;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.timerActive = false;
    cb();
  }, state.intervalMs);
  if (typeof state.timer === 'object' && 'unref' in state.timer) state.timer.unref();
}

export function clearGapTimer(state: GapTimerState): void {
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = null;
  state.timerActive = false;
}

export type AsyncPollingSchedulerOptions = {
  label: string;
  queue: AsyncJobQueue;
  intervalMs: number;
};

export interface AsyncPollingTarget {
  runOnce(): Promise<void>;
  onError?(err: unknown): void;
  getNextIntervalMs?(): number;
}

export class AsyncPollingScheduler {
  private interested = false;
  private queued = false;
  private inFlight = false;
  private generation = 0;
  private timer: GapTimerState;
  private readonly label: string;
  private readonly queue: AsyncJobQueue;
  private readonly target: AsyncPollingTarget;

  constructor(options: AsyncPollingSchedulerOptions, target: AsyncPollingTarget) {
    this.label = options.label;
    this.queue = options.queue;
    this.timer = makeGapTimer(options.intervalMs);
    this.target = target;
  }

  start(intervalMs?: number): void {
    const wasInterested = this.interested;
    if (intervalMs !== undefined) this.timer.intervalMs = intervalMs;
    this.interested = true;
    clearGapTimer(this.timer);
    if (!wasInterested) this.generation++;
    this.enqueueIfIdle();
  }

  stop(): void {
    this.interested = false;
    this.queued = false;
    this.inFlight = false;
    this.generation++;
    clearGapTimer(this.timer);
  }

  isInterested(): boolean {
    return this.interested;
  }

  resetForTests(intervalMs?: number): void {
    this.interested = false;
    this.queued = false;
    this.inFlight = false;
    this.generation++;
    if (intervalMs !== undefined) this.timer.intervalMs = intervalMs;
    clearGapTimer(this.timer);
  }

  private enqueueIfIdle(): void {
    if (!this.interested || this.queued || this.inFlight) return;
    this.queued = true;
    const generation = this.generation;
    this.queue.enqueue({
      label: this.label,
      run: async () => {
        if (generation !== this.generation) return;
        this.queued = false;
        if (!this.interested) return;
        this.inFlight = true;
        try {
          await this.target.runOnce();
        } catch (e) {
          this.target.onError?.(e);
        } finally {
          if (generation === this.generation) {
            this.inFlight = false;
            if (this.interested) {
              if (this.target.getNextIntervalMs) {
                this.timer.intervalMs = this.target.getNextIntervalMs();
              }
              scheduleGapTimer(
                this.timer,
                () => {
                  if (generation === this.generation) this.enqueueIfIdle();
                },
                this.interested,
              );
            }
          }
        }
      },
    });
  }
}
