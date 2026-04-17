type Listener = (line: string) => void;
const buffer: string[] = [];
const listeners: Set<Listener> = new Set();

function isoTimestamp(): string {
  return new Date().toISOString();
}

function monotonicMs(): string {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now().toFixed(1);
  }
  return '0.0';
}

function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function debugLog(line: string) {
  const stamped = `[${timestamp()}] ${line}`;
  buffer.push(stamped);
  listeners.forEach(fn => fn(stamped));
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function debugEvent(scope: string, event: string, fields?: Record<string, unknown>) {
  const parts: string[] = [`[${scope}]`, `ev=${event}`, `iso=${isoTimestamp()}`, `mono_ms=${monotonicMs()}`];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      parts.push(`${k}=${formatValue(v)}`);
    }
  }
  debugLog(parts.join(' '));
}

export function subscribeDebugLog(fn: Listener): () => void {
  buffer.forEach(fn);
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
