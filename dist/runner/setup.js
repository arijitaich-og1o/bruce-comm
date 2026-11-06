import fs from 'node:fs';
import path from 'node:path';
import { getClient, installTarget, probeDaemon, readJsonConfig } from '../clients.js';
import { SERVER_NAME } from '../config.js';
import { BruceError } from '../util.js';
import { loadRunnerConfig, PRESET_IDS, runnerCwd, unknownPlaceholders } from './config.js';
import { PRESETS } from './presets.js';
import { tryResolveCommand } from './spawn.js';
import { workspaceKey } from './workspace.js';
/** Which command a preset would use on this machine (first candidate that resolves). */
export function detectPresetCommand(preset, override) {
    const names = override ? [override] : PRESETS[preset].commands;
    let firstError;
    for (const name of names) {
        const { resolved, error } = tryResolveCommand(name);
        if (resolved)
            return { name, via: resolved.via };
        firstError ??= error;
    }
    return { error: firstError ?? 'no command configured' };
}
// ---------------------------------------------------------------- runner init
/**
 * Write a commented example runners.json: one DISABLED entry per preset with a sensible agent
 * profile. Presets whose CLI resolves on this machine are marked in their "_comment".
 * Refuses to overwrite an existing file unless `force` (then the old file is kept as .bak).
 */
export function writeExampleRunnerConfig(file, options = {}) {
    let backup;
    if (fs.existsSync(file)) {
        if (!options.force) {
            throw new BruceError('exists', `${file} already exists.`, 'Edit it, or run "bruce-comm runner init --force" to replace it (the old file is kept as .bak).');
        }
        backup = `${file}.bak`;
        fs.copyFileSync(file, backup);
    }
    const detected = {};
    for (const id of PRESET_IDS) {
        if (id === 'custom')
            continue;
        const found = detectPresetCommand(id);
        detected[id] = found.via ?? null;
    }
    const doc = exampleDocument(detected);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    return { file, backup, detected };
}
function detectedNote(via, install) {
    return via ? `DETECTED on this machine: ${via}.` : `NOT FOUND on this machine - ${install}`;
}
function exampleDocument(detected) {
    return {
        _comment: [
            'Bruce Comm runner config. Every entry launches a headless agent CLI for each task sent to its agent.',
            'Set "enabled": true on the entries you want, then run: bruce-comm runner check   and   bruce-comm runner',
            'Fields: enabled, agent (profile registered in Bruce Comm: id, name, platform, description, instructions, skills, tags,',
            '  accept_from, max_concurrent_tasks), preset, command (name on PATH or absolute path; overrides the preset),',
            '  args (replaces the preset arguments), extraArgs (appended), cwd (default <home>/work/<agent-id>), env,',
            '  timeoutSeconds (default 1800), concurrency (default 1), resultFrom ("stdout" | "mcp"), mcpTransport ("stdio" | "http"),',
            '  retryOnFailure (default false), keepRunFiles (default false: run files in <home>/runs are deleted).',
            'Placeholders in args / extraArgs / env values: {promptFile} {taskId} {agentId} {mcpConfigFile} {mcpUrl} {cwd} {runDir}',
            '  {outputFile} {nodePath} {bruceBin}.',
            'Security: task text from other agents is NEVER put on the command line - it is piped on stdin (or written to {promptFile}).',
            'Agents run with only the Bruce Comm tools plus read access by default; widen permissions per entry with extraArgs.',
            'Keys starting with "_" are comments and are ignored.',
        ],
        runners: [
            {
                _comment: [
                    'Claude Code: claude -p with an MCP config containing only bruce-comm, --permission-mode dontAsk and',
                    '--allowedTools mcp__bruce-comm__*. Result = the "result" field of --output-format json.',
                    'Give it more tools with e.g. "extraArgs": ["--allowedTools", "Read,Grep,Glob"]; point "cwd" at a repository.',
                    detectedNote(detected['claude-code'], 'install Claude Code (native installer: %USERPROFILE%\\.local\\bin\\claude.exe) or set "command" to a claude.exe. ' +
                        'Claude Desktop bundles one under %LOCALAPPDATA%\\Packages\\Claude_*\\LocalCache\\Roaming\\Claude\\claude-code\\<version>\\ (the path changes on every update).'),
                ],
                enabled: false,
                agent: {
                    id: 'claude-code-worker',
                    name: 'Claude Code (headless)',
                    description: 'Headless Claude Code worker for code reading, reviews, explanations and refactoring plans.',
                    instructions: 'Send ONE self-contained coding or analysis task per send_task: the goal, the repository path or the code itself, ' +
                        'constraints, and the exact output you want (e.g. "a unified diff", "a list of risks with file:line"). I run ' +
                        'unattended and cannot see your conversation; I may ask one question with request_input. My final answer becomes ' +
                        'the task result. Up to ~30 minutes per task.',
                    skills: [
                        { id: 'code', name: 'Coding', description: 'Write, explain or refactor code; produce diffs.' },
                        { id: 'code-review', name: 'Code review', description: 'Review code or a diff for bugs, security and style.' },
                    ],
                    tags: ['headless', 'claude'],
                },
                preset: 'claude-code',
                timeoutSeconds: 1800,
                concurrency: 1,
            },
            {
                _comment: [
                    'GitHub Copilot CLI: prompt piped on stdin, -s --no-ask-user, bruce-comm added with --additional-mcp-config and',
                    'allowed with --allow-tool=bruce-comm. Result = stdout. Needs a logged-in Copilot CLI (or COPILOT_GITHUB_TOKEN in "env").',
                    detectedNote(detected['copilot-cli'], 'install with: npm install -g @github/copilot'),
                ],
                enabled: false,
                agent: {
                    id: 'copilot-cli-worker',
                    name: 'GitHub Copilot CLI (headless)',
                    description: 'Headless GitHub Copilot CLI worker for coding questions and GitHub-related tasks.',
                    instructions: 'Send one self-contained task: what to do, the repository or code involved, and the output format. I run unattended; ' +
                        'my final answer becomes the task result.',
                    skills: [
                        { id: 'code', name: 'Coding' },
                        { id: 'github', name: 'GitHub', description: 'Issues, pull requests, Actions questions.' },
                    ],
                    tags: ['headless', 'copilot'],
                },
                preset: 'copilot-cli',
                timeoutSeconds: 1800,
            },
            {
                _comment: [
                    'Gemini CLI: fixed --prompt=... with the task on stdin, --output-format json, --allowed-mcp-server-names bruce-comm.',
                    'Bruce Comm is injected through a runner-written system settings file (GEMINI_CLI_SYSTEM_SETTINGS_PATH, highest',
                    'precedence, trust: true), so a bruce-comm entry in your own ~/.gemini/settings.json cannot replace it.',
                    'GEMINI_CLI_NO_RELAUNCH=true is set automatically. Cold start can take 30-60 s. Log in once interactively first.',
                    detectedNote(detected['gemini-cli'], 'install with: npm install -g @google/gemini-cli'),
                ],
                enabled: false,
                agent: {
                    id: 'gemini-worker',
                    name: 'Gemini CLI (headless)',
                    description: 'Headless Gemini CLI worker for research, summaries and code questions.',
                    instructions: 'Send one self-contained question or task with all the context it needs and the output format you want. ' +
                        'My final answer becomes the task result. Expect about a minute of startup per task.',
                    skills: [
                        { id: 'research', name: 'Research', description: 'Answer questions, compare options, summarise documents.' },
                        { id: 'summarize', name: 'Summarize' },
                        { id: 'code', name: 'Coding' },
                    ],
                    tags: ['headless', 'gemini'],
                },
                preset: 'gemini-cli',
                timeoutSeconds: 1800,
            },
            {
                _comment: [
                    'OpenAI Codex CLI: codex exec - (prompt on stdin) --sandbox read-only, approval_policy="never", bruce-comm injected',
                    'with -c mcp_servers.bruce-comm={...} (default_tools_approval_mode="approve"). Result = the -o last-message file.',
                    'Allow edits with "extraArgs": ["--sandbox", "workspace-write"] and a repository "cwd".',
                    detectedNote(detected.codex, 'install with: npm install -g @openai/codex'),
                ],
                enabled: false,
                agent: {
                    id: 'codex-worker',
                    name: 'Codex CLI (headless)',
                    description: 'Headless OpenAI Codex worker for coding tasks (read-only sandbox by default).',
                    instructions: 'Send one self-contained coding task: goal, repository path, constraints and expected output. I run unattended in a ' +
                        'read-only sandbox unless my owner allowed more; my final message becomes the task result.',
                    skills: [{ id: 'code', name: 'Coding' }],
                    tags: ['headless', 'codex'],
                },
                preset: 'codex',
                timeoutSeconds: 1800,
            },
            {
                _comment: [
                    'Cursor CLI (EXPERIMENTAL): cursor-agent -p --output-format json --approve-mcps --trust --workspace {cwd}; it is told',
                    'to read the prompt file (Cursor cannot read stdin). The runner temporarily adds bruce-comm to {cwd}/.cursor/mcp.json',
                    'and restores the file afterwards; the entry carries one run\'s task marker, so runs in the same cwd take turns',
                    '(concurrency > 1 does not run them in parallel there). Needs CURSOR_API_KEY in "env" or a logged-in CLI.',
                    detectedNote(detected['cursor-agent'], 'install the Cursor CLI (https://cursor.com/docs/cli/installation).'),
                ],
                enabled: false,
                agent: {
                    id: 'cursor-worker',
                    name: 'Cursor CLI (headless)',
                    description: 'Headless Cursor agent worker for coding tasks.',
                    instructions: 'Send one self-contained coding task with goal, repository path and expected output. My final answer becomes the result.',
                    skills: [{ id: 'code', name: 'Coding' }],
                    tags: ['headless', 'cursor'],
                },
                preset: 'cursor-agent',
                timeoutSeconds: 1800,
            },
            {
                _comment: [
                    'VS Code chat (fire-and-forget): code chat -m agent -r "..." - with the task on stdin (attached as a file).',
                    'The Copilot agent must finish the task itself with complete_task (resultFrom "mcp"); the runner keeps the claim',
                    'alive until then or until timeoutSeconds. REQUIRED: bruce-comm in your VS Code MCP config (bruce-comm install vscode)',
                    'and its tools approved once. Set "cwd" to the folder VS Code should open.',
                    'The chat uses your VS Code window\'s own bruce-comm connection: it passes this agent id on each call (that acts for',
                    'the call only; the window keeps its own identity). Use the VS Code agent id here (e.g. "vscode-copilot") to make them one agent.',
                    detectedNote(detected['vscode-chat'], 'install VS Code and its "code" command.'),
                ],
                enabled: false,
                agent: {
                    id: 'vscode-chat-worker',
                    name: 'VS Code Copilot (via code chat)',
                    description: 'Dispatches tasks into a VS Code window running GitHub Copilot agent mode.',
                    instructions: 'Send one self-contained task about the workspace open in VS Code. The Copilot agent reports with complete_task; ' +
                        'results can take several minutes.',
                    skills: [{ id: 'code', name: 'Coding' }],
                    tags: ['vscode', 'copilot'],
                },
                preset: 'vscode-chat',
                resultFrom: 'mcp',
                timeoutSeconds: 1800,
            },
            {
                _comment: [
                    'Custom command: any program. It receives the full prompt on stdin (also in {promptFile}); whatever it prints on',
                    'stdout becomes the result; a non-zero exit fails the task (with the stderr tail). With "resultFrom": "mcp" it must',
                    'call complete_task itself through the server described in {mcpConfigFile} (identity pre-bound).',
                    '"command" may be an .exe, a .js file (run with node) or a name on PATH; .cmd/.bat files are refused unless they are',
                    'standard npm shims.',
                ],
                enabled: false,
                agent: {
                    id: 'my-script-worker',
                    name: 'My script',
                    description: 'Example: a local script that processes tasks.',
                    instructions: 'Send a task whose body is the input for the script. The script output becomes the result.',
                    skills: [{ id: 'script', name: 'Script' }],
                },
                preset: 'custom',
                command: 'node',
                args: ['C:\\path\\to\\my-agent.mjs', '{promptFile}', '{taskId}'],
                timeoutSeconds: 300,
            },
        ],
    };
}
/**
 * Validate the runner config and diagnose every entry: command resolution, working directory,
 * placeholders, timeouts, daemon reachability for the http transport. Throws for an invalid file.
 */
export async function checkRunners(ctx, file = ctx.config.runnersFile) {
    const { runners } = loadRunnerConfig(file);
    const needsDaemon = runners.some((r) => r.enabled && r.mcpTransport === 'http');
    const daemon = needsDaemon ? await probeDaemon(ctx.config) : undefined;
    const checks = runners.map((runner) => {
        const preset = PRESETS[runner.preset];
        const problems = [];
        const warnings = [];
        const found = detectPresetCommand(runner.preset, runner.command);
        if (found.error)
            problems.push(found.error);
        const { cwd, isDefault } = runnerCwd(ctx.config, runner);
        if (!isDefault && !isDirectory(cwd))
            problems.push(`Working directory does not exist: ${cwd}`);
        const unknown = unknownPlaceholders([...(runner.args ?? []), ...(runner.extraArgs ?? []), ...Object.values(runner.env ?? {})]);
        if (unknown.length)
            warnings.push(`Unknown placeholder(s) left as-is: ${unknown.join(', ')}`);
        if (preset.minTimeoutSeconds && runner.timeoutSeconds < preset.minTimeoutSeconds) {
            warnings.push(`timeoutSeconds ${runner.timeoutSeconds} is short for ${preset.id} (startup alone can take ~60 s); use >= ${preset.minTimeoutSeconds}.`);
        }
        const resultFrom = runner.resultFrom ?? preset.resultFrom;
        if (preset.detached && resultFrom !== 'mcp')
            warnings.push(`${preset.id} cannot return output; use "resultFrom": "mcp".`);
        if (preset.experimental)
            warnings.push(preset.experimental);
        if (runner.mcpTransport === 'http' && daemon && !daemon.ok && runner.enabled) {
            problems.push(`mcpTransport "http" needs the daemon, but ${daemon.url} is not answering (${daemon.error}). Start it with: bruce-comm serve`);
        }
        if (runner.agent.instructions === undefined)
            warnings.push('agent.instructions not set - a generic profile text will be used.');
        if (preset.borrowedSession)
            warnings.push(...vscodeIdentityWarnings(runner.agent.id, cwd));
        if (runner.agent.max_concurrent_tasks !== undefined && runner.agent.max_concurrent_tasks < runner.concurrency) {
            warnings.push(`agent.max_concurrent_tasks (${runner.agent.max_concurrent_tasks}) is below concurrency (${runner.concurrency}); only that many tasks run at once.`);
        }
        warnings.push(...workspaceTurnWarnings(ctx, runner, runners));
        return {
            agent_id: runner.agent.id,
            preset: runner.preset,
            enabled: runner.enabled,
            ok: problems.length === 0,
            command: found.name ?? runner.command ?? preset.commands[0],
            resolved: found.via,
            cwd,
            result_from: resultFrom,
            mcp_transport: runner.mcpTransport,
            problems,
            warnings,
        };
    });
    return { file, runners: checks };
}
/**
 * A preset that merges its per-run entry into workspace files (Cursor's .cursor/mcp.json) runs one task at a time per
 * working directory (the worker's lockWorkspace): say so when concurrency > 1 or another enabled entry of such a preset
 * uses the same cwd, since those runs wait for each other instead of running in parallel.
 */
function workspaceTurnWarnings(ctx, runner, runners) {
    const relative = PRESETS[runner.preset].workspaceFiles;
    if (!relative?.length)
        return [];
    const { cwd } = runnerCwd(ctx.config, runner);
    const files = relative.map((file) => path.join(cwd, file)).join(', ');
    const warnings = [];
    if (runner.concurrency > 1) {
        warnings.push(`concurrency ${runner.concurrency}: every ${runner.preset} run writes its own task marker into ${files}, so runs in this ` +
            'working directory take turns (one at a time); the other claimed tasks wait for their turn. For parallel runs, use ' +
            'separate runner entries with separate "cwd" folders (e.g. separate clones).');
    }
    const key = workspaceKey(cwd);
    const sharing = runner.enabled
        ? runners.filter((other) => other !== runner && other.enabled && PRESETS[other.preset].workspaceFiles?.length && workspaceKey(runnerCwd(ctx.config, other).cwd) === key)
        : [];
    if (sharing.length) {
        warnings.push(`shares its working directory with ${sharing.map((other) => other.agent.id).join(', ')}: their runs and this one take turns ` +
            `with ${files} (one run at a time).`);
    }
    return warnings;
}
/**
 * vscode-chat runs inside the user's VS Code window, through that window's own bruce-comm entry: compare the agent id
 * that entry pre-binds with the runner's. A different id works (the prompt has the chat pass agent_id per call, which
 * acts for that call only), but the window then shows up as its own agent; an entry without a pre-bound id would be
 * bound to the runner agent by the first such call.
 */
function vscodeIdentityWarnings(runnerId, cwd) {
    const { files, file, agentId } = vscodeBoundAgent(cwd);
    if (!file) {
        return [`No bruce-comm entry in ${files.join(' or ')}: the Copilot agent needs one to report. Run: bruce-comm install vscode`];
    }
    if (agentId === runnerId)
        return [];
    if (agentId === null) {
        return [
            `VS Code's bruce-comm entry (${file}) pre-binds no agent id: the first call that passes agent_id="${runnerId}" binds that ` +
                `window to the runner agent. Pre-bind it with: bruce-comm install vscode --agent-id ${runnerId} --yes`,
        ];
    }
    return [
        `VS Code's bruce-comm entry (${file}) is bound to "${agentId}", this runner to "${runnerId}": the chat acts as "${runnerId}" ` +
            `only in the calls that pass agent_id (the runner's prompt asks for that) and the window stays "${agentId}". ` +
            `Set "agent.id" to "${agentId}" to make them one agent.`,
    ];
}
/**
 * The agent id VS Code's bruce-comm entry pre-binds (null: none), from <cwd>/.vscode/mcp.json or the user config.
 * `file` is unset when neither of the `files` looked at has a bruce-comm entry.
 */
function vscodeBoundAgent(cwd) {
    const client = getClient('vscode');
    const files = [path.join(cwd, '.vscode', 'mcp.json'), installTarget(client)];
    for (const file of files) {
        let servers;
        try {
            servers = readJsonConfig(file).data[client.rootKey];
        }
        catch {
            continue;
        }
        const entry = servers && typeof servers === 'object' ? servers[SERVER_NAME] : undefined;
        if (entry && typeof entry === 'object')
            return { files, file, agentId: boundAgentOf(entry) };
    }
    return { files };
}
/** BRUCE_AGENT_ID, `--agent-id`, `?agent=` or X-Bruce-Agent of a server entry, lower-cased (null when none). */
function boundAgentOf(entry) {
    const text = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);
    const env = entry.env;
    const headers = entry.headers;
    const args = Array.isArray(entry.args) ? entry.args : [];
    const argIndex = args.indexOf('--agent-id');
    let fromUrl = null;
    try {
        fromUrl = typeof entry.url === 'string' ? new URL(entry.url).searchParams.get('agent') : null;
    }
    catch {
        // not a URL
    }
    return text(env?.BRUCE_AGENT_ID) ?? (argIndex >= 0 ? text(args[argIndex + 1]) : null) ?? text(fromUrl) ?? text(headers?.['X-Bruce-Agent']);
}
function isDirectory(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=setup.js.map