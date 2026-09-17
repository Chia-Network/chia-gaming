import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  installProcessTransportSecurity,
  installWebContentsTransportSecurity,
  WEBRTC_IP_HANDLING_POLICY,
} from './transportSecurity.ts';
import { buildNetworkPolicy, withHubTransportSecurityHeaders } from './networkPolicy.ts';

describe('desktop transport security', () => {
  it('enables connection allowlists and sets the WebRTC IP handling policy', () => {
    const switches = new Map([['enable-features', 'ExistingFeature']]);
    installProcessTransportSecurity({
      getSwitchValue: (name) => switches.get(name) ?? '',
      appendSwitch: (name, value) => switches.set(name, value),
    });

    assert.equal(
      switches.get('enable-features'),
      'ExistingFeature,ConnectionAllowlists,OverrideConnectionAllowlistOriginTrial',
    );
    assert.equal(switches.get('force-webrtc-ip-handling-policy'), WEBRTC_IP_HANDLING_POLICY);
  });

  it('restricts every new web contents to the strongest WebRTC IP policy', () => {
    let appliedPolicy = '';
    installWebContentsTransportSecurity({
      setWebRTCIPHandlingPolicy: (policy) => {
        appliedPolicy = policy;
      },
    });

    assert.equal(appliedPolicy, 'disable_non_proxied_udp');
  });

  it('replaces hub transport headers with enforceable WebRTC and WebTransport policy', () => {
    const policy = buildNetworkPolicy({
      hubOrigins: ['https://hub.example'],
      cloudWalletOrigins: ['https://wallet.example'],
    });
    const headers = withHubTransportSecurityHeaders(
      {
        'content-security-policy': ["default-src 'self'"],
        'connection-allowlist': ['("*");webrtc=allow'],
      },
      policy,
    );

    assert.deepEqual(headers['content-security-policy'], [
      "default-src 'self'",
      "default-src http: https: data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' https://hub.example wss://hub.example",
    ]);
    assert.deepEqual(headers['Connection-Allowlist'], [
      '(response-origin "https://hub.example");webrtc=block',
    ]);
    assert.equal(headers['connection-allowlist'], undefined);
  });
});
