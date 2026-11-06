import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SERVER_NAME } from '../config.js';
import { codexServerTable, httpEntry, readJsonConfig, stdioEntry, tomlValue, type BruceServerSpec } from '../clients.js';
import type { PresetId, ResultFrom } from './config.js';
import type { ProcessOutcome } from './spawn.js';

/** Everything a preset needs to build one invocation. All values are runner-controlled (no task text). */
export interface InvocationContext {
  agentId: string;
  taskId: string;
  resultFrom: ResultFrom;
  /** How the CLI reaches Bruce Comm for this run: identity pre-bound, marked as a runner child of `taskId`. */
  spec: BruceServerSpec;
  cwd: string;
  runDir: string;
  promptFile: string;
  mcpConfigFile: string;
  outputFile: string;
}

/** A config file the runner writes for one run. `workspace` files live in the cwd and are restored afterwards. */
export interface RunFile {
  path: string;
  /** JSON object to write (merged into an existing workspace file under `mergeKey`). */
  json: Record<string, unknown>;
  workspace?: { mergeKey: string };
}

/** The interpreted outcome of a stdout-mode run. */
export interface ParsedResult {
  ok: boolean;
  /** Result text (ok) or the most useful error text (not ok). */
  text: string;
  /** True when the output was structured (JSON) and explicitly reported success. */
  structured?: boolean;
}

export interface PresetDef {
  id: PresetId;
  title: string;
  /** Command names to try, in order (first that resolves wins). */
  commands: string[];
  platform: string;
  resultFrom: ResultFrom;
  /** stdin: the prompt is piped to the CLI. file: the CLI is told (fixed text) to read {promptFile}. */
  promptVia: 'stdin' | 'file';
  /** Fire-and-forget launcher: the process returns at once and the agent reports via MCP later. */
  detached?: boolean;
  /** Accept a structured success even with a non-zero exit code (CLIs that crash while exiting). */
  trustStructuredResult?: boolean;
  /** Startup can be slow: warn when timeoutSeconds is below this. */
  minTimeoutSeconds?: number;
  /**
   * The CLI talks to Bruce Comm through the user's own client config (not the runner's per-run config), so its session
   * belongs to that client's agent id and is not a runner child: the prompt has it name the runner agent per call.
   */
  borrowedSession?: boolean;
  experimental?: string;
  /** Default argv (no task text!). */
  args(ctx: InvocationContext): string[];
  env?(ctx: InvocationContext): Record<string, string>;
  /** The {mcpConfigFile} content in this CLI's format. */
  mcpConfig(spec: BruceServerSpec): Record<string, unknown>;
  /** Extra files (e.g. Cursor's workspace .cursor/mcp.json). */
  files?(ctx: InvocationContext): RunFile[];
  /**
   * The `workspace` files of files(), relative to the cwd (for runner check). Such a file holds one run's task marker
   * at a time, so runs of this preset that share a cwd take turns (see lockWorkspace).
   */
  workspaceFiles?: string[];
  /** Interpret the output (stdout mode). */
  parse(outcome: ProcessOutcome, ctx: InvocationContext): ParsedResult;
}

/** Fixed instruction text given in argv. Never contains task text. */
export function fixedInstruction(resultFrom: ResultFrom, source: 'stdin' | 'attached file' | string): string {
  const where = source === 'stdin' ? 'provided on stdin' : source === 'attached file' ? 'in the attached file' : `in the file ${source}`;
  const head = `Perform the Bruce Comm task ${where}; it names your agent id and the task id.`;
  return resultFrom === 'mcp'
    ? `${head} When finished, call the bruce-comm complete_task tool with that agent_id and task_id (fail_task if you cannot do it).`
    : `${head} Use the bruce-comm MCP tools only to report progress, ask the sender a question or contact other agents. Reply with the final result only.`;
}

/** `{mcpServers: {"bruce-comm": entry}}`. */
function servers(entry: Record<string, unknown>): Record<string, unknown> {
  return { mcpServers: { [SERVER_NAME]: entry } };
}

/** Claude-style entry with an explicit type (also the generic {mcpConfigFile} format). */
function typedEntry(spec: BruceServerSpec, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return spec.transport === 'http' ? httpEntry(spec, 'url', { type: 'http', ...extra }) : stdioEntry(spec, { type: 'stdio', ...extra });
}

const plainStdout = (outcome: ProcessOutcome): ParsedResult => ({ ok: true, text: outcome.stdout.trim() });

/** Find the JSON object a CLI printed (whole stdout, else the last line / last {...} span that parses). */
export function extractJson(stdout: string): Record<string, unknown> | null {
  const attempt = (text: string) => {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const whole = attempt(trimmed);
  if (whole) return whole;
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith('{')) {
      const value = attempt(line);
      if (value) return value;
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? attempt(trimmed.slice(start, end + 1)) : null;
}

function errorText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'message' in value) return String((value as { message: unknown }).message);
  return JSON.stringify(value);
}

/** Claude Code / Cursor JSON: {type:"result", subtype, is_error, result}. */
function parseResultJson(outcome: ProcessOutcome): ParsedResult {
  const json = extractJson(outcome.stdout);
  if (!json) return { ok: false, text: 'Could not find the JSON result object in the CLI output.' };
  const text = typeof json.result === 'string' ? json.result : '';
  const subtype = typeof json.subtype === 'string' ? json.subtype : undefined;
  if (json.is_error === true || (subtype && subtype !== 'success')) {
    return { ok: false, text: text || `CLI reported ${subtype ?? 'an error'}.` };
  }
  return { ok: true, text, structured: true };
}

const claudeCode: PresetDef = {
  id: 'claude-code',
  title: 'Claude Code (claude -p)',
  // PATH first, then the native installer's location (often not on PATH).
  commands: ['claude', path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')],
  platform: 'claude-code',
  resultFrom: 'stdout',
  promptVia: 'stdin',
  args: (ctx) => [
    '-p',
    fixedInstruction(ctx.resultFrom, 'stdin'),
    '--mcp-config',
    ctx.mcpConfigFile,
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    `mcp__${SERVER_NAME}__*`,
    '--output-format',
    'json',
    '--max-turns',
    '40',
  ],
  mcpConfig: (spec) => servers(typedEntry(spec)),
  parse: parseResultJson,
};

const copilotCli: PresetDef = {
  id: 'copilot-cli',
  title: 'GitHub Copilot CLI (copilot, prompt on stdin)',
  commands: ['copilot'],
  platform: 'copilot-cli',
  resultFrom: 'stdout',
  promptVia: 'stdin',
  args: (ctx) => ['-s', '--no-ask-user', `--additional-mcp-config=@${ctx.mcpConfigFile}`, `--allow-tool=${SERVER_NAME}`],
  env: () => ({ COPILOT_AUTO_UPDATE: 'false' }),
  mcpConfig: (spec) => servers(typedEntry(spec, { tools: ['*'] })),
  parse: plainStdout,
};

const geminiCli: PresetDef = {
  id: 'gemini-cli',
  title: 'Gemini CLI (gemini --prompt=..., task on stdin)',
  commands: ['gemini'],
  platform: 'gemini-cli',
  resultFrom: 'stdout',
  promptVia: 'stdin',
  trustStructuredResult: true,
  minTimeoutSeconds: 120,
  args: (ctx) => [
    `--prompt=${fixedInstruction(ctx.resultFrom, 'stdin')}`,
    '--output-format',
    'json',
    '--allowed-mcp-server-names',
    SERVER_NAME,
  ],
  // Gemini has no CLI flag for MCP servers. The runner-owned settings file replaces the SYSTEM settings file, the
  // highest precedence: a "bruce-comm" entry in the user's or the workspace's settings (bruce-comm install gemini-cli)
  // must not replace the runner's identity-bound one. The machine's own system settings are copied into it (see
  // mcpConfig) and its system defaults file stays in effect.
  env: (ctx) => ({
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: ctx.mcpConfigFile,
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: geminiSystemFiles().defaults,
    GEMINI_CLI_NO_RELAUNCH: 'true',
  }),
  mcpConfig: (spec) => {
    const entry = spec.transport === 'http' ? httpEntry(spec, 'httpUrl', { trust: true }) : stdioEntry(spec, { trust: true });
    const system = readGeminiSystemSettings();
    const map = system.mcpServers && typeof system.mcpServers === 'object' && !Array.isArray(system.mcpServers) ? system.mcpServers : {};
    return { ...system, mcpServers: { ...map, [SERVER_NAME]: entry } };
  },
  parse: (outcome) => {
    const json = extractJson(outcome.stdout);
    if (!json) return { ok: false, text: 'Could not find the JSON result object in the Gemini output.' };
    const error = errorText(json.error);
    if (error) return { ok: false, text: error };
    if (typeof json.response !== 'string') return { ok: false, text: 'Gemini returned no "response".' };
    return { ok: true, text: json.response, structured: true };
  },
};

/** Gemini CLI's own system settings and system defaults files (the env overrides Gemini itself honours, else its defaults). */
export function geminiSystemFiles(): { settings: string; defaults: string } {
  const settings =
    process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ||
    (process.platform === 'win32'
      ? 'C:\\ProgramData\\gemini-cli\\settings.json'
      : process.platform === 'darwin'
        ? '/Library/Application Support/GeminiCli/settings.json'
        : '/etc/gemini-cli/settings.json');
  return { settings, defaults: process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH || path.join(path.dirname(settings), 'system-defaults.json') };
}

/** The machine's Gemini system settings (admin policy), kept when the runner's file takes their place. {} if none. */
function readGeminiSystemSettings(): Record<string, unknown> {
  try {
    return readJsonConfig(geminiSystemFiles().settings).data;
  } catch {
    return {};
  }
}

const codex: PresetDef = {
  id: 'codex',
  title: 'OpenAI Codex CLI (codex exec -)',
  commands: ['codex'],
  platform: 'codex',
  resultFrom: 'stdout',
  promptVia: 'stdin',
  args: (ctx) => [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color',
    'never',
    '--sandbox',
    'read-only',
    '-c',
    'approval_policy="never"',
    '-c',
    `mcp_servers.${SERVER_NAME}=${tomlValue(codexServerTable(ctx.spec, { default_tools_approval_mode: 'approve' }))}`,
    '-o',
    ctx.outputFile,
    '-',
  ],
  env: (ctx): Record<string, string> => {
    const auth = ctx.spec.headers.Authorization;
    return auth ? { BRUCE_COMM_TOKEN: auth.replace(/^Bearer /, '') } : {};
  },
  mcpConfig: (spec) => servers(typedEntry(spec)),
  parse: (outcome, ctx) => {
    let text = '';
    try {
      text = fs.readFileSync(ctx.outputFile, 'utf8').trim();
    } catch {
      // no last-message file - fall back to stdout
    }
    return { ok: true, text: text || outcome.stdout.trim() };
  },
};

/** Cursor's workspace MCP config file, relative to the cwd. */
const CURSOR_MCP_FILE = path.join('.cursor', 'mcp.json');

const cursorAgent: PresetDef = {
  id: 'cursor-agent',
  title: 'Cursor CLI (cursor-agent -p) - experimental',
  commands: ['cursor-agent', 'agent'],
  platform: 'cursor',
  resultFrom: 'stdout',
  promptVia: 'file',
  experimental: 'Cursor CLI headless mode is untested on Windows; the prompt is passed as a file path because it cannot be piped.',
  args: (ctx) => [
    '-p',
    '--output-format',
    'json',
    '--approve-mcps',
    '--trust',
    '--workspace',
    ctx.cwd,
    '--',
    fixedInstruction(ctx.resultFrom, ctx.promptFile),
  ],
  mcpConfig: (spec) => servers(spec.transport === 'http' ? httpEntry(spec, 'url') : stdioEntry(spec)),
  workspaceFiles: [CURSOR_MCP_FILE],
  files: (ctx) => [
    {
      path: path.join(ctx.cwd, CURSOR_MCP_FILE),
      json: { [SERVER_NAME]: ctx.spec.transport === 'http' ? httpEntry(ctx.spec, 'url') : stdioEntry(ctx.spec) },
      workspace: { mergeKey: 'mcpServers' },
    },
  ],
  parse: parseResultJson,
};

const vscodeChat: PresetDef = {
  id: 'vscode-chat',
  title: 'VS Code chat (code chat -m agent, fire-and-forget)',
  commands: ['code'],
  platform: 'vscode-copilot',
  resultFrom: 'mcp',
  promptVia: 'stdin',
  detached: true,
  borrowedSession: true,
  experimental:
    'VS Code chat returns immediately and only finishes the task if the Copilot agent calls complete_task. bruce-comm must be in ' +
    'your VS Code MCP config (bruce-comm install vscode) and its tools approved once.',
  args: () => [
    'chat',
    '-m',
    'agent',
    '-r',
    'Bruce Comm task: do the task described in the attached file, passing the agent_id it names on every bruce-comm tool call, then call ' +
      'complete_task with that agent_id and task_id (fail_task if you cannot do it).',
    '-',
  ],
  mcpConfig: (spec) => servers(typedEntry(spec)),
  parse: plainStdout,
};

const custom: PresetDef = {
  id: 'custom',
  title: 'Custom command',
  commands: [],
  platform: 'custom',
  resultFrom: 'stdout',
  promptVia: 'stdin',
  args: () => [],
  mcpConfig: (spec) => servers(typedEntry(spec)),
  parse: plainStdout,
};

export const PRESETS: Record<PresetId, PresetDef> = {
  'claude-code': claudeCode,
  'copilot-cli': copilotCli,
  'gemini-cli': geminiCli,
  codex,
  'cursor-agent': cursorAgent,
  'vscode-chat': vscodeChat,
  custom,
};
