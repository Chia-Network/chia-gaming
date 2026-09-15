type HubIframeProps = {
  iframeUrl: string;
};

export function HubIframe({ iframeUrl }: HubIframeProps) {
  return (
    <iframe
      id="hub-iframe"
      className="bg-canvas-bg-subtle"
      style={{ flex: '1 1 0%', width: '100%', border: 'none', margin: 0 }}
      sandbox="allow-scripts allow-same-origin"
      referrerPolicy="no-referrer"
      src={iframeUrl}
    />
  );
}
