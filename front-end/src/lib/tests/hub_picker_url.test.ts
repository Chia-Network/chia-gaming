import { parseHubUrl } from '../../components/HubPicker';

describe('hub URL parsing', () => {
  it('defaults a scheme-less hub URL to https', () => {
    expect(parseHubUrl('hub.chiatest.net')).toBe('https://hub.chiatest.net');
    expect(parseHubUrl(' hub.example.com/path ')).toBe('https://hub.example.com/path');
    expect(parseHubUrl('localhost:3003')).toBe('https://localhost:3003');
    expect(parseHubUrl('hub.example.com:8080/path')).toBe('https://hub.example.com:8080/path');
  });

  it('preserves an explicitly selected http or https scheme', () => {
    expect(parseHubUrl('http://localhost:3003')).toBe('http://localhost:3003');
    expect(parseHubUrl('https://hub.example.com:444/path')).toBe(
      'https://hub.example.com:444/path',
    );
  });

  it('normalizes trailing slashes and excludes credentials, query and fragment', () => {
    expect(parseHubUrl('https://user:password@hub.example/hubs/beta/?x=1#lobby')).toBe(
      'https://hub.example/hubs/beta',
    );
  });

  it('rejects unsupported schemes and invalid URLs', () => {
    expect(parseHubUrl('ftp://hub.example.com')).toBeNull();
    expect(parseHubUrl('mailto:player@example.com')).toBeNull();
    expect(parseHubUrl('not a host')).toBeNull();
  });
});
