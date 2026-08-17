const reportedErrors = new WeakSet<object>();

export function clientErrorText(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message || error.name;
  return String(error);
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
