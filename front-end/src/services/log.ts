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
 * Diagnostic: write a full stack trace straight to stderr with a greppable
 * prefix.  The in-memory log() buffer above has no listener in the jest/CI
 * environment, so `log(String(e))` lines never reach the CI test output;
 * console.error does, and prints the stack for real Error objects.  Non-Error
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
  // eslint-disable-next-line no-console
  console.error(`DIAG_LOADWASM ${context}: ${name}: ${message}\n${stack}`);
}
