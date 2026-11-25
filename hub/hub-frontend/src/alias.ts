import protocolConstants from 'chia-gaming-protocol-constants';

/** The hub rejects a trimmed name longer than this many UTF-8 bytes. */
export const MAX_ALIAS_BYTES = protocolConstants.aliasBytes.max;

/**
 * Why the hub would reject this display name, or null when it is acceptable.
 * Mirrors the hub's own check so the user is told before the name is sent.
 */
export function aliasError(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return 'Enter a name.';
  if (new TextEncoder().encode(trimmed).byteLength > MAX_ALIAS_BYTES) {
    return `That name is too long. Names can be up to ${MAX_ALIAS_BYTES} bytes, and emoji and many non-Latin characters use several bytes each.`;
  }
  return null;
}
