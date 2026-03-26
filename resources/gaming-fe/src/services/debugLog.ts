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

export function debugLog(line: string) {
  const stamped = `[${timestamp()}] ${line}`;
  buffer.push(stamped);
  listeners.forEach(fn => fn(stamped));
}

export function subscribeDebugLog(fn: Listener): () => void {
  buffer.forEach(fn);
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
