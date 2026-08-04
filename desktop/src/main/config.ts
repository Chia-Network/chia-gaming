import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';
import { z } from 'zod';

import { log } from './log';

/**
 * Desktop configuration is untrusted input: it comes from a user-editable file
 * and from the environment. It is validated and rejected with a readable
 * message rather than being allowed to half-apply, because every value here
 * ends up in the network egress allowlist and the renderer CSP.
 */
export type DesktopConfig = {
  /** Bare http(s) origins the app may load the hub lobby UI from. */
  hubOrigins: string[];
};

const DEFAULT_HUB_ORIGINS = ['http://localhost:3003', 'http://127.0.0.1:3003'];

const hubOrigin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}, 'must be a bare http(s) origin with no path, e.g. https://hub.example.com');

const configSchema = z.strictObject({
  hubOrigins: z.array(hubOrigin).min(1).optional(),
});

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

/** Env wins over the config file. Absent keys are omitted so spreads don't erase file values. */
function environmentOverrides(): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  const { CHIA_GAMING_HUB_ORIGINS } = process.env;
  if (CHIA_GAMING_HUB_ORIGINS !== undefined) {
    overrides.hubOrigins = CHIA_GAMING_HUB_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== '');
  }
  return overrides;
}

export function loadDesktopConfig(): DesktopConfig {
  const configFilePath = path.join(app.getPath('userData'), 'config.json');
  const candidate = { ...readConfigFile(configFilePath), ...environmentOverrides() };

  const result = configSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid desktop configuration from ${configFilePath} or the environment:\n${issues}`,
    );
  }

  const config: DesktopConfig = {
    hubOrigins: result.data.hubOrigins ?? [...DEFAULT_HUB_ORIGINS],
  };
  log.info(`hub origins: ${config.hubOrigins.join(', ')}`);
  return config;
}
