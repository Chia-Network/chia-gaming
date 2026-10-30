import { isAppUrl } from './appUrl.ts';

type InvokeSender = {
  senderFrame: { url: string } | null;
  sender: { mainFrame: unknown };
};

/**
 * True when an IPC invoke came from the player document's top frame. Sub-frames
 * (hub lobby, WalletConnect Verify) and remote documents never qualify.
 */
export function isPlayerDocumentSender(event: InvokeSender): boolean {
  const frame = event.senderFrame;
  return frame !== null && frame === event.sender.mainFrame && isAppUrl(frame.url);
}

export function describeSender(event: InvokeSender): string {
  return event.senderFrame === null ? 'a gone frame' : event.senderFrame.url;
}
