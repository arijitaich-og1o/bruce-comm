import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BruceConfig } from '../config.js';
import { normalizeAgentId } from '../store/store.js';
import { AGENT_STATUSES, type AgentInput } from '../store/types.js';
import { BruceError } from '../util.js';

/** Built-in launch recipes for headless agent CLIs. */
export const PRESET_IDS = ['claude-code', 'copilot-cli', 'gemini-cli', 'codex', 'cursor-agent', 'vscode-chat', 'custom'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export type ResultFrom = 'stdout' | 'mcp';

/** Placeholders usable in args, extraArgs and env values. */
export const PLACEHOLDERS = [
  'promptFile',
  'taskId',
  'agentId',
  'mcpConfigFile',
  'mcpUrl',
  'cwd',
  'runDir',
  'outputFile',
  'nodePath',
  'bruceBin',
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

const skillSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
});

const agentSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  platform: z.string().optional(),
  instructions: z.string().optional(),
  skills: z.array(skillSchema).optional(),
  tags: z.array(z.string()).optional(),
  accept_from: z.array(z.string()).min(1).optional(),
  max_concurrent_tasks: z.number().int().min(1).max(50).optional(),
  require_approval: z.boolean().optional(),
  owner: z.string().nullable().optional(),
  workspace: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(AGENT_STATUSES as unknown as [string, ...string[]]).optional(),
  status_message: z.string().nullable().optional(),
});

const runnerSchema = z.strictObject({
  enabled: z.boolean().default(true),
  agent: agentSchema,
  preset: z.enum(PRESET_IDS),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  extraArgs: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutSeconds: z.number().int().min(1).max(7 * 24 * 3600).default(1800),
  concurrency: z.number().int().min(1).max(20).default(1),
  resultFrom: z.enum(['stdout', 'mcp']).optional(),
  mcpTransport: z.enum(['stdio', 'http']).default('stdio'),
  retryOnFailure: z.boolean().default(false),
  keepRunFiles: z.boolean().default(false),
  /**
   * Fallback ("headless twin") mode: only claim tasks that have waited unclaimed at least this many seconds, never
   * take messages, never mark the agent listening/offline, and stand back while an interactive session of the agent
   * is listening. Lets an interactive agent go first and guarantees idle agents still react.
   */
  fallbackAfterSeconds: z.number().int().min(0).max(24 * 3600).optional(),
  /** Do not overwrite an existing agent profile on start (use it as registered by the interactive agent). */
  keepAgentProfile: z.boolean().default(false),
});

const fileSchema = z.strictObject({
  runners: z.array(runnerSchema),
});

/** One entry of runners.json after validation and defaults. */
export type RunnerConfig = z.infer<typeof runnerSchema>;
type AgentConfig = z.infer<typeof agentSchema>;

export interface RunnerFile {
  file: string;
  runners: RunnerConfig[];
}

/**
 * Read and validate a runners.json file. Keys starting with "_" (e.g. "_comment") are ignored at every
 * level. Throws a BruceError listing every problem with its JSON path.
 */
export function loadRunnerConfig(file: string): RunnerFile {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new BruceError('no_runner_config', `Runner config not found: ${file}`, 'Create an example with: bruce-comm runner init');
    }
    throw new BruceError('read_failed', `Cannot read ${file}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new BruceError('invalid_runner_config', `${file} is not valid JSON: ${(err as Error).message}`);
  }
  return { file, runners: parseRunnerConfig(raw, file) };
}

/** Validate an already-parsed runners.json document. */
export function parseRunnerConfig(raw: unknown, source = 'runners.json'): RunnerConfig[] {
  const parsed = fileSchema.safeParse(stripComments(raw));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  - ${issuePath(issue.path)}: ${issue.message}`);
    throw new BruceError(
      'invalid_runner_config',
      `Invalid runner config ${source}:\n${problems.join('\n')}`,
      'See "bruce-comm runner init --force" for a commented example (written to a new file if you pass --config).',
    );
  }
  const runners = parsed.data.runners;
  const seen = new Set<string>();
  const problems: string[] = [];
  runners.forEach((runner, index) => {
    const where = `runners[${index}]`;
    try {
      runner.agent.id = normalizeAgentId(runner.agent.id);
      if (seen.has(runner.agent.id)) problems.push(`  - ${where}.agent.id: "${runner.agent.id}" is used by more than one runner.`);
      seen.add(runner.agent.id);
    } catch (err) {
      problems.push(`  - ${where}.agent.id: ${(err as Error).message}`);
    }
    if (runner.preset === 'custom' && !runner.command) problems.push(`  - ${where}.command: required for preset "custom".`);
    if (runner.preset === 'custom' && !runner.args) problems.push(`  - ${where}.args: required for preset "custom" (use [] for none).`);
  });
  if (problems.length) {
    throw new BruceError('invalid_runner_config', `Invalid runner config ${source}:\n${problems.join('\n')}`);
  }
  return runners;
}

function issuePath(segments: readonly PropertyKey[]): string {
  return segments.reduce<string>((out, seg) => (typeof seg === 'number' ? `${out}[${seg}]` : out ? `${out}.${String(seg)}` : String(seg)), '') || '(root)';
}

/** Drop "_comment"-style keys recursively (documentation fields in the example file). */
function stripComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !key.startsWith('_'))
        .map(([key, v]) => [key, key === 'metadata' || key === 'env' ? v : stripComments(v)]),
    );
  }
  return value;
}

/** The working directory a runner's CLI is started in (default: <home>/work/<agent-id>). */
export function runnerCwd(config: BruceConfig, runner: RunnerConfig): { cwd: string; isDefault: boolean } {
  if (runner.cwd) return { cwd: path.resolve(runner.cwd), isDefault: false };
  return { cwd: path.join(config.home, 'work', runner.agent.id), isDefault: true };
}

/** Agent profile registered for a runner (defaults filled in from the preset). */
export function runnerAgentInput(
  runner: RunnerConfig,
  defaults: { platform: string; instructions: string; resultFrom: ResultFrom },
  host: string,
): AgentInput {
  const agent: AgentConfig = runner.agent;
  const metadata = { ...(agent.metadata ?? {}), runner: { preset: runner.preset, host, result_from: defaults.resultFrom } };
  const input: AgentInput = {
    ...agent,
    id: agent.id,
    platform: agent.platform ?? defaults.platform,
    instructions: agent.instructions ?? defaults.instructions,
    max_concurrent_tasks: agent.max_concurrent_tasks ?? runner.concurrency,
    metadata,
    status: (agent.status as AgentInput['status']) ?? 'online',
  };
  return input;
}

/** Placeholder tokens in a string that are not known placeholders (likely typos). */
export function unknownPlaceholders(values: string[]): string[] {
  const known = new Set<string>(PLACEHOLDERS);
  const out = new Set<string>();
  for (const value of values) {
    for (const m of value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) {
      if (!known.has(m[1]!)) out.add(`{${m[1]}}`);
    }
  }
  return [...out];
}

/** Replace `{placeholder}` tokens. Unknown tokens are left untouched. */
export function substitute(value: string, values: Partial<Record<Placeholder, string>>): string {
  return value.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (whole, key: string) => {
    const v = values[key as Placeholder];
    return v === undefined ? whole : v;
  });
}
