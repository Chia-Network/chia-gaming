type HubFrameWindow = Pick<Window, 'postMessage'>;

type HubIframe = {
  readonly contentWindow: HubFrameWindow | null;
  addEventListener(type: 'load', listener: () => void): void;
  removeEventListener(type: 'load', listener: () => void): void;
};

type MessageTarget = {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
};

type HubIframeAuthenticationOptions = {
  iframe: HubIframe;
  iframeUrl: string;
  sessionId: string;
  messageTarget?: MessageTarget;
};

const INITIAL_CREDENTIAL_DELAY_MS = 150;

export function installHubIframeAuthentication({
  iframe,
  iframeUrl,
  sessionId,
  messageTarget = window,
}: HubIframeAuthenticationOptions): () => void {
  const targetOrigin = new URL(iframeUrl).origin;
  const sendCredentials = () => {
    iframe.contentWindow?.postMessage({ type: 'hub-auth', sessionId }, targetOrigin);
  };
  const handleMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow || event.origin !== targetOrigin) return;
    if (
      event.data === null ||
      typeof event.data !== 'object' ||
      (event.data as { type?: unknown }).type !== 'hub-auth-request'
    ) {
      return;
    }
    sendCredentials();
  };

  iframe.addEventListener('load', sendCredentials);
  messageTarget.addEventListener('message', handleMessage);
  const initialSend = setTimeout(sendCredentials, INITIAL_CREDENTIAL_DELAY_MS);

  return () => {
    clearTimeout(initialSend);
    iframe.removeEventListener('load', sendCredentials);
    messageTarget.removeEventListener('message', handleMessage);
  };
}
