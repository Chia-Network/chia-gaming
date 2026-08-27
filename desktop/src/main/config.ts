import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';
import { z } from 'zod';

import { log } from './log';

/**
 * Desktop configuration is untrusted input: it comes from a user-editable file.
 * It is validated and rejected with a readable message rather than being
 * allowed to half-apply, because every value here ends up in the network egress
 * allowlist and the renderer CSP.
 */
export type DesktopConfig = {
  /** Bare http(s) origins the app may load the hub lobby UI from. */
  hubOrigins: string[];
  /**
   * Bare http(s) origins the app may reach for Cloud Wallet OAuth (API + UI).
   * Popups and `fetch` to these origins are allowed; they are not framed.
   */
  cloudWalletOrigins: string[];
};

const DEFAULT_HUB_ORIGINS = ['http://localhost:3003', 'http://127.0.0.1:3003'];

/** Matches `CLOUD_WALLET_*_URL` defaults in `front-end/src/constants/env.ts`. */
const DEFAULT_CLOUD_WALLET_ORIGINS = [
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://localhost:3000',
  'http://localhost:3001',
];

export const hubOriginSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}, 'must be a bare http(s) origin with no path, e.g. https://hub.example.com');

const configSchema = z.strictObject({
  hubOrigins: z.array(hubOriginSchema).min(1).optional(),
  cloudWalletOrigins: z.array(hubOriginSchema).min(1).optional(),
});

function configFilePath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfigFile(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Write the allowlists back to the config file, so a hub the user approved
 * at runtime is still trusted next launch. Preserves `cloudWalletOrigins` so a
 * hub grant cannot wipe Cloud Wallet config. Written via a temporary file and a
 * rename: a crash mid-write would otherwise leave config.json truncated, and
 * the app refuses to start on malformed config.
 */
export function persistHubOrigins(hubOrigins: readonly string[]): void {
  const target = configFilePath();
  const existing = existsSync(target) ? readConfigFile(target) : {};
  const payload: Record<string, unknown> = { hubOrigins };
  if (existing.cloudWalletOrigins !== undefined) {
    payload.cloudWalletOrigins = existing.cloudWalletOrigins;
  }
  const contents = `${JSON.stringify(payload, null, 2)}\n`;
  const temporary = `${target}.tmp`;

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, target);
  log.info(`wrote ${hubOrigins.length} hub origin(s) to ${target}`);
}

export function loadDesktopConfig(): DesktopConfig {
  const candidate = readConfigFile(configFilePath());

  const result = configSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid desktop configuration from ${configFilePath()}:\n${issues}`);
  }

  const config: DesktopConfig = {
    hubOrigins: result.data.hubOrigins ?? [...DEFAULT_HUB_ORIGINS],
    cloudWalletOrigins: result.data.cloudWalletOrigins ?? [...DEFAULT_CLOUD_WALLET_ORIGINS],
  };
  log.info(`hub origins: ${config.hubOrigins.join(', ')}`);
  log.info(`cloud wallet origins: ${config.cloudWalletOrigins.join(', ')}`);
  return config;
}
