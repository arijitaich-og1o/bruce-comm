import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_NAME, SERVER_VERSION, type BruceConfig } from './config.js';
import { BruceError } from './util.js';

/**
 * MCP client configuration: the `bruce-comm` server entry in each client's own format, ready-to-paste
 * snippets (`bruce-comm config`) and a merging installer (`bruce-comm install`).
 *
 * The installer never drops unknown keys, writes a timestamped `.bak` first and refuses to replace a
 * different existing `bruce-comm` entry without `--yes`. Tests redirect every target file with
 * BRUCE_COMM_CLIENT_CONFIG_DIR (or `configFile`).
 */

const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------- the bruce-comm server entry

/** Root of the Bruce Comm package (the folder holding package.json, bin/ and dist/). */
function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Absolute path of `bin/bruce-comm.js` (works from both src/ and dist/). */
export function bruceBinPath(): string {
  return path.join(packageRoot(), 'bin', 'bruce-comm.js');
}

let cachedPackageVersion: string | undefined;

/** The "version" of Bruce Comm's package.json (SERVER_VERSION if it cannot be read). */
export function packageVersion(): string {
  if (cachedPackageVersion) return cachedPackageVersion;
  let version: string = SERVER_VERSION;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.trim()) version = pkg.version.trim();
  } catch {
    // keep SERVER_VERSION
  }
  cachedPackageVersion = version;
  return version;
}

/** Absolute path of the node executable running Bruce Comm. */
export function nodePath(): string {
  return process.execPath;
}

/** `http://127.0.0.1:<port>/mcp`, with `?agent=<id>` when an identity is pre-bound. */
export function mcpUrl(config: Pick<BruceConfig, 'host' | 'port'>, agentId?: string, port?: number): string {
  const host = config.host === '::1' ? '[::1]' : config.host;
  const base = `http://${host}:${port ?? config.port}/mcp`;
  return agentId ? `${base}?agent=${encodeURIComponent(agentId)}` : base;
}

export type McpTransport = 'stdio' | 'http';

/** Transport-neutral description of how a client reaches Bruce Comm. */
export interface BruceServerSpec {
  transport: McpTransport;
  /** stdio: executable (absolute node path). */
  command: string;
  /** stdio: arguments (absolute bin path, "stdio", ...). */
  args: string[];
  /** stdio: environment for the server process. */
  env: Record<string, string>;
  /** http: endpoint URL. */
  url: string;
  /** http: request headers (Authorization when a token is configured). */
  headers: Record<string, string>;
  agentId?: string;
}

export interface ServerSpecOptions {
  transport: McpTransport;
  agentId?: string;
  port?: number;
  /** How the stdio identity is pre-bound: `--agent-id` argument (runner) or BRUCE_AGENT_ID env (clients). */
  bindVia?: 'arg' | 'env';
  /** Extra environment for the stdio server (e.g. BRUCE_COMM_HOME so a child uses the same database). */
  env?: Record<string, string>;
  /**
   * Marks the session as a one-shot runner child working on this task: stdio `--runner-task <id>` plus env
   * BRUCE_COMM_RUNNER_TASK, HTTP `&runner_task=<id>`. The server then leaves out the work-loop guidance.
   */
  runnerTask?: string;
}

/** Build the bruce-comm server description for a client or a headless CLI. */
export function bruceServerSpec(config: BruceConfig, options: ServerSpecOptions): BruceServerSpec {
  const args = [bruceBinPath(), 'stdio'];
  let env: Record<string, string> = { ...(options.env ?? {}) };
  if (options.agentId) {
    if (options.bindVia === 'arg') args.push('--agent-id', options.agentId);
    else env = { BRUCE_AGENT_ID: options.agentId, ...env };
  }
  let url = mcpUrl(config, options.agentId, options.port);
  if (options.runnerTask) {
    args.push('--runner-task', options.runnerTask);
    env = { ...env, BRUCE_COMM_RUNNER_TASK: options.runnerTask };
    url += `${url.includes('?') ? '&' : '?'}runner_task=${encodeURIComponent(options.runnerTask)}`;
  }
  const headers: Record<string, string> = {};
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  return {
    transport: options.transport,
    command: nodePath(),
    args,
    env,
    url,
    headers,
    agentId: options.agentId,
  };
}

/** Whether an MCP server entry (any client format) was generated for a runner child (carries the runner-task marker). */
export function isRunnerChildEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const e = entry as { args?: unknown; env?: unknown; url?: unknown; httpUrl?: unknown; serverUrl?: unknown };
  if (Array.isArray(e.args) && e.args.includes('--runner-task')) return true;
  if (e.env && typeof e.env === 'object' && 'BRUCE_COMM_RUNNER_TASK' in e.env) return true;
  return [e.url, e.httpUrl, e.serverUrl].some((u) => typeof u === 'string' && /[?&]runner_task=/.test(u));
}

/** Environment a client-spawned stdio server needs to find a non-default data directory / database. */
export function homeEnv(config: BruceConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const norm = (p: string) => (process.platform === 'linux' ? path.resolve(p) : path.resolve(p).toLowerCase());
  const same = (a: string, b: string) => norm(a) === norm(b);
  if (!same(config.home, path.join(os.homedir(), '.bruce-comm'))) env.BRUCE_COMM_HOME = config.home;
  if (!same(config.dbPath, path.join(config.home, 'bruce-comm.db'))) env.BRUCE_COMM_DB = config.dbPath;
  return env;
}

function withoutEmpty(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** Generic `mcpServers` stdio entry (command/args/env). */
export function stdioEntry(spec: BruceServerSpec, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return withoutEmpty({ ...pick(extra, ['type']), command: spec.command, args: spec.args, env: spec.env, ...omit(extra, ['type']) });
}

/** Generic Streamable HTTP entry; `urlKey` differs per client (url / httpUrl / serverUrl). */
export function httpEntry(spec: BruceServerSpec, urlKey = 'url', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return withoutEmpty({ ...pick(extra, ['type']), [urlKey]: spec.url, headers: spec.headers, ...omit(extra, ['type']) });
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k)));
}

function omit(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

/** Result of probing the HTTP daemon's /healthz endpoint. */
export interface DaemonProbe {
  ok: boolean;
  url: string;
  name?: string;
  version?: string;
  error?: string;
}

/** `http://127.0.0.1:<port>` - the daemon's base URL (dashboard at /, REST at /api, MCP at /mcp). */
export function daemonBaseUrl(config: Pick<BruceConfig, 'host' | 'port'>, port?: number): string {
  return mcpUrl(config, undefined, port).replace(/\/mcp$/, '');
}

/** Response of a daemon REST call. `body` is the parsed JSON (null when the body was not JSON). */
export interface DaemonResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * Call the running daemon's REST API (`/api/<apiPath>`) as the human, with the configured token when there is one.
 * Rejects on network errors and timeouts (e.g. no daemon on that port).
 *
 * Uses node:http without keep-alive rather than fetch: on Windows, two fetch calls over one kept-alive connection
 * followed by process.exit() abort the CLI with a libuv assertion (src\win\async.c "!(handle->flags &
 * UV_HANDLE_CLOSING)", exit code 0xC0000409) - reproduced 8/8 with fetch, 0/8 with this.
 */
export function daemonApi(
  config: Pick<BruceConfig, 'host' | 'port' | 'token'>,
  method: 'GET' | 'DELETE',
  apiPath: string,
  timeoutMs = 3000,
): Promise<DaemonResponse> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const url = `${daemonBaseUrl(config)}/api/${apiPath.replace(/^\/+/, '')}`;
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        let body: unknown = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // not JSON - body stays null
        }
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/** Check whether a Bruce Comm daemon answers on host:port (GET /healthz, no auth needed). */
export async function probeDaemon(config: Pick<BruceConfig, 'host' | 'port'>, port?: number, timeoutMs = 1500): Promise<DaemonProbe> {
  const url = `${daemonBaseUrl(config, port)}/healthz`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; name?: string; version?: string };
    if (res.ok && body.name === SERVER_NAME) return { ok: true, url, name: body.name, version: body.version };
    return { ok: false, url, error: `HTTP ${res.status} from something that is not Bruce Comm` };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return { ok: false, url, error: cause ?? (err as Error).message };
  }
}

// ---------------------------------------------------------------- TOML (Codex)

/** TOML string: a literal string ('...', no escaping - ideal for Windows paths) when possible. */
export function tomlString(value: string): string {
  if (!/['\r\n\t\u0000-\u001f\u007f]/.test(value)) return `'${value}'`;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `"${escaped}"`;
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** Any JSON-like value as TOML (inline tables for objects). */
export function tomlValue(value: unknown): string {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (value && typeof value === 'object') {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`);
    return `{${parts.join(', ')}}`;
  }
  throw new BruceError('invalid_argument', `Cannot express ${String(value)} in TOML.`);
}

/** Codex `[mcp_servers.bruce-comm]` fields for a spec. */
export function codexServerTable(spec: BruceServerSpec, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (spec.transport === 'http') {
    return withoutEmpty({
      url: spec.url,
      bearer_token_env_var: spec.headers.Authorization ? 'BRUCE_COMM_TOKEN' : undefined,
      ...extra,
    });
  }
  return withoutEmpty({ command: spec.command, args: spec.args, env: spec.env, ...extra });
}

// ---------------------------------------------------------------- client catalogue

export type ClientKind = 'json-file' | 'command' | 'ui';

export interface ClientDef {
  id: string;
  title: string;
  /** Suggested agent id pre-bound for this client. */
  agentId: string;
  kind: ClientKind;
  /** Top-level key holding the server map (json-file and ui kinds). */
  rootKey?: 'mcpServers' | 'servers';
  /** Real config file location on this machine (json-file kind). */
  configPath?: () => string;
  /** Only stdio is supported (Claude Desktop). */
  stdioOnly?: string;
  entry: (spec: BruceServerSpec) => Record<string, unknown>;
  notes: (spec: BruceServerSpec) => string[];
}

const home = () => os.homedir();
const appData = () => process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
const localAppData = () => process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local');

/** Per-user application config root (APPDATA on Windows). */
function userConfigRoot(): string {
  if (IS_WINDOWS) return appData();
  if (process.platform === 'darwin') return path.join(home(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(home(), '.config');
}

/**
 * Claude Desktop's config. MSIX installs (Windows Store package `Claude_*`) keep the REAL file under
 * %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude - the documented %APPDATA%\Claude path is a
 * virtualized view only processes inside the package see.
 */
export function claudeDesktopConfigPath(): string {
  if (IS_WINDOWS) {
    const packages = path.join(localAppData(), 'Packages');
    try {
      for (const name of fs.readdirSync(packages)) {
        if (!/^Claude_/i.test(name)) continue;
        const dir = path.join(packages, name, 'LocalCache', 'Roaming', 'Claude');
        if (fs.existsSync(dir)) return path.join(dir, 'claude_desktop_config.json');
      }
    } catch {
      // no Packages folder - not an MSIX install
    }
    return path.join(appData(), 'Claude', 'claude_desktop_config.json');
  }
  return path.join(userConfigRoot(), 'Claude', 'claude_desktop_config.json');
}

const RESTART_NOTE = 'Restart the client (or reload its MCP servers) after changing its config.';

export const CLIENTS: ClientDef[] = [
  {
    id: 'claude-desktop',
    title: 'Claude Desktop',
    agentId: 'claude-desktop',
    kind: 'json-file',
    rootKey: 'mcpServers',
    configPath: claudeDesktopConfigPath,
    stdioOnly:
      'Claude Desktop only runs local servers from stdio entries (command/args/env); its "Custom Connectors" connect from ' +
      "Anthropic's cloud and cannot reach 127.0.0.1. The stdio process shares the same database as the HTTP daemon, so nothing is lost.",
    entry: (spec) => stdioEntry(spec),
    notes: () => [
      'Fully quit Claude Desktop (tray icon > Quit) BEFORE editing the file - it rewrites the file on exit - then start it again.',
      'Keep every other key in the file (e.g. "preferences").',
      'Windows MSIX installs: edit the file under %LOCALAPPDATA%\\Packages\\Claude_*\\LocalCache\\Roaming\\Claude (shown above), not %APPDATA%\\Claude.',
      'Logs: <config folder>\\logs\\mcp-server-bruce-comm.log',
    ],
  },
  {
    id: 'vscode',
    title: 'VS Code (GitHub Copilot agent mode)',
    agentId: 'vscode-copilot',
    kind: 'json-file',
    rootKey: 'servers',
    configPath: () => path.join(userConfigRoot(), 'Code', 'User', 'mcp.json'),
    entry: (spec) => (spec.transport === 'http' ? httpEntry(spec, 'url', { type: 'http' }) : stdioEntry(spec, { type: 'stdio' })),
    notes: () => [
      'Workspace-only alternative: .vscode/mcp.json with the same "servers" block.',
      'Approve the bruce-comm tools once ("Allow all tools from this server") so the agent is not interrupted.',
      RESTART_NOTE,
    ],
  },
  {
    id: 'cursor',
    title: 'Cursor',
    agentId: 'cursor',
    kind: 'json-file',
    rootKey: 'mcpServers',
    configPath: () => path.join(home(), '.cursor', 'mcp.json'),
    entry: (spec) => (spec.transport === 'http' ? httpEntry(spec, 'url') : stdioEntry(spec)),
    notes: () => ['Project-only alternative: .cursor/mcp.json in the repository.', RESTART_NOTE],
  },
  {
    id: 'windsurf',
    title: 'Windsurf (legacy Cascade config)',
    agentId: 'windsurf',
    kind: 'json-file',
    rootKey: 'mcpServers',
    configPath: () => path.join(home(), '.codeium', 'windsurf', 'mcp_config.json'),
    entry: (spec) => (spec.transport === 'http' ? httpEntry(spec, 'serverUrl') : stdioEntry(spec)),
    notes: () => ['Windsurf is now Devin Desktop - use "devin" for its current config file.', RESTART_NOTE],
  },
  {
    id: 'devin',
    title: 'Devin Desktop (formerly Windsurf)',
    agentId: 'devin',
    kind: 'json-file',
    rootKey: 'mcpServers',
    configPath: () => path.join(userConfigRoot(), 'devin', 'mcp_config.json'),
    entry: (spec) => (spec.transport === 'http' ? httpEntry(spec, 'serverUrl') : stdioEntry(spec)),
    notes: () => [RESTART_NOTE],
  },
  {
    id: 'visual-studio',
    title: 'Visual Studio 2022 17.14+ / 2026',
    agentId: 'visual-studio',
    kind: 'json-file',
    rootKey: 'servers',
    configPath: () => path.join(home(), '.mcp.json'),
    entry: (spec) => (spec.transport === 'http' ? httpEntry(spec, 'url', { type: 'http' }) : stdioEntry(spec, { type: 'stdio' })),
    notes: () => ['Enable the bruce-comm tools in the Copilot Chat tool picker (they are off by default).', RESTART_NOTE],
  },
  {
    id: 'jetbrains',
    title: 'JetBrains AI Assistant',
    agentId: 'jetbrains',
    kind: 'ui',
    rootKey: 'mcpServers',
    entry: (spec) => (spec.transport === 'http' ? httpEntry(spec, 'url') : stdioEntry(spec)),
    notes: () => ['Paste the JSON in Settings | Tools | AI Assistant | Model Context Protocol (MCP) > Add > "As JSON".'],
  },
  {
    id: 'junie',
    title: 'JetBrains Junie',
    agentId: 'junie',
    kind: 'json-file',
    rootKey: 'mcpServers',
    configPath: () => path.join(home(), '.junie', 'mcp', 'mcp.json'),
    entry: (spec) => (spec.transport === 'http' ? httpEntry(spec, 'url') : stdioEntry(spec)),
    notes: () => ['Project-only alternative: .junie/mcp/mcp.json in the repository.', RESTART_NOTE],
  },
  {
    id: 'gemini',
    title: 'Gemini CLI',
    agentId: 'gemini-cli',
    kind: 'json-file',
    rootKey: 'mcpServers',
    configPath: () => path.join(home(), '.gemini', 'settings.json'),
    entry: (spec) =>
      spec.transport === 'http'
        ? httpEntry(spec, 'httpUrl', { trust: true, timeout: 600000 })
        : stdioEntry(spec, { trust: true, timeout: 600000 }),
    notes: () => [
      '"trust": true lets Gemini call Bruce Comm tools without a confirmation prompt (needed for headless -p runs).',
      'Headless/hidden spawns need GEMINI_CLI_NO_RELAUNCH=true.',
    ],
  },
  {
    id: 'copilot-cli',
    title: 'GitHub Copilot CLI',
    agentId: 'copilot-cli',
    kind: 'json-file',
    rootKey: 'mcpServers',
    configPath: () => path.join(process.env.COPILOT_HOME || path.join(home(), '.copilot'), 'mcp-config.json'),
    entry: (spec) =>
      spec.transport === 'http'
        ? httpEntry(spec, 'url', { type: 'http', tools: ['*'] })
        : stdioEntry(spec, { type: 'stdio', tools: ['*'] }),
    notes: () => ['This file is also read by the VS Code Agent Host.', 'Unattended: copilot -p "..." --allow-tool=bruce-comm'],
  },
  {
    id: 'claude-code',
    title: 'Claude Code',
    agentId: 'claude-code',
    kind: 'command',
    rootKey: 'mcpServers',
    entry: (spec) => (spec.transport === 'http' ? httpEntry(spec, 'url', { type: 'http' }) : stdioEntry(spec, { type: 'stdio' })),
    notes: () => [
      'Project-only alternative: put the JSON above in .mcp.json at the repository root.',
      'Allow the tools without prompts: --allowedTools "mcp__bruce-comm__*" (or /permissions).',
    ],
  },
  {
    id: 'codex',
    title: 'OpenAI Codex CLI / IDE extension',
    agentId: 'codex',
    kind: 'command',
    entry: (spec) => codexServerTable(spec, codexExtras(spec)),
    notes: (spec) => [
      `Add the TOML to ${path.join(process.env.CODEX_HOME || path.join(home(), '.codex'), 'config.toml')} (or run the command).`,
      ...(spec.headers.Authorization ? ['Set BRUCE_COMM_TOKEN in the environment Codex runs in.'] : []),
    ],
  },
];

function codexExtras(spec: BruceServerSpec): Record<string, unknown> {
  return spec.transport === 'http'
    ? { tool_timeout_sec: 120, default_tools_approval_mode: 'approve' }
    : { startup_timeout_sec: 20, tool_timeout_sec: 120, default_tools_approval_mode: 'approve' };
}

export const CLIENT_IDS = CLIENTS.map((c) => c.id);

const CLIENT_ALIASES: Record<string, string> = {
  claude: 'claude-desktop',
  'vs-code': 'vscode',
  code: 'vscode',
  copilot: 'copilot-cli',
  'gemini-cli': 'gemini',
  vs: 'visual-studio',
  visualstudio: 'visual-studio',
  intellij: 'jetbrains',
};

/** Look up a client by id or alias; throws with the list of valid ids. */
export function getClient(raw: string): ClientDef {
  const key = raw.trim().toLowerCase();
  const id = CLIENT_ALIASES[key] ?? key;
  const client = CLIENTS.find((c) => c.id === id);
  if (!client) {
    throw new BruceError('unknown_client', `Unknown client "${raw}".`, `Known clients: ${CLIENT_IDS.join(', ')}.`);
  }
  return client;
}

// ---------------------------------------------------------------- snippets

export interface SnippetOptions {
  transport?: McpTransport;
  agentId?: string;
  port?: number;
}

export interface ClientSnippet {
  client: string;
  title: string;
  transport: McpTransport;
  agent_id: string;
  /** Config file to edit (json-file clients). */
  file?: string;
  rootKey?: string;
  /** The `bruce-comm` entry alone. */
  entry: Record<string, unknown>;
  /** Ready-to-paste text (JSON block, TOML or commands). */
  text: string;
  /** Shell commands that configure the client (command clients). */
  commands: string[];
  notes: string[];
}

/** Build the configuration snippet for one client. */
export function clientSnippet(config: BruceConfig, client: ClientDef, options: SnippetOptions = {}): ClientSnippet {
  const notes: string[] = [];
  let transport: McpTransport = options.transport ?? 'stdio';
  if (client.stdioOnly && transport === 'http') {
    notes.push(`Using stdio: ${client.stdioOnly}`);
    transport = 'stdio';
  }
  const agentId = options.agentId ?? client.agentId;
  const spec = bruceServerSpec(config, { transport, agentId, port: options.port, bindVia: 'env', env: homeEnv(config) });
  const entry = client.entry(spec);
  const commands = clientCommands(client, spec);
  let text: string;
  if (client.id === 'codex') {
    text = codexToml(entry);
  } else {
    text = JSON.stringify({ [client.rootKey!]: { [SERVER_NAME]: entry } }, null, 2);
  }
  if (transport === 'http') {
    notes.push(`HTTP needs the daemon running: bruce-comm serve${options.port ? ` --port ${options.port}` : ''}.`);
  }
  notes.push(...client.notes(spec));
  return {
    client: client.id,
    title: client.title,
    transport,
    agent_id: agentId,
    file: client.kind === 'json-file' ? client.configPath!() : undefined,
    rootKey: client.rootKey,
    entry,
    text,
    commands,
    notes,
  };
}

/** `[mcp_servers.bruce-comm]` TOML block (env as a sub-table). */
export function codexToml(table: Record<string, unknown>): string {
  const lines = [`[mcp_servers.${SERVER_NAME}]`];
  const env = table.env as Record<string, string> | undefined;
  for (const [key, value] of Object.entries(table)) {
    if (key === 'env') continue;
    lines.push(`${key} = ${tomlValue(value)}`);
  }
  if (env && Object.keys(env).length) {
    lines.push('', `[mcp_servers.${SERVER_NAME}.env]`);
    for (const [key, value] of Object.entries(env)) lines.push(`${key} = ${tomlString(value)}`);
  }
  return lines.join('\n');
}

/** Quote one argument for display in cmd.exe / PowerShell / POSIX shells (display only - never executed). */
export function displayArg(arg: string): string {
  if (/^[A-Za-z0-9_\-.,:/\\=@+]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Ready-to-run setup commands. Positionals (server name, URL) always come BEFORE repeatable options: in Claude Code
 * `--env <env...>` and `--header <header...>` are variadic and would swallow a name or URL that follows them.
 */
function clientCommands(client: ClientDef, spec: BruceServerSpec): string[] {
  const q = (args: string[]) => args.map(displayArg).join(' ');
  const headers = (flag: string) => Object.entries(spec.headers).flatMap(([k, v]) => [flag, `${k}: ${v}`]);
  if (client.id === 'claude-code') {
    if (spec.transport === 'http') {
      return [q(['claude', 'mcp', 'add', SERVER_NAME, spec.url, '--transport', 'http', '--scope', 'user', ...headers('--header')])];
    }
    const env = Object.entries(spec.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
    return [q(['claude', 'mcp', 'add', SERVER_NAME, '--transport', 'stdio', '--scope', 'user', ...env, '--', spec.command, ...spec.args])];
  }
  if (client.id === 'codex') {
    if (spec.transport === 'http') {
      const token = spec.headers.Authorization ? ['--bearer-token-env-var', 'BRUCE_COMM_TOKEN'] : [];
      return [q(['codex', 'mcp', 'add', SERVER_NAME, '--url', spec.url, ...token])];
    }
    const env = Object.entries(spec.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
    return [q(['codex', 'mcp', 'add', SERVER_NAME, ...env, '--', spec.command, ...spec.args])];
  }
  if (client.id === 'gemini' && spec.transport === 'http') {
    return [q(['gemini', 'mcp', 'add', '--scope', 'user', '--transport', 'http', '--trust', SERVER_NAME, spec.url, ...headers('-H')])];
  }
  return [];
}

// ---------------------------------------------------------------- installer

export interface InstallOptions extends SnippetOptions {
  /** Replace an existing, different bruce-comm entry (and accept losing JSONC comments). */
  yes?: boolean;
  dryRun?: boolean;
  /** Explicit target file (overrides the client's default location). */
  configFile?: string;
  /** Clock for the backup file name (tests). */
  now?: Date;
}

export interface InstallResult {
  client: string;
  /** What happened: written, unchanged, dry-run or printed (command/ui clients). */
  action: 'written' | 'unchanged' | 'dry-run' | 'printed';
  file?: string;
  backup?: string;
  /** Resulting full file content (json-file clients) or the snippet text. */
  content: string;
  snippet: ClientSnippet;
  warnings: string[];
}

/** Where the installer writes for a client: --config-file, else BRUCE_COMM_CLIENT_CONFIG_DIR/<client>/<name>, else the real path. */
export function installTarget(client: ClientDef, configFile?: string): string {
  if (configFile) return path.resolve(configFile);
  const real = client.configPath!();
  const override = process.env.BRUCE_COMM_CLIENT_CONFIG_DIR;
  return override ? path.join(path.resolve(override), client.id, path.basename(real)) : real;
}

/** Merge the bruce-comm entry into a client's config file (or describe the command for command/ui clients). */
export function installClient(config: BruceConfig, clientRaw: string, options: InstallOptions = {}): InstallResult {
  const client = getClient(clientRaw);
  const snippet = clientSnippet(config, client, options);
  const warnings: string[] = [];
  if (client.kind !== 'json-file') {
    return { client: client.id, action: 'printed', content: snippet.text, snippet, warnings };
  }
  const file = installTarget(client, options.configFile);
  snippet.file = file;
  const { data, existed, jsonc } = readJsonConfig(file);
  if (jsonc) {
    if (!options.yes) {
      throw new BruceError(
        'jsonc_config',
        `${file} contains comments or trailing commas, which would be lost when the installer rewrites it.`,
        'Re-run with --yes to rewrite it (a .bak copy is kept), or paste the snippet from "bruce-comm config" by hand.',
      );
    }
    warnings.push('Comments / trailing commas in the original file were dropped (see the .bak copy).');
  }
  const rootKey = client.rootKey!;
  const servers = data[rootKey];
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    throw new BruceError('invalid_config', `"${rootKey}" in ${file} is not an object; fix the file first.`);
  }
  const map = { ...((servers as Record<string, unknown> | undefined) ?? {}) };
  const current = map[SERVER_NAME];
  if (current !== undefined && deepEqual(current, snippet.entry)) {
    return { client: client.id, action: 'unchanged', file, content: JSON.stringify(data, null, 2), snippet, warnings };
  }
  if (current !== undefined && !options.yes) {
    throw new BruceError(
      'entry_exists',
      `${file} already has a different "${SERVER_NAME}" entry:\n${JSON.stringify(current, null, 2)}`,
      'Re-run with --yes to replace it (a .bak copy is kept), or --dry-run to preview.',
    );
  }
  map[SERVER_NAME] = snippet.entry;
  const next: Record<string, unknown> = { ...data, [rootKey]: map };
  const content = `${JSON.stringify(next, null, 2)}\n`;
  if (options.dryRun) return { client: client.id, action: 'dry-run', file, content, snippet, warnings };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup: string | undefined;
  if (existed) {
    backup = `${file}.${timestamp(options.now ?? new Date())}.bak`;
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
  return { client: client.id, action: 'written', file, backup, content, snippet, warnings };
}

/** Read a JSON config file. Missing / empty (0-byte) files are an empty object; JSONC is detected. */
export function readJsonConfig(file: string): { data: Record<string, unknown>; existed: boolean; jsonc: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { data: {}, existed: false, jsonc: false };
    throw new BruceError('read_failed', `Cannot read ${file}: ${(err as Error).message}`);
  }
  const body = text.replace(/^﻿/, '');
  if (!body.trim()) return { data: {}, existed: true, jsonc: false };
  let parsed: unknown;
  let jsonc = false;
  try {
    parsed = JSON.parse(body);
  } catch {
    try {
      parsed = JSON.parse(stripJsonc(body));
      jsonc = true;
    } catch (err) {
      throw new BruceError('invalid_config', `${file} is not valid JSON: ${(err as Error).message}`, 'Fix or move the file, then retry.');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BruceError('invalid_config', `${file} must contain a JSON object.`);
  }
  return { data: parsed as Record<string, unknown>, existed: true, jsonc };
}

/** Remove // and /* *\/ comments and trailing commas outside strings (VS Code style JSONC). */
export function stripJsonc(text: string): string {
  return scanJson(scanJson(text, 'comments'), 'commas');
}

function scanJson(text: string, mode: 'comments' | 'commas'): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (mode === 'comments' && c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (mode === 'comments' && c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (mode === 'commas' && c === ',' && /^\s*[}\]]/.test(text.slice(i + 1, i + 200))) {
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
