export function hubSessionFromParentMessage(
  event: MessageEvent,
  parentWindow: Window,
  allowedParentOrigins: ReadonlySet<string>,
): string | null {
  if (
    event.source !== parentWindow ||
    !allowedParentOrigins.has(event.origin) ||
    event.data?.type !== 'hub-auth'
  ) {
    return null;
  }
  const sessionId = event.data.sessionId;
  return typeof sessionId === 'string' && /^[0-9a-f]{32}$/.test(sessionId) ? sessionId : null;
}

export function parentOriginsFromPayload(payload: unknown): ReadonlySet<string> | null {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { origins?: unknown }).origins)
  ) {
    return null;
  }
  const origins = (payload as { origins: unknown[] }).origins;
  if (origins.length === 0 || origins.some((origin) => typeof origin !== 'string')) {
    return null;
  }
  return new Set(origins as string[]);
}
