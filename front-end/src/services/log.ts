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
  listeners.forEach((fn) => fn(stamped));
}

export function subscribeLog(fn: Listener): () => void {
  buffer.forEach(fn);
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Log a single error-context note. */
export function diagNote(message: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[error] ${message}`);
}

/**
 * Log an error with a full stack trace. Uses console.error so tests can spy on
 * and suppress expected error-path output. Non-Error throws are wrapped so the
 * catch site is recorded rather than just an opaque message.
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
    stack = new Error('(non-Error thrown; stack captured at catch site)').stack ?? '(no stack)';
  }
  // eslint-disable-next-line no-console
  console.error(`[error] ${context}: ${name}: ${message}\n${stack}`);
}

