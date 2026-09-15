import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  installProcessTransportSecurity,
  installWebContentsTransportSecurity,
  WEBRTC_IP_HANDLING_POLICY,
} from './transportSecurity.ts';

describe('desktop transport security', () => {
  it('disables WebTransport without dropping existing disabled features', () => {
    const switches = new Map([['disable-features', 'ExistingFeature']]);
    installProcessTransportSecurity({
      getSwitchValue: (name) => switches.get(name) ?? '',
      appendSwitch: (name, value) => switches.set(name, value),
    });

    assert.equal(switches.get('disable-features'), 'ExistingFeature,WebTransport');
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
});
