export type AsyncQueueJob = {
  label: string;
  run: () => Promise<void>;
};

export type AsyncJobQueueOptions = {
  gapMs?: number;
  onError?: (job: AsyncQueueJob, err: unknown) => void;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AsyncJobQueue {
  private frontQueue: AsyncQueueJob[] = [];
  private queue: AsyncQueueJob[] = [];
  private pumping = false;
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
    this.frontQueue = [];
    this.queue = [];
  }

  resetForTests(): void {
    this.frontQueue = [];
    this.queue = [];
    this.pumping = false;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.frontQueue.length > 0 || this.queue.length > 0) {
        if (this.gapMs > 0) await delay(this.gapMs);
        const job = this.frontQueue.shift() ?? this.queue.shift();
        if (!job) continue;
        try {
          await job.run();
        } catch (e) {
          this.onError?.(job, e);
        }
      }
    } finally {
      this.pumping = false;
      if (this.frontQueue.length > 0 || this.queue.length > 0) void this.pump();
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
          this.inFlight = false;
          if (!this.interested || generation !== this.generation) return;
          if (this.target.getNextIntervalMs) {
            this.timer.intervalMs = this.target.getNextIntervalMs();
          }
          scheduleGapTimer(this.timer, () => {
            if (generation === this.generation) this.enqueueIfIdle();
          }, this.interested);
        }
      },
    });
  }
}
