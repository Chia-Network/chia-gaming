import { appendRecent, DIAGNOSTIC_LOG_LIMIT } from '../lib/session/historyLimits';

type Listener = (line: string) => void;
let buffer: string[] = [];
const listeners: Set<Listener> = new Set();

function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function log(line: string) {
  const stamped = `[${timestamp()}] ${line}`;
  buffer = appendRecent(buffer, stamped, DIAGNOSTIC_LOG_LIMIT);
  listeners.forEach(fn => fn(stamped));
}

export function subscribeLog(fn: Listener): () => void {
  buffer.forEach(fn);
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Optional extra diagnostic sink.  The CI failure we chase fires while the jest
 * worker is dying, when stderr/console output is lost.  A test (which has `fs`)
 * registers a sink here that appends synchronously to a file on disk -- that
 * survives the worker death, and a later shell step `cat`s the file into the
 * live GitHub Actions log.  Kept out of this (browser-shared) module so we
 * never import `fs` here.
 */
let extraDiagSink: ((line: string) => void) | null = null;

export function setDiagSink(fn: ((line: string) => void) | null): void {
  extraDiagSink = fn;
}

/**
 * Teardown-proof diagnostic sink.
 *
 * The errors we care about most fire *after* the jest test environment is torn
 * down (the late unhandled rejection in load_wasm).  jest patches
 * `global.console`, so a console.* call at that point hits "Cannot log after
 * tests are done" and the line is dropped -- precisely the error we are chasing
 * never gets logged.  `process.stderr.write` is a raw stream jest does NOT
 * patch and it targets the real process, so it survives teardown.  The
 * registered sink (a synchronous file append in tests) survives even a dying
 * worker.  Fall back to console.error only in the browser.
 */
function diagWrite(line: string): void {
  // Durable sink first: it must capture the line even if everything below is
  // about to die.
  if (extraDiagSink) {
    try { extraDiagSink(line); } catch { /* never let logging throw */ }
  }
  try {
    const proc = (typeof process !== 'undefined' ? process : undefined) as
      | { stderr?: { write?: (s: string) => void } }
      | undefined;
    if (proc?.stderr && typeof proc.stderr.write === 'function') {
      proc.stderr.write(line + '\n');
      return;
    }
  } catch { /* fall through to console */ }
  // eslint-disable-next-line no-console
  console.error(line);
}

/** Diagnostic: a single greppable note (no stack). Teardown-proof. */
export function diagNote(message: string): void {
  diagWrite(`DIAG_LOADWASM ${message}`);
}

/**
 * Diagnostic: write a full stack trace with a greppable prefix.  Non-Error
 * throws (strings, wasm RuntimeErrors, rejected events) are wrapped so we still
 * capture a stack at the catch site rather than just an opaque message.
 */
export function diagStack(context: string, e: unknown): void {
  let name = 'Error';
  let message: string;
  let stack: string;
  if (e instanceof Error) {
    name = e.name;
    message = e.message || '(empty message)';
    stack = e.stack ?? '(no stack)';
  } else {
    try {
      message = typeof e === 'string' ? e : JSON.stringify(e);
    } catch {
      message = String(e);
    }
    stack = new Error('(non-Error thrown; stack captured at diagStack call site)').stack ?? '(no stack)';
  }
  diagWrite(`DIAG_LOADWASM ${context}: ${name}: ${message}\n${stack}`);
}
