import { parseHubUrl } from '../../components/HubPicker';

describe('hub URL parsing', () => {
  it('defaults a scheme-less hub URL to https', () => {
    expect(parseHubUrl('hub.chiatest.net')).toBe('https://hub.chiatest.net');
    expect(parseHubUrl(' hub.example.com/path ')).toBe('https://hub.example.com');
    expect(parseHubUrl('localhost:3003')).toBe('https://localhost:3003');
    expect(parseHubUrl('hub.example.com:8080/path')).toBe('https://hub.example.com:8080');
  });

  it('preserves an explicitly selected http or https scheme', () => {
    expect(parseHubUrl('http://localhost:3003')).toBe('http://localhost:3003');
    expect(parseHubUrl('https://hub.example.com:444/path')).toBe('https://hub.example.com:444');
  });

  it('rejects unsupported schemes and invalid URLs', () => {
    expect(parseHubUrl('ftp://hub.example.com')).toBeNull();
    expect(parseHubUrl('mailto:player@example.com')).toBeNull();
    expect(parseHubUrl('not a host')).toBeNull();
  });
});
