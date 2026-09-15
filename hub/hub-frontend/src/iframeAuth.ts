export function hubSessionFromParentMessage(
  event: MessageEvent,
  parentWindow: Window,
): string | null {
  if (event.source !== parentWindow || event.data?.type !== 'hub-auth') return null;
  const sessionId = event.data.sessionId;
  return typeof sessionId === 'string' && /^[0-9a-f]{32}$/.test(sessionId) ? sessionId : null;
}
