const reportedErrors = new WeakSet<object>();

export function clientErrorText(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message || error.name;
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error, null, 2) ?? String(error);
    } catch {
      // Circular or unserializable rejection values still need a readable report.
    }
  }
  return String(error);
}

export function browserErrorReport(
  event: ErrorEvent | PromiseRejectionEvent,
  recentLog: string,
): string {
  const isRejection = event.type === 'unhandledrejection';
  const reason = isRejection
    ? (event as PromiseRejectionEvent).reason
    : ((event as ErrorEvent).error ?? (event as ErrorEvent).message);
  const lines = [
    `Event: ${isRejection ? 'Unhandled promise rejection' : 'Uncaught JavaScript error'}`,
    `Time: ${new Date().toISOString()}`,
    '',
    clientErrorText(reason),
  ];
  if (!(reason instanceof Error && reason.stack)) {
    lines.push('', 'No originating stack was supplied by the browser.');
  }
  if (!isRejection) {
    const { filename, lineno, colno } = event as ErrorEvent;
    if (filename) lines.push('', `Source: ${filename}:${lineno}:${colno}`);
  }
  lines.push('', 'Recent app activity (before this error):', recentLog || '(none recorded)');
  return lines.join('\n');
}

export function markClientErrorReported(error: unknown): void {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    reportedErrors.add(error as object);
  }
}

export function wasClientErrorReported(error: unknown): boolean {
  return (
    ((typeof error === 'object' && error !== null) || typeof error === 'function') &&
    reportedErrors.has(error as object)
  );
}
