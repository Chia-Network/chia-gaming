import { jsonStringify } from './jsonSafe';

const WC_IPC_PREFIX_RE = /^\[wc:(-?\d+)(?:\|([^[\]]*))?\]\s*/;

function messageFromData(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.error === 'string' && d.error.length > 0) return d.error;
  const structured = d.structuredError;
  if (structured !== null && typeof structured === 'object') {
    const msg = (structured as Record<string, unknown>).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  return undefined;
}

function stripWcIpcPrefix(message: string): { message: string; data?: unknown } {
  const match = message.match(WC_IPC_PREFIX_RE);
  if (!match) return { message };
  let data: unknown;
  if (match[2] && typeof atob === 'function') {
    try {
      data = JSON.parse(atob(match[2]));
    } catch {
      data = undefined;
    }
  }
  return { message: message.slice(match[0].length), data };
}

function parseJsonMessage(message: string): string | undefined {
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    const fromData = messageFromData(parsed?.data);
    if (fromData) return fromData;
    if (typeof parsed?.error === 'string' && parsed.error.length > 0) return parsed.error;
    if (typeof parsed?.message === 'string' && parsed.message.length > 0) return parsed.message;
  } catch {
    /* not JSON */
  }
  return undefined;
}

function fallbackErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === 'string') {
      const parts = [obj.message];
      if ('code' in obj) parts.push(`code=${String(obj.code)}`);
      if ('data' in obj && obj.data !== undefined) {
        try {
          parts.push(`data=${jsonStringify(obj.data)}`);
        } catch {
          /* skip */
        }
      }
      return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : parts[0];
    }
    try {
      return jsonStringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

/**
 * Extract a human-readable wallet/daemon error from WalletConnect JSON-RPC
 * rejections, inline daemon payloads, or Error wrappers.
 */
export function normalizeWalletRpcError(err: unknown): string {
  if (typeof err === 'string') {
    const stripped = stripWcIpcPrefix(err);
    const fromData = messageFromData(stripped.data);
    if (fromData) return fromData;
    const fromJson = parseJsonMessage(stripped.message);
    if (fromJson) return fromJson;
    return stripped.message;
  }

  if (err instanceof Error) {
    const stripped = stripWcIpcPrefix(err.message);
    const fromData = messageFromData(stripped.data);
    if (fromData) return fromData;
    const fromJson = parseJsonMessage(stripped.message);
    if (fromJson) return fromJson;
    if (stripped.message !== err.message) return stripped.message;
    return err.message;
  }

  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    const fromData = messageFromData(obj.data);
    if (fromData) return fromData;
    if (typeof obj.message === 'string') {
      const stripped = stripWcIpcPrefix(obj.message);
      const nestedData = messageFromData(stripped.data) ?? messageFromData(obj.data);
      if (nestedData) return nestedData;
      const fromJson = parseJsonMessage(stripped.message);
      if (fromJson) return fromJson;
      return stripped.message;
    }
    if (typeof obj.error === 'string' && obj.error.length > 0) return obj.error;
  }

  return fallbackErrorText(err);
}

/** User-facing copy for common wallet balance failures. */
export function friendlyWalletMessage(msg: string): string {
  if (/insufficient funds/i.test(msg)) {
    return 'Wallet reports insufficient funds. It may be that your wallet has enough balance but some coins are locked. Free up locked coins in your wallet and try again.';
  }
  if (/spendable balance/i.test(msg)) {
    return `Wallet reports insufficient spendable balance. ${msg}`;
  }
  return msg;
}

/** Normalize then apply friendly wording for GUI display. */
export function walletErrorForDisplay(err: unknown): string {
  return friendlyWalletMessage(normalizeWalletRpcError(err));
}
