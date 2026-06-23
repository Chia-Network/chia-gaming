type Listener = (line: string) => void;
const buffer: string[] = [];
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
  buffer.push(stamped);
  listeners.forEach(fn => fn(stamped));
}

export function subscribeLog(fn: Listener): () => void {
  buffer.forEach(fn);
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Teardown-proof diagnostic sink.
 *
 * The errors we care about most fire *after* the jest test environment is torn
 * down (the late unhandled rejection in load_wasm).  jest patches
 * `global.console`, so a console.* call at that point hits "Cannot log after
 * tests are done" and the line is dropped -- precisely the error we are chasing
 * never gets logged.  `process.stderr.write` is a raw stream jest does NOT
 * patch and it targets the real process, so it survives teardown.  Fall back to
 * console.error only in the browser, where `process` is unavailable.
 */
function diagWrite(line: string): void {
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
