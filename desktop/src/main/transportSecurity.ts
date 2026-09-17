export const WEBRTC_IP_HANDLING_POLICY = 'disable_non_proxied_udp';
export const CONNECTION_ALLOWLIST_FEATURES = [
  'ConnectionAllowlists',
  'OverrideConnectionAllowlistOriginTrial',
];

type ChromiumCommandLine = {
  getSwitchValue(name: string): string;
  appendSwitch(name: string, value: string): void;
};

type WebRTCPolicyTarget = {
  setWebRTCIPHandlingPolicy(policy: string): void;
};

export function installProcessTransportSecurity(commandLine: ChromiumCommandLine): void {
  const enabledFeatures = new Set(
    commandLine
      .getSwitchValue('enable-features')
      .split(',')
      .map((feature) => feature.trim())
      .filter(Boolean),
  );
  for (const feature of CONNECTION_ALLOWLIST_FEATURES) {
    enabledFeatures.add(feature);
  }
  commandLine.appendSwitch('enable-features', [...enabledFeatures].join(','));
  commandLine.appendSwitch('force-webrtc-ip-handling-policy', WEBRTC_IP_HANDLING_POLICY);
}

export function installWebContentsTransportSecurity(contents: WebRTCPolicyTarget): void {
  contents.setWebRTCIPHandlingPolicy(WEBRTC_IP_HANDLING_POLICY);
}
