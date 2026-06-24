/*
 * DBG_SUITE: temporary suite-wide flake diagnostics.
 *
 * Two unrelated async-ordering tests (blockchain_poller "skips transient
 * partial snapshots" and message_protocol "delivers 3, 1, 2") have flaked in CI
 * on different runs. That pattern is consistent with a late async error (an
 * unhandled rejection or uncaught exception from leaked timers/promises) firing
 * while an *unrelated* test is the "current" one -- a jest worker runs many test
 * files in one process, so a stray async op from one file can reject during a
 * later file's test, and jest blames whatever test is running.
 *
 * This setup installs ONE process-level handler per worker (process is shared
 * across files in a worker) that records, durably, the test/file that was
 * actually executing when any such error fired, plus runtime versions and
 * crypto availability. It also tracks the current test via beforeEach/afterEach
 * in every file by stashing it on the shared `process` object so the single
 * handler can read the latest value regardless of which file's module instance
 * registered it.
 *
 * Remove this file (and its setupFilesAfterEnv entry + the CI cat of
 * jest_diag.*.log) once the flake is root-caused.
 */
import * as fs from 'fs';
import * as path from 'path';

type DiagProcess = NodeJS.Process & {
  __DBG_SUITE_INSTALLED?: boolean;
  __DBG_SUITE_CURRENT?: { test: string; file: string };
  __DBG_SUITE_FILE?: string;
};

const proc = process as DiagProcess;

function diagFilePath(): string {
  const base = process.env.JEST_DIAG_FILE_BASE || path.resolve(process.cwd(), 'jest_diag');
  const worker = process.env.JEST_WORKER_ID || '0';
  return `${base}.${worker}.log`;
}

function write(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  try {
    fs.appendFileSync(proc.__DBG_SUITE_FILE as string, stamped + '\n');
  } catch {
    /* never let diagnostics throw */
  }
  try {
    process.stderr.write(stamped + '\n');
  } catch {
    /* ignore */
  }
}

function describeThrown(e: unknown): string {
  if (e instanceof Error) {
    return `${e.name}: ${e.message}\n${e.stack ?? ''}`;
  }
  try {
    return `non-Error(${typeof e}): ${JSON.stringify(e)}`;
  } catch {
    return `non-Error(${typeof e}): ${String(e)}`;
  }
}

// Install exactly once per worker process. `process` is shared across all test
// files run by a worker, so this guard (and the handlers) survive file changes.
if (!proc.__DBG_SUITE_INSTALLED) {
  proc.__DBG_SUITE_INSTALLED = true;
  proc.__DBG_SUITE_FILE = diagFilePath();
  // Truncate this worker's file once at worker start so each CI run is clean.
  try {
    fs.writeFileSync(proc.__DBG_SUITE_FILE, '');
  } catch {
    /* ignore */
  }

  const cr = (globalThis as unknown as { crypto?: { subtle?: { digest?: unknown } } }).crypto;
  write(
    `DBG_SUITE worker=${process.env.JEST_WORKER_ID ?? '?'} node=${process.version} ` +
      `versions=${JSON.stringify(process.versions)} ` +
      `crypto=${typeof cr} subtle=${typeof cr?.subtle} digest=${typeof cr?.subtle?.digest}`,
  );

  process.on('unhandledRejection', (reason: unknown) => {
    const cur = proc.__DBG_SUITE_CURRENT ?? { test: '(none)', file: '(none)' };
    write(
      `DBG_SUITE unhandledRejection during test="${cur.test}" file="${cur.file}": ` +
        describeThrown(reason),
    );
  });
  process.on('uncaughtException', (err: unknown) => {
    const cur = proc.__DBG_SUITE_CURRENT ?? { test: '(none)', file: '(none)' };
    write(
      `DBG_SUITE uncaughtException during test="${cur.test}" file="${cur.file}": ` +
        describeThrown(err),
    );
  });
}

// Runs in every file (setupFilesAfterEnv is per-file). Stash the current test on
// the shared process object so the single installed handler sees the latest.
beforeEach(() => {
  const state = expect.getState();
  proc.__DBG_SUITE_CURRENT = {
    test: state.currentTestName ?? '(unknown)',
    file: state.testPath ?? '(unknown)',
  };
});

afterEach(() => {
  const prev = proc.__DBG_SUITE_CURRENT?.test ?? '(unknown)';
  proc.__DBG_SUITE_CURRENT = {
    test: `(between tests, last=${prev})`,
    file: proc.__DBG_SUITE_CURRENT?.file ?? '(unknown)',
  };
});
