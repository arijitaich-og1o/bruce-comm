import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BruceError } from './util.js';

export const SERVER_NAME = 'bruce-comm';
export const SERVER_VERSION = '1.0.0';
export const DEFAULT_PORT = 7457;

/** Hosts the HTTP gateway may bind to. Bruce Comm is local-only by design. */
export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;

export interface BruceConfig {
  /** Data directory holding the SQLite database and runner config. */
  home: string;
  dbPath: string;
  host: string;
  port: number;
  /** Optional shared secret. When set, /mcp and /api require `Authorization: Bearer <token>`. */
  token?: string;
  runnersFile: string;
}

export function defaultHome(): string {
  return process.env.BRUCE_COMM_HOME || path.join(os.homedir(), '.bruce-comm');
}

export function loadConfig(overrides: Partial<BruceConfig> = {}): BruceConfig {
  const home = overrides.home ?? defaultHome();
  const host = overrides.host ?? process.env.BRUCE_COMM_HOST ?? '127.0.0.1';
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(host)) {
    throw new BruceError(
      'invalid_host',
      `Refusing to bind to "${host}". Bruce Comm only listens on loopback (${LOOPBACK_HOSTS.join(', ')}).`,
    );
  }
  const portRaw = overrides.port ?? Number(process.env.BRUCE_COMM_PORT || DEFAULT_PORT);
  if (!Number.isInteger(portRaw) || portRaw < 0 || portRaw > 65535) {
    throw new BruceError('invalid_port', `Invalid port: ${portRaw}`);
  }
  const config: BruceConfig = {
    home,
    dbPath: overrides.dbPath ?? process.env.BRUCE_COMM_DB ?? path.join(home, 'bruce-comm.db'),
    host,
    port: portRaw,
    token: overrides.token ?? (process.env.BRUCE_COMM_TOKEN || undefined),
    runnersFile: overrides.runnersFile ?? path.join(home, 'runners.json'),
  };
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  return config;
}
