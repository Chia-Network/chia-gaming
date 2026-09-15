export const WEBRTC_IP_HANDLING_POLICY = 'disable_non_proxied_udp';
export const DISABLED_TRANSPORT_FEATURE = 'WebTransport';

type ChromiumCommandLine = {
  getSwitchValue(name: string): string;
  appendSwitch(name: string, value: string): void;
};

type WebRTCPolicyTarget = {
  setWebRTCIPHandlingPolicy(policy: string): void;
};

export function installProcessTransportSecurity(commandLine: ChromiumCommandLine): void {
  const disabledFeatures = new Set(
    commandLine
      .getSwitchValue('disable-features')
      .split(',')
      .map((feature) => feature.trim())
      .filter(Boolean),
  );
  disabledFeatures.add(DISABLED_TRANSPORT_FEATURE);
  commandLine.appendSwitch('disable-features', [...disabledFeatures].join(','));
  commandLine.appendSwitch('force-webrtc-ip-handling-policy', WEBRTC_IP_HANDLING_POLICY);
}

export function installWebContentsTransportSecurity(contents: WebRTCPolicyTarget): void {
  contents.setWebRTCIPHandlingPolicy(WEBRTC_IP_HANDLING_POLICY);
}
