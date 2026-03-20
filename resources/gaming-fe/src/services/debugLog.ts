type Listener = (line: string) => void;
const buffer: string[] = [];
const listeners: Set<Listener> = new Set();

export function debugLog(line: string) {
  buffer.push(line);
  listeners.forEach(fn => fn(line));
}

export function subscribeDebugLog(fn: Listener): () => void {
  buffer.forEach(fn);
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
