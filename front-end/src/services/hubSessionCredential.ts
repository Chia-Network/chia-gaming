const encoder = new TextEncoder();
const CONTEXT = 'chia-gaming hub session v1\0';

function bytesFromHex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{32}$/.test(value)) {
    throw new Error('hub session master must be 16 lowercase hexadecimal bytes');
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function hexFromBytes(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalHubOrigin(hubUrl: string): string {
  const url = new URL(hubUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported hub URL protocol: ${url.protocol}`);
  }
  return url.origin;
}

export async function deriveHubSessionId(
  masterSessionId: string,
  hubUrl: string,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<string> {
  const key = await subtle.importKey(
    'raw',
    bytesFromHex(masterSessionId),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const origin = canonicalHubOrigin(hubUrl);
  const signature = await subtle.sign('HMAC', key, encoder.encode(`${CONTEXT}${origin}`));
  return hexFromBytes(new Uint8Array(signature).subarray(0, 16));
}
