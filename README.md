# Bruce Comm

Bruce Comm is a **local-only MCP gateway** for the AI agents on your computer. Claude Desktop, GitHub Copilot in
VS Code, Cursor, Claude Code, Gemini CLI, Codex and other MCP clients connect to it, **register a profile** (who they are,
their skills, and the instructions other agents must follow to work with them), **discover** each other and exchange
**tasks and messages** through a shared, persistent SQLite queue. A worker claims a task with a lease, does the work and
reports a result, a failure or a question for the sender. An optional **runner** starts headless agent CLIs so tasks are
processed with nobody at the keyboard, and a **dashboard** lets you watch the queue, approve held tasks and answer questions.

```
  Claude Desktop   VS Code Copilot   Cursor   Claude Code   Gemini CLI   Codex   Copilot CLI ...
        |                |              |          |             |          |          |
      stdio         stdio or HTTP     (each client picks stdio or HTTP; Claude Desktop is stdio only)
        |                |              |          |             |          |          |
        v                v              v          v             v          v          v
  +---------------------------------------+   +----------------------------------------+
  | bruce-comm stdio                      |   | bruce-comm serve  (HTTP daemon)         |
  | one process per client connection     |   | /mcp  MCP Streamable HTTP               |
  |                                       |   | /api  REST    /  dashboard              |
  +-------------------+-------------------+   +--------------------+-------------------+
                      |                                            |
                      v                                            v
            +-------------------------------------------------------------+
            |  %USERPROFILE%\.bruce-comm\bruce-comm.db   (SQLite, WAL)       |
            |  agents | sessions | tasks | task_events                      |
            +------------------------------+------------------------------+
                                           |
                                           v
                       bruce-comm runner (runners.json)
                         |-- claude -p ...        (Claude Code)
                         |-- gemini --prompt=...  (Gemini CLI)
                         |-- codex exec -         (Codex)
                         |-- copilot -s ...       (Copilot CLI)
                         `-- your own command
```

Every process opens the same database file, so a task sent from a stdio client is seen at once by an HTTP client, the
dashboard and the runner. No daemon is needed for stdio clients; the daemon adds the dashboard and the HTTP endpoint.

## Contents

[Features](#features) ·
[Requirements](#requirements) ·
[Install & build](#install--build) ·
[Quick start](#quick-start-5-steps) ·
[Connecting clients](#connecting-clients) ·
[How agents use it](#how-agents-use-it) ·
[Running fully unattended](#running-fully-unattended) ·
[Dashboard](#dashboard) ·
[PC control](#pc-control-computer-use-macos) ·
[CLI reference](#cli-reference) ·
[MCP tools](#mcp-tools-reference) ·
[Resources & prompts](#resources--prompts) ·
[Security model](#security-model) ·
[Configuration](#configuration) ·
[Troubleshooting](#troubleshooting) ·
[Robustness](#robustness) ·
[Limitations](#limitations) ·
[Architecture](#architecture)

Further reading: [docs/AGENT-GUIDE.md](docs/AGENT-GUIDE.md) (text to paste into your agents' instructions) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (data model, state machine, routing, delivery semantics).

## Features

- **Agent directory.** Agents register a profile: id, name, platform, description, skills, tags and, most importantly,
  *instructions for other agents*. Others look it up with `get_agent` before sending work.
- **Persistent task queue.** Tasks (work with a result) and messages (information only), with priorities 0-9, threads,
  sub-tasks, idempotency keys, delayed delivery, expiry, leases and retries. Survives restarts.
- **Routing.** To one agent, to any agent (`"*"`), to whoever offers a skill or tag, or a broadcast to everyone.
- **Sessions.** One agent id can be open in several windows at once (two VS Code windows, Claude Desktop plus a terminal,
  a runner). Bruce Comm lists every live session and can deliver a task to **one exact window** (`to_session`) or to
  **whichever window has a folder open** (`to_workspace`). Replies find their way back to the window that asked.
- **Long-polling with instant wake-up.** `get_next_task` and `wait_for_result` block until something happens. Changes made
  by the same process wake them at once; changes made by other processes wake them within about 0.4 s.
- **Attention counters.** Every tool response ends with a `_bruce` block (tasks waiting, unread messages, questions for
  you, results ready), because push notifications to a chat are unreliable.
- **Questions mid-task.** A worker can ask the sender a question (`request_input`). The task pauses and comes back to the
  same worker, and the same window, once it is answered.
- **Human in the loop.** You can require approval for tasks sent to an agent; only you can approve or deny, from the
  dashboard or the CLI. You can also answer questions, cancel tasks and send tasks yourself.
- **Headless runner.** Presets for Claude Code, Copilot CLI, Gemini CLI, Codex, Cursor CLI and VS Code chat, or any command
  of your own. Task text is never put on a command line.
- **Prompt-injection hygiene.** Everything another agent wrote is delivered inside `<bruce_task>` / `<bruce_message>` /
  `<bruce_result>` blocks with a provenance preamble; look-alike tags inside the text are escaped.
- **Live dashboard.** Agents and their sessions, tasks with filters, a detail drawer with the event timeline, approval
  banner, new-task form with a window picker, light and dark themes, live updates over SSE. No external resources.
- **Client setup helpers.** `bruce-comm config` prints ready-to-paste config with your absolute paths for 12 clients;
  `bruce-comm install` merges it into the client's config file, with a backup.
- **PC control (macOS, opt-in).** Screenshot, zoom, click, type, key and window tools for any MCP client, through a small
  helper app. Off for every agent until you switch it on with Touch ID; a kill switch (⌃⌥⌘K) stops it at once; every
  call is logged with a thumbnail. See [PC control](#pc-control-computer-use-macos).

## Requirements

- **Node.js 22.13 or newer** (uses the built-in `node:sqlite`; developed and tested on Node 24).
- **Windows 10/11** is the primary, tested platform. macOS and Linux code paths exist (config locations, process-group
  kill) but are less tested.
- At least one MCP client. For unattended work, a headless agent CLI (`claude`, `gemini`, `codex`, `copilot`, ...).
- PC control only: macOS 14 or newer and the Xcode Command Line Tools (`swiftc`, `codesign`).

## Install & build

```powershell
cd "C:\path\to\Bruce Comm"
npm install
npm run build              # tsc -> dist/
node bin/bruce-comm.js doctor
```

Optional: put `bruce-comm` on your PATH with `npm link` (run it in the project folder). The examples below use
`bruce-comm`; without `npm link`, run `node bin/bruce-comm.js` from the project folder instead.

Client configs always use the **absolute** path of `node.exe` and `bin\bruce-comm.js`, so they keep working for clients that
do not see your PATH (Claude Desktop from the Microsoft Store, for example).

`npm test` builds and runs the Node test runner over `test/`.

## Quick start (5 steps)

1. **Build** (see above) and run `bruce-comm doctor`. It checks Node, the database, the daemon port, the runner config
   and which agent CLIs are installed, and prints the next step.

2. **Connect your clients from a normal terminal** (Windows Terminal, PowerShell or cmd, not a terminal started from inside
   Claude Desktop):

   ```powershell
   bruce-comm install vscode
   # Quit Claude Desktop completely first (tray icon > Quit): it rewrites its config file on exit.
   bruce-comm install claude-desktop
   ```

   `install` merges a `bruce-comm` entry into the client's config file and keeps a timestamped `.bak` copy. It finds the
   real Claude Desktop config of a Microsoft Store (MSIX) install. Add `--dry-run` to preview. For other clients see
   [Connecting clients](#connecting-clients).

3. **Restart the clients.** In VS Code, allow the bruce-comm tools once ("Allow all tools from this server"). Optional:
   start the dashboard with `bruce-comm serve` and open <http://127.0.0.1:7457/>.

4. **In each chat, make the agent a worker.** Either run the `bruce_worker_mode` prompt (VS Code: type
   `/mcp.bruce-comm.bruce_worker_mode`; Claude Code: `/mcp__bruce-comm__bruce_worker_mode`), or just ask:

   > Register yourself in Bruce Comm as `copilot-frontend` (skills: frontend, code-review), then go into worker mode:
   > call get_next_task in a loop and do the tasks you receive.

   The agent calls `register_agent` with its profile and then loops on `get_next_task(wait_seconds=50)`.

5. **Send a task.** From another chat ("Use Bruce Comm to ask copilot-frontend to review src/checkout.ts and report the
   risks"), from the dashboard's *New task* form, or from the CLI as the human:

   ```powershell
   bruce-comm send --to copilot-frontend --title "Review checkout.ts" --body "Repository C:\src\shop. Review src/checkout.ts for bugs; list each issue with file:line." --wait 300
   ```

   `bruce-comm tasks` and `bruce-comm task <id>` show progress and the result.

## Connecting clients

`bruce-comm config <client|all> [--transport stdio|http] [--port n] [--agent-id id]` prints the snippet for a client with
your absolute paths filled in. `bruce-comm install <client>` writes it into the client's config file for you.

| Client | id for `config` / `install` | Default agent id | Transports | Where it goes (Windows) |
|---|---|---|---|---|
| Claude Desktop | `claude-desktop` | `claude-desktop` | **stdio only** | MSIX: `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json`, otherwise `%APPDATA%\Claude\claude_desktop_config.json` |
| VS Code (Copilot agent mode) | `vscode` | `vscode-copilot` | stdio, http | `%APPDATA%\Code\User\mcp.json` (`servers`), or `.vscode/mcp.json` per repo |
| Cursor | `cursor` | `cursor` | stdio, http | `%USERPROFILE%\.cursor\mcp.json`, or `.cursor/mcp.json` per repo |
| Windsurf (legacy Cascade) | `windsurf` | `windsurf` | stdio, http (`serverUrl`) | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` |
| Devin Desktop (formerly Windsurf) | `devin` | `devin` | stdio, http (`serverUrl`) | `%APPDATA%\devin\mcp_config.json` |
| Visual Studio 2022 17.14+ / 2026 | `visual-studio` | `visual-studio` | stdio, http | `%USERPROFILE%\.mcp.json` (`servers`); then enable the tools in the Copilot Chat tool picker |
| JetBrains AI Assistant | `jetbrains` | `jetbrains` | stdio, http | Settings > Tools > AI Assistant > Model Context Protocol (MCP) > Add > "As JSON" (`install` prints the JSON) |
| JetBrains Junie | `junie` | `junie` | stdio, http | `%USERPROFILE%\.junie\mcp\mcp.json`, or `.junie/mcp/mcp.json` per repo |
| Claude Code | `claude-code` | `claude-code` | stdio, http | `install` prints a `claude mcp add --scope user ...` command (or use `.mcp.json` per repo) |
| Gemini CLI | `gemini` | `gemini-cli` | stdio, http (`httpUrl`) | `%USERPROFILE%\.gemini\settings.json` (adds `"trust": true`, `"timeout": 600000`) |
| OpenAI Codex CLI / IDE extension | `codex` | `codex` | stdio, http | `install` prints TOML for `%USERPROFILE%\.codex\config.toml` and a `codex mcp add` command |
| GitHub Copilot CLI | `copilot-cli` | `copilot-cli` | stdio, http | `%USERPROFILE%\.copilot\mcp-config.json` (`tools: ["*"]`) |

Aliases: `claude` = claude-desktop, `code` / `vs-code` = vscode, `vs` / `visualstudio` = visual-studio, `intellij` =
jetbrains, `copilot` = copilot-cli, `gemini-cli` = gemini.

**stdio or HTTP?**

- **stdio (default, recommended).** The client starts `node bin\bruce-comm.js stdio` itself. Nothing else needs to run.
  Each client gets its own small process; all of them share the database.
- **HTTP.** The client connects to `http://127.0.0.1:7457/mcp?agent=<id>`. Needs `bruce-comm serve` running. Useful when a
  client handles stdio servers badly. With a token configured, the generated entry carries the `Authorization` header
  (Codex reads it from `BRUCE_COMM_TOKEN`).

**Identity pre-binding.** Each snippet names a default agent id: stdio entries set `BRUCE_AGENT_ID` in `env`, HTTP entries
add `?agent=<id>`. This only says who the session belongs to; the agent still registers its profile with `register_agent`
(instructions are required the first time). Use `--agent-id` for another id, for example a per-repository
`.vscode/mcp.json` with `--agent-id copilot-frontend`. In a pre-bound session:

- a call that passes another `agent_id` acts as that agent for that call only and does not rebind the window;
  `register_agent` with another id does rebind it;
- the window can change or unregister only its configured agent and agents it registered itself. `register_agent`
  naming another existing agent binds the window without touching that profile (passing profile fields is refused),
  and `unregister_agent` for it is refused. A window configured for that agent and the human (dashboard, CLI) can
  still change it; a session with no pre-bound id is not restricted (see [Trust model](#trust-model)).

**Install behaviour.** `install` never drops other keys, writes a timestamped `.bak` first, refuses to replace a
*different* existing `bruce-comm` entry without `--yes`, and refuses files with comments or trailing commas (JSONC)
without `--yes` because the comments would be lost. `--config-file <path>` targets another file. For Claude Code, Codex and
JetBrains AI Assistant it prints the command or text instead of editing a file.

### Snippets

Do not type these by hand: `bruce-comm config <client>` prints them with your real paths. An `env` entry
`BRUCE_COMM_HOME` / `BRUCE_COMM_DB` is added only when you use a non-default data directory.

**Claude Desktop** (stdio only: Custom Connectors connect from Anthropic's cloud and cannot reach `127.0.0.1`):

```json
{
  "mcpServers": {
    "bruce-comm": {
      "command": "node",
      "args": ["C:\\Users\\you\\Bruce Comm\\bin\\bruce-comm.js", "stdio"],
      "env": { "BRUCE_AGENT_ID": "claude-desktop" }
    }
  }
}
```

Quit Claude Desktop from the tray before editing, keep the other keys (such as `preferences`), then start it again. On a
Microsoft Store install, edit the file under `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`; the
`%APPDATA%\Claude` path only exists inside the app's container. Logs: `<config folder>\logs\mcp-server-bruce-comm.log`.

**VS Code**, stdio and HTTP (`%APPDATA%\Code\User\mcp.json` or `.vscode/mcp.json`):

```json
{
  "servers": {
    "bruce-comm": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\you\\Bruce Comm\\bin\\bruce-comm.js", "stdio"],
      "env": { "BRUCE_AGENT_ID": "vscode-copilot" }
    }
  }
}
```

```json
{ "servers": { "bruce-comm": { "type": "http", "url": "http://127.0.0.1:7457/mcp?agent=vscode-copilot" } } }
```

Cursor, Junie, Copilot CLI and Gemini use the same shape under `mcpServers` (Gemini adds `"trust": true, "timeout": 600000`;
its HTTP key is `httpUrl`; Windsurf / Devin use `serverUrl`).

**Claude Code:**

```powershell
claude mcp add bruce-comm --transport stdio --scope user --env BRUCE_AGENT_ID=claude-code -- "node" "C:\Users\you\Bruce Comm\bin\bruce-comm.js" stdio
```

Keep the server name (and, for HTTP, the URL) before the options: `--env` and `--header` take several values and would
swallow a name that follows them. HTTP: `claude mcp add bruce-comm "http://127.0.0.1:7457/mcp?agent=claude-code"
--transport http --scope user`, plus `--header "Authorization: Bearer <token>"` when a token is set (`config` adds it,
and `-H` likewise to its `gemini mcp add` command). Allow the tools without prompts with
`--allowedTools "mcp__bruce-comm__*"` (or `/permissions`).

**Codex** (`%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.bruce-comm]
command = 'node'
args = ['C:\Users\you\Bruce Comm\bin\bruce-comm.js', 'stdio']
startup_timeout_sec = 20
tool_timeout_sec = 120
default_tools_approval_mode = 'approve'

[mcp_servers.bruce-comm.env]
BRUCE_AGENT_ID = 'codex'
```

**Test the server** with the MCP Inspector:
`npx @modelcontextprotocol/inspector "node" "C:\Users\you\Bruce Comm\bin\bruce-comm.js" stdio`.

## How agents use it

The server sends short instructions at connect time, and the full protocol guide is the `bruce://guide` resource.
[docs/AGENT-GUIDE.md](docs/AGENT-GUIDE.md) has text you can paste into an agent's own instructions.

**1. Register with good instructions.** `register_agent` creates or updates the profile (patch semantics: only the fields
passed change) and binds the session. `instructions` is required on first registration. It is what other agents read
before sending work: what you accept and refuse, the input you need, what you return, typical turnaround. The
`bruce_register` prompt helps write it.

**2. Discover.** `list_agents` (filter by `skill`, `platform` or free-text `query`) shows presence, from most to least
reachable: `listening` (blocked in `get_next_task` now), `active` (a call in the last 2 minutes), `connected` (an open
session), `idle` (seen in the last 30 minutes), `offline`. `get_agent` returns the full card with instructions,
skills, queue counts and live sessions.

**3. Delegate.** `send_task` with exactly one route: `to_agent` (an id, or `"*"` for any agent), `to_skill` (matches skill
ids, skill tags and agent tags) or `broadcast=true`. Write a self-contained brief: the recipient cannot see your
conversation. Then `wait_for_result`, or pass `wait_seconds` to `send_task`. Useful extras: `priority`, `input` (any
JSON), `parent_task_id` for a sub-task of the task you are working on, `idempotency_key` for safe re-sends (a re-send
with a key you already used returns the original task, or every copy of a broadcast, instead of queueing again),
`requires_approval`, `delay_seconds`, `expires_in_seconds` (the task expires only if nobody has claimed it by then),
`lease_seconds`, `max_attempts`.

**4. Work loop.** `get_next_task(wait_seconds=50)` blocks until a task or message arrives, claims the best task (tasks
reserved for you first, then priority, then age) and delivers unread messages. Do the work, call `update_task_progress` at
least every `lease_seconds / 2` on long work (default lease 15 minutes), and finish with exactly one of `complete_task`,
`request_input`, `fail_task` (`retry=true` for transient problems), `reject_task` or `release_task`. Then call
`get_next_task` again. An empty result only means nothing arrived yet.

**5. Questions (input required).** `request_input` pauses the task (`input_required`) and frees the worker's slot. The
sender sees it through `questions_for_you` and `wait_for_result`, and answers with `reply_to_task`. You can also answer
from the dashboard or with `bruce-comm answer`. The task goes back to the same worker, and the same window if it is still
open, with the answer in its history. Answering does not use up a delivery attempt.

**6. Sessions and workspace routing.** Each MCP connection is a *session* (`S-XXXXXXXX`) with its client name and version,
an optional label and its workspace folders. Folders come from MCP roots when the client supports them, or from
`register_agent(session_workspaces=[...])`.

- `list_sessions` (or `bruce-comm sessions`) lists live sessions; `get_agent` shows an agent's sessions.
- `send_task(to_agent="vscode-copilot", to_session="S-7K3M9Q2X")`: only that window may claim it, while it is
  connected. If the window closes, or stops heartbeating for 120 s (hung or asleep), the task falls back to a window with
  the same workspace (any window of the agent when it had none). A window that comes back before someone else claimed
  the task gets its pin back.
- `send_task(to_agent="vscode-copilot", to_workspace="shop-frontend")`: any window of that agent whose workspace path, folder
  name or session label matches. Paths are normalised (case, slashes, `file:///c%3A/...` URIs).
- Without either, whichever session of the agent calls `get_next_task` first gets the task.
- With several windows open, give each one a `session_label` (for example "VS Code - frontend repo").

**7. Reply routing.** `send_task` records the sending session. A follow-up sent with `parent_task_id` to the parent's
*sender* goes to the window that asked; one sent to the parent's *assignee* goes to the window that did the work (falling
back to that window's workspace if it has closed). The `questions_for_you` and `results_ready` counters show up in the
window that sent the task, or in every window when that one is gone.

**8. Messages vs tasks.** `kind="message"` is information only: it is complete once delivered (with the next
`get_next_task`), has no result and cannot ask questions. Reply to one, if useful, with
`send_task(kind="message", to_agent=<sender>, thread_id=<thread>)`. Use tasks for anything that needs an answer.

## Running fully unattended

**The honest truth: an MCP server cannot wake up a chat.** MCP clients call servers; a server cannot start a turn in an
idle Claude Desktop, VS Code or Cursor conversation. So there are two ways to get work done unattended.

**A. Worker mode in an interactive app.** Run the `bruce_worker_mode` prompt in an open chat. The agent loops on
`get_next_task(wait_seconds=50)` and handles tasks as they arrive. It works while that window stays open, but each empty
poll costs a little context and tokens, and many chat apps pause long agent loops after a number of tool calls or turns
and ask you to continue. Good for "while I'm around"; not a background service.

**B. The runner for headless CLIs.** `bruce-comm runner` keeps one or more agents registered and listening. For every task
it starts a headless agent CLI, gives it the task, and records the outcome.

```powershell
bruce-comm runner init     # writes %USERPROFILE%\.bruce-comm\runners.json: one DISABLED example per preset
# edit runners.json: set "enabled": true on the entries you want, point "cwd" at a repository
bruce-comm runner check    # resolves commands, checks cwd, placeholders, timeouts; exit code 1 on problems
bruce-comm runner          # run until Ctrl+C   (--only id,id  --once  --config file)
```

| Preset | Command | Task text reaches the CLI via | Result taken from | Notes |
|---|---|---|---|---|
| `claude-code` | `claude` (PATH, then `%USERPROFILE%\.local\bin\claude.exe`) | stdin | `result` of `--output-format json` | `--permission-mode dontAsk`, only `mcp__bruce-comm__*` allowed, `--strict-mcp-config`, `--max-turns 40` |
| `copilot-cli` | `copilot` | stdin | stdout | `-s --no-ask-user --additional-mcp-config=@<file> --allow-tool=bruce-comm`, auto-update off |
| `gemini-cli` | `gemini` | stdin (`--prompt=` holds fixed text) | `response` of `--output-format json` | MCP config via `GEMINI_CLI_SYSTEM_SETTINGS_PATH` (highest precedence, so a `bruce-comm` entry in your `~/.gemini/settings.json` cannot replace it; the machine's own system settings are copied in), `GEMINI_CLI_NO_RELAUNCH=true`; cold start 30-60 s, use `timeoutSeconds` >= 120 |
| `codex` | `codex exec ... -` | stdin | the `-o` last-message file | `--sandbox read-only`, `approval_policy="never"`, `--ephemeral` |
| `cursor-agent` | `cursor-agent` or `agent` | a prompt file (named in fixed text) | `result` of `--output-format json` | Experimental, untested on Windows; temporarily merges bruce-comm into `<cwd>\.cursor\mcp.json` and restores it, so runs that share a `cwd` take turns |
| `vscode-chat` | `code chat -m agent -r "..." -` | stdin (attached) | MCP: the Copilot agent must call `complete_task` | Experimental fire-and-forget; needs `bruce-comm install vscode` and the tools approved once; see the identity note below |
| `custom` | your `command` + `args` | stdin and `{promptFile}` | stdout, or MCP with `"resultFrom": "mcp"` | `.exe`, `.js` (run with node) or a name on PATH; `.cmd`/`.bat` refused unless a known npm / VS Code shim |

Minimal `runners.json`:

```json
{
  "runners": [
    {
      "enabled": true,
      "agent": {
        "id": "claude-code-worker",
        "name": "Claude Code (headless)",
        "description": "Headless Claude Code worker for code reading, reviews and refactoring plans.",
        "instructions": "Send ONE self-contained coding or analysis task per send_task: goal, repository path, constraints and the exact output you want. I run unattended and cannot see your conversation. My final answer becomes the result. Up to ~30 minutes per task.",
        "skills": [
          { "id": "code", "name": "Coding" },
          { "id": "code-review", "name": "Code review" }
        ]
      },
      "preset": "claude-code",
      "cwd": "C:\\src\\shop",
      "extraArgs": ["--allowedTools", "Read,Grep,Glob"],
      "timeoutSeconds": 1800,
      "concurrency": 1
    }
  ]
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` (`runner init` writes `false`) | Run this entry. |
| `agent` | required | Profile registered for the runner agent (`id` required; `name`, `description`, `platform`, `instructions`, `skills`, `tags`, `accept_from`, `max_concurrent_tasks`, `require_approval`, ...). Registered as the human, so it may also switch approval off. |
| `preset` | required | `claude-code`, `copilot-cli`, `gemini-cli`, `codex`, `cursor-agent`, `vscode-chat` or `custom`. |
| `command` | preset's | Name on PATH or absolute path. Required for `custom`. |
| `args` / `extraArgs` | preset's / none | `args` replaces the preset arguments (required for `custom`, `[]` for none); `extraArgs` is appended. |
| `cwd` | `<home>\work\<agent-id>` | Working directory of the CLI; point it at a repository. |
| `env` | none | Extra environment variables (values may use placeholders). |
| `timeoutSeconds` | `1800` | Hard limit per run; the whole process tree is killed. |
| `concurrency` | `1` | Tasks run in parallel by this entry. |
| `resultFrom` | per preset | `stdout`: the runner completes the task with the output. `mcp`: the agent must call `complete_task` itself. |
| `mcpTransport` | `stdio` | How the CLI reaches Bruce Comm; `http` needs the daemon. |
| `retryOnFailure` | `false` | Re-queue failed runs while attempts remain. |
| `keepRunFiles` | `false` | Keep `<home>\runs\<task>-<attempt>-<claim time>\` (prompt, MCP config, stdout, stderr), one directory per run. |

Placeholders in `args`, `extraArgs` and `env`: `{promptFile}` `{taskId}` `{agentId}` `{mcpConfigFile}` `{mcpUrl}` `{cwd}`
`{runDir}` `{outputFile}` `{nodePath}` `{bruceBin}`. Keys starting with `_` are comments.

What the runner does for each task:

- It opens a session for the agent (transport `runner`, label `<preset> runner`, workspace = `cwd`) and keeps the agent
  `listening`.
- It claims tasks up to `concurrency` and writes the prompt (the provenance-wrapped brief plus reporting instructions)
  and a per-run bruce-comm MCP config with the identity pre-bound. That config marks the CLI's connection as a one-shot
  session for this task (`stdio --runner-task <id>`, `BRUCE_COMM_RUNNER_TASK`, `&runner_task=` for HTTP): the server
  refuses `get_next_task` there and leaves out the work-loop hints, so a headless CLI never claims more work outside
  the runner's supervision.
- It spawns the CLI without a shell and with a hidden window, and renews the lease while it runs. It kills the process
  tree if the task is canceled, reassigned or times out.
- The run is over when the CLI exits, even if a background process it started (a dev server, a build daemon) still
  holds its output pipes. A timeout or kill always ends the run, also when part of the process tree escaped the kill.
- It completes the task with the parsed output, or fails it with the exit code and the stderr tail.
- If the CLI asks a question with `request_input`, the run ends: the CLI is told to stop, and the runner stops it 10 s
  later at the latest (at once if the answer is already there). Nothing is reported for that run. Once the sender
  answers, the task is started again, in a new run, with the answer in its history; this does not use up an attempt.
- Messages for runner agents are written to the runner's log.
- Ctrl+C hands in-flight tasks back to the queue without using an attempt and marks the agent offline. A second Ctrl+C
  exits at once.
- Workspace config a run merged into (`cursor-agent`: `<cwd>\.cursor\mcp.json`) is restored when the run ends, on a
  second Ctrl+C and on a crash. After a hard kill (`taskkill /F`, power loss) the next runner start restores it from the
  record kept in `<home>\runs\`. Such a file holds one run's entry at a time, so runs that use the same `cwd` (any
  entry of this runner process) take turns: a waiting run keeps its claim and lease, and its timeout starts when the
  CLI starts.
- `where.exe` and `taskkill.exe` are started from `System32`, never from the folder the runner was started in.

**`vscode-chat` and identities.** The chat runs in your VS Code window and reaches Bruce Comm through that window's own
`bruce-comm` entry, which `bruce-comm install vscode` pre-binds to `vscode-copilot`. The runner's prompt has the Copilot
agent pass the runner agent's id (`agent_id`) on every call. For a pre-bound window that acts as the runner agent for
that call only; the window keeps its own identity. `runner check` warns when the two ids differ, and when the VS Code
entry pre-binds no id (the first such call would then bind the window to the runner agent). To make them one agent,
give the runner the VS Code agent id (`"agent": {"id": "vscode-copilot", ...}`).

### Auto-start at logon (Task Scheduler)

Bruce Comm does not install anything into Windows for you. To start the runner (and, if you like, the dashboard daemon)
when you log on, create the wrapper script yourself and register it.

1. Save this as `%USERPROFILE%\.bruce-comm\bruce-comm-autostart.cmd` and adjust the two paths:

   ```bat
   @echo off
   set "NODE=node"
   set "BRUCE=C:\Users\you\Bruce Comm\bin\bruce-comm.js"
   set "LOGS=%USERPROFILE%\.bruce-comm\logs"
   if not exist "%LOGS%" mkdir "%LOGS%"
   rem Dashboard + HTTP endpoint (optional - delete this line if you only use stdio clients):
   start "" /b "%NODE%" "%BRUCE%" serve 1>>"%LOGS%\serve.log" 2>&1
   rem Runner (needs at least one enabled entry in runners.json):
   "%NODE%" "%BRUCE%" runner 1>>"%LOGS%\runner.log" 2>&1
   ```

2. Register it from a **Command Prompt (cmd.exe) opened with "Run as administrator"** under your own Windows account.
   Windows usually requires elevation for logon triggers created with `schtasks`; the task itself still runs as you, not
   elevated.

   ```bat
   schtasks /Create /TN "Bruce Comm" /SC ONLOGON /DELAY 0000:30 /TR "\"%USERPROFILE%\.bruce-comm\bruce-comm-autostart.cmd\"" /F
   ```

3. Check and manage it:

   ```bat
   schtasks /Query /TN "Bruce Comm" /V /FO LIST
   schtasks /Run /TN "Bruce Comm"
   schtasks /End /TN "Bruce Comm"
   schtasks /Delete /TN "Bruce Comm" /F
   ```

The task runs only while you are logged on and shows a console window; closing that window stops Bruce Comm. Logs go to
`%USERPROFILE%\.bruce-comm\logs\`. Without admin rights, a shortcut to the `.cmd` in your Startup folder (`Win+R`,
`shell:startup`) has the same effect.

## Dashboard

`bruce-comm serve` starts the daemon; open <http://127.0.0.1:7457/>.

- **Header:** live counts of agents, sessions and tasks by state, with the connection state (SSE, or polling every 5 s
  as a fallback).
- **Attention banners:** tasks awaiting your approval (Approve / Deny) and questions waiting for an answer.
- **Agents:** presence, status, skills, expandable instructions, last seen, and the live sessions of each agent (client
  and version, label, workspaces, listening dot). From here you can send to one window, close a stale session, toggle
  "require approval" and unregister an agent.
- **Tasks:** filter by status, agent or text; the detail drawer shows the body, input JSON, result or error, routing
  (`to_session`, `to_workspace`, assignee session) and the event timeline, with Cancel, Answer, Approve / Deny and
  Add note.
- **New task:** to an agent, a skill, any agent or everyone; task or message; priority; optional window (session) or
  workspace.
- **PC control** (macOS): the kill switch, helper and permission state, an On/Off toggle per agent (switching on asks
  for Touch ID) and the action log with thumbnails. It warns when BruceControl was not told about a stop, when a stop
  is not in the database and when the running helper serves another data folder. See
  [PC control](#pc-control-computer-use-macos).

The page is one self-contained HTML document with no external requests and a strict Content-Security-Policy. All
agent-written text is escaped. With a token configured, open `http://127.0.0.1:7457/?token=<token>` once. The server
swaps it for an HttpOnly cookie and redirects to a clean URL.

The REST API behind it (`/api/status`, `/api/agents`, `/api/sessions`, `/api/tasks`, `/api/events`, ...) is listed in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#10-rest-api). Every write through it acts as the human.

## PC control (computer use, macOS)

PC control lets an agent connected to Bruce Comm (stdio or HTTP `/mcp`) see and use this Mac, much like Claude's computer
use but from any MCP client: screenshots, zoom, clicks, mouse moves and drags, scrolling, typing, key combos, opening apps
and URLs, listing and focusing windows. It is **off for every agent** until you switch that agent on in the dashboard with
Touch ID. A kill switch stops it at once, and every call is logged with a screenshot thumbnail.

```
MCP client --stdio/HTTP--> Bruce Comm (node)  --NDJSON over unix socket-->  BruceControl.app (Swift helper)
             pc_* tools: identity, allowlist,     ~/.bruce-comm/pc-control/helper.sock     the only process that needs
             kill switch, geometry, logging                                                 Accessibility + Screen Recording
```

Bruce Comm (Node) decides: who is calling, whether that agent is allowed, whether the kill switch is on, where a
screenshot pixel is on screen, and what goes into the log. **BruceControl.app** does the work: a small menu-bar helper
built from source in this repository (`native/macos/BruceControl/`). Node starts it on demand through LaunchServices
(`open -g -j -a BruceControl.app --args --home <data folder> --db <database>`), so macOS treats BruceControl as the
responsible app: the permissions belong to BruceControl, not to Node, Terminal or your MCP client. Before every action the
helper checks again, on its own, that the agent holds a Touch ID grant and that nothing is stopped (see
[Switching an agent on](#switching-an-agent-on)).

**One BruceControl per macOS user.** A second copy exits at once, whatever data folder it was started for: it finds the
per-user lock taken or another BruceControl app already running. So one helper serves one Bruce Comm data folder and
database at a time. Before actions (re-checked at most every 10 s) and before every Touch ID request, Bruce Comm checks
that the running helper serves its own data folder and database. If it serves another one, the call fails with
`pc_helper_error` ("BruceControl is running for another Bruce Comm data folder") and the dashboard shows "Helper serves
another data folder". Quit BruceControl from its menu bar item; the next PC action starts it for this folder.

On Windows and Linux the pc_* tools are listed but refuse with `unsupported_platform`, and `pc_status` says
"NOT SUPPORTED".

### Setup

```bash
cd "/path/to/Bruce Comm"
npm run build              # tsc -> dist/ (includes the pc_* tools)
npm run build:helper       # swiftc -> ~/Applications/BruceControl.app (ad-hoc signed, hardened runtime)
npm run test:helper        # optional: checks of the helper's own logic (no app launch, no input events)
```

`npm run build:helper` runs `scripts/build-pc-helper.sh`. It compiles the helper and signs it ad hoc with the hardened
runtime (`codesign -o runtime`, identifier `com.bruce.comm.pccontrol`; the build fails if the runtime flag is missing).
It installs it at `~/Applications/BruceControl.app` (`BRUCE_PC_HELPER_APP` changes the path; a bundle there that is not
BruceControl is never replaced), then prints the path and a reminder about permissions and the Keychain.

**If a helper is already running, the script still installs the new build** and then tells you to quit the running one
from its menu bar item (Bruce Control > Quit); it never kills it for you. Until you quit it, the old build keeps serving.
The next PC action after that starts the new build. Restart your MCP clients (and `bruce-comm serve`) after
`npm run build` so they load the new tools.

Bruce Comm and BruceControl are built from the same repository and must match: Bruce Comm refuses actions through an
older BruceControl that does not report its data folder ("an outdated build") until you rebuild it and quit the old one.

**Testing.** `npm test` covers the Node side against a fake helper. `npm run test:helper` (`scripts/test-pc-helper.sh`)
compiles the helper's sources into a test harness with stand-ins for the Keychain and Touch ID and a temporary data
folder, and checks its grant, stop and startup-check logic. It never starts BruceControl.app, never posts mouse or
keyboard events and never touches your login Keychain or `~/.bruce-comm`.

### macOS permissions (you grant them yourself)

Bruce Comm never changes system settings. You give **BruceControl** (not Terminal, Node or Claude) two permissions:

1. **System Settings > Privacy & Security > Accessibility**: switch on **BruceControl** (if it is not listed, add it with
   `+` from `~/Applications`). Needed for clicks, mouse moves, drags, scrolling, typing, keys and focusing windows.
2. **System Settings > Privacy & Security > Screen & System Audio Recording**: switch on **BruceControl**. Needed for
   screenshots, zoom and window titles. macOS may ask you to quit and reopen BruceControl; the next call starts it again.

- The dashboard's **Request permissions** button (and the helper's menu item *Request permissions…*) only makes macOS
  show Apple's own prompts and list BruceControl. It switches nothing on: you flip the switches yourself.
- **After every `npm run build:helper`** the ad-hoc signature changes and macOS no longer recognises the old entries. In
  both lists remove BruceControl (select it, `-`) and add it again, or switch it off and on. A `permission_missing` error
  while the switch looks on usually means exactly this.
- **Keychain.** BruceControl keeps its grants and its stop flag in your login Keychain (item "Bruce Control state",
  service `com.bruce.comm.pccontrol`). After a rebuild macOS asks again whether BruceControl may use that item, because
  the signature changed. The prompt names the app asking (BruceControl) and the item, shown as "Bruce Control state" or
  as `com.bruce.comm.pccontrol`. **Allow it (or Always Allow) only when the app it names is BruceControl** (Bruce
  Control).
  **Deny any prompt about this item that comes from `security`, Terminal, `node`, a script or any other app:** that is
  another program trying to read or change the PC control state. If you deny BruceControl itself, it fails closed (no
  agent may act) until you switch an agent on or re-enable PC control, which asks again.

`pc_status` (as an agent) or `bruce-comm pc-control status` shows whether both permissions are in place.

### Identity: who is calling

The pc_* tools take **no `agent_id` argument**. They act only as the identity pre-bound by the client's configuration:
`BRUCE_AGENT_ID` or `stdio --agent-id` for stdio, `?agent=<id>` or the `X-Bruce-Agent` header for HTTP (see
[Connecting clients](#connecting-clients)). A session without a pre-bound identity is refused with
`pc_control_refused`, and an `agent_id` passed to other tools never changes who PC control acts for. The agent must also
be registered.

**Runner sessions are refused.** The one-shot sessions that `bruce-comm runner` opens for a headless CLI get
`pc_control_refused`, even when their agent is switched on: their brief was written by another agent and nobody watches
the screen. PC control works only in an attended window of the agent. These refusals are logged with the runner task
id (`runner_task`).

### Switching an agent on

The dashboard's **PC control** panel lists every registered agent, all **Off** by default.

- **On:** Bruce Comm first checks that the running BruceControl serves this data folder and database. Then BruceControl
  shows a Touch ID (or login password) prompt. It writes the prompt text itself and names the agent
  (`allow Bruce Comm agent "<id>" to control this Mac`); nothing an agent sends can change that text. Approve it only
  when you just switched that agent on yourself. The agent is enabled only after the prompt succeeds; the toggle shows
  "Waiting for Touch ID…" meanwhile (up to 2 minutes). If you cancel or fail, the agent stays off (`pc_auth_failed`).
  While a prompt is open, another switch-on or re-enable gets `pc_helper_busy` instead of a second prompt.
- **Off:** no authentication. Bruce Comm refuses the agent from its next call and tells BruceControl, starting it if it is
  not running (it waits up to 10 s). If BruceControl could not be told, the panel says "BruceControl was not told": it
  drops the grant when it next starts (see the startup check below).
- No MCP tool and no CLI command can switch an agent on.

**Two records, both must say yes.** The grant is recorded in the database (`pc_control_agents`) and in BruceControl's
own state in your login Keychain (generic password, service `com.bruce.comm.pccontrol`, account `state`). That state
holds the data folder and the database it belongs to, the granted agent ids and the stop flag. A BruceControl started
for another data folder or database sees no grants in it. BruceControl acts only when its Keychain state grants the
agent, the database has the agent switched on, and neither has the stop on. A database write alone therefore cannot
grant access, and cannot lift a stop that BruceControl has recorded. `<home>/pc-control/state.json` is only a read-only
copy for you to look at: BruceControl never reads it, so editing it or restoring an old copy changes nothing.

**Startup check.** When BruceControl starts, before it acts or grants anything, it compares its Keychain state with the
database. A stop in the database stops it, and a grant whose agent is not switched on in the database is dropped; both
are saved back to the Keychain when the database could be read. That is how a stop or switch-off that BruceControl was
not told about reaches it later. When the database is missing, has no PC control tables yet or cannot be read, no agent
may act, but no grant is dropped from the Keychain (a stop is still saved). Those grants stay unusable in the running
BruceControl until it restarts (quit it from the menu bar) or you switch the agent off and on again. While the database
is busy or locked at startup, BruceControl retries and actions fail with "waiting for the Bruce Comm database".

**When the Keychain state cannot be used**, BruceControl fails closed:

- **Still loading** (for example while a Keychain prompt waits for you): status answers at once ("Loading state…" in
  the dashboard), and actions fail after about 2 s with "waiting for Keychain approval".
- **Unreadable, or you denied the Keychain prompt:** no agent may act and everything counts as stopped ("Helper state
  unreadable"). Switching an agent on or re-enabling PC control (Touch ID) reads the item again, or rewrites it when it
  is damaged. Other Keychain errors are retried in the background, at most every 30 s.
- **Missing, or saved for another Bruce Comm data folder or database:** no agent has a grant here. Switch the agents you
  need off and on again. A grant takes the item over for this data folder and database, so the other one's grants are
  gone.

### Kill switch

Stops all PC control at once, for every agent. Stopping needs no authentication:

| Where | How |
|---|---|
| Dashboard | The red **Stop all PC control** button in the PC control panel. |
| Hotkey | **Control+Option+Command+K** (⌃⌥⌘K) in any app while BruceControl runs. Needs no permission; the Mac beeps. |
| Menu bar | BruceControl's menu bar item > *Stop all PC control*. |
| CLI | `bruce-comm pc-control stop` (works without the daemon). |

- **Dashboard and CLI:** the stop is written to the database and sent to BruceControl, which is started if it is not
  running. Bruce Comm waits up to 10 s; a slower answer still arrives in the background. If BruceControl could not be
  told, the dashboard shows "BruceControl was not told" and the CLI prints a WARNING. Bruce Comm refuses every call
  anyway, and BruceControl applies the stop when it next starts. If the database write fails, the stop still holds in
  BruceControl (when it was told) and in the Bruce Comm process that took it; the dashboard shows "Stop not saved in
  the database" and the CLI prints a WARNING. If neither worked, the stop fails with `pc_stop_failed`: press ⌃⌥⌘K.
- **Hotkey and menu:** BruceControl stops at once in memory, then writes the database and saves the stop in the
  Keychain.
- A repeated stop keeps the first who and when.

Every pc_* call then fails with `pc_killed`. A long `pc_type`, drag, scroll or key repeat stops at its next step, and a
screenshot or window list taken while the stop lands is thrown away. Agents keep their On/Off setting. **Re-enabling
needs Touch ID** (the prompt reads `re-enable PC control for Bruce Comm agents`): use the dashboard's
**Re-enable (Touch ID)** button or the menu item *Re-enable PC control…*. A stop that lands during the prompt wins. No
CLI command or MCP tool can lift the stop.

### Action log

Every pc_* action is logged, refused and failed calls included: time, agent, Bruce session id, tool, arguments (JSON;
`pc_type` text is cut to 500 characters), outcome (`ok` / `refused` / `error`), a one-line result or error and the
duration. After a successful action Bruce Comm stores a thumbnail of the affected display in the background (about
300 ms after the action; JPEG, about 480 px wide; best effort, it never delays or fails the call); `pc_screenshot` and
`pc_zoom` reuse their own image. Thumbnails live under `~/.bruce-comm/pc-control/thumbs/<YYYY-MM-DD>/<id>.jpg`.

The dashboard shows the latest 50 entries; click a thumbnail to see it full size. Older entries:
`GET /api/pc-control/log?limit=&before_id=&agent=`. Retention: entries older than **30 days** (with their thumbnails) are
deleted and at most **20,000** entries are kept; this is checked at most once an hour, when a new entry is written.

**BruceControl's own trail.** The helper logs every request it receives, including requests from programs that talk to
its socket directly: the op, the agent, the connecting process id (`peer_pid`), ok or the error code, and the duration.
It never logs typed text. Rejected connections are logged with their process id too. The lines go to the macOS unified
log:

```bash
log show --last 1h --predicate 'subsystem == "com.bruce.comm.pccontrol"'
```

### Screenshots, scale and coordinates

- `pc_screenshot` returns MCP image content of one display, downscaled like Claude's computer use: long edge at most
  **1568 px**, at most **1.15 megapixels**, aspect ratio kept, **never upscaled**. `BRUCE_PC_MAX_LONG_EDGE` and
  `BRUCE_PC_MAX_PIXELS` change the limits.
- Every reply states the scale and names the other displays, for example:
  `Screenshot of display 0 (main, 1512x982 pt @2x) as 1330x864 px; 1 px = 1.137 pt. ... Other display(s): 1 (1429x804 px) - pass display=<index>.`
  Its payload lists every display (`displays`: index, main, screenshot size, current). `pc_status` lists them too once
  BruceControl runs.
- **Coordinates are screenshot pixels** of the last screenshot's display (per session; the main display until the first
  `pc_screenshot`). Bruce Comm maps them to screen points: Retina-aware and multi-monitor safe, including displays left of
  or above the main one and rotated (portrait) displays. Coordinates outside the screenshot are refused with the valid
  range. `display` (an index, 0 = main) targets another display. Indices count from the main display, so they change
  when you make another display the main one.
- `pc_zoom` captures a region of the last screenshot (at least 8x8 px) at the display's native resolution, for small
  text; small regions are enlarged further until their long edge is about 400 px (within the limits above). The two
  axes can have different scales, so the reply states `kx` and `ky` and the mapping back:
  `screenshot_x = x + zoom_x / kx`, `screenshot_y = y + zoom_y / ky`. Click coordinates always refer to the full
  screenshot, never to the zoomed image.
- **Image size.** By default (`format: "auto"`) an image is PNG. A PNG over 600 KB is sent as JPEG instead (quality 0.8,
  then lower), aiming at **750 KB or less** (about 1 MB as base64). That target is best effort: when no quality reaches
  it, the smallest attempt is sent. `format: "jpeg"` uses the same target. **`format: "png"` is never size-capped** and
  can be several MB for a busy Retina screen.
- `screenshot_after: true` on the action tools appends a fresh screenshot of the affected display to the reply.
- Modifier keys (`pc_click` `modifiers`, `pc_key` combos) are pressed as real keys before the click or key and released
  afterwards, also when the call is stopped half-way; `fn` is sent only as a flag.

### Tools

| Tool | Arguments | What it does |
|---|---|---|
| `pc_status` | none | Who you are, whether you are allowed, whether PC control is stopped, helper and permission state, displays (only when allowed and BruceControl runs), the hotkey and how to get access. Works without being switched on. Read-only. |
| `pc_screenshot` | `display?`, `show_cursor?` (true), `format?` (`auto`/`png`/`jpeg`) | Screenshot of one display, with the scale and a list of all displays. Read-only. |
| `pc_zoom` | `x`, `y`, `width`, `height` (screenshot px), `display?` | Detail view of part of the last screenshot; small regions are enlarged to about 400 px; `kx` / `ky` stated. Read-only. |
| `pc_click` | `x`, `y`, `button?` (`left`/`right`/`middle`), `clicks?` (1-3), `modifiers?`, `display?`, `screenshot_after?` | Move there and click (double and triple click with `clicks`). |
| `pc_mouse_move` | `x`, `y`, `display?` | Move the pointer (hover). |
| `pc_drag` | `path` (2-50 points `{x, y}`), `button?`, `display?`, `screenshot_after?` | Press at the first point, drag through the others, release at the last. All points are on one display; a drag cannot cross to another display. |
| `pc_scroll` | `x`, `y`, `direction` (`up`/`down`/`left`/`right`), `amount?` (3, 1-50), `display?`, `screenshot_after?` | Scroll at a point. |
| `pc_type` | `text` (up to 5000 characters), `screenshot_after?` | Type Unicode text into the focused field; `\n` is Return, `\t` is Tab. |
| `pc_key` | `keys` (for example `cmd+s`, `Return`, `ctrl+shift+tab`), `repeat?` (1-50), `screenshot_after?` | Press a key or combo. Modifiers `cmd`/`command`, `ctrl`/`control`, `alt`/`option`, `shift`, `fn`. See the key notes below. |
| `pc_open_app` | `name` (app name or bundle id) | Start or activate an app. |
| `pc_open_url` | `url` (http/https only), `app?` | Open a web page, optionally in a given browser. |
| `pc_list_windows` | `all?` | Windows with id, app, title and bounds, and the frontmost app. Read-only. |
| `pc_focus_window` | `window_id?`, `app?`, `title?` | Bring an app or window to the front. |
| `pc_cursor_position` | none | Pointer position in screen points, its display, and its pixel position in that display's screenshot. Read-only. |

**Key notes (`pc_key`).** This is macOS: copy, paste, select all and undo are `cmd+c`, `cmd+v`, `cmd+a` and `cmd+z`
(`ctrl+c` in a terminal interrupts the program). `delete` and `backspace` delete **backward** (the Mac delete key);
`forwarddelete` or `del` deletes forward. xdotool names work too: `BackSpace`, `Page_Down`, `KP_Enter`, `KP_0`-`KP_9`,
`Control_L`, `Super_L` and so on. `plus` is the =/+ key (`cmd+plus` zooms in), since `+` itself joins the parts of a
combo. One non-modifier key per call.

App names, window titles and everything in a screenshot come from other apps and web pages. The tools tell agents to
treat them as data, not instructions, and names and titles are cleaned before they appear in a reply's text.

REST endpoints behind the dashboard panel (same token and loopback rules as the rest of `/api`): `GET /api/pc-control`,
`POST /api/pc-control/agents/<id>` `{"enabled": true|false}`, `POST /api/pc-control/kill` `{"killed": true|false}`,
`GET /api/pc-control/log`, `GET /api/pc-control/log/<id>/thumbnail`, `POST /api/pc-control/permissions`. Switching on
and lifting the stop still need Touch ID at the Mac. Switching off and stopping answer with `helper_notified` (and
`helper_error`, `db_error` when something did not work).

### GlowCursor bridge

When the GlowCursor overlay (2.0, "Oggy Neon") runs, Bruce Comm shows each pc_* call on the cursor: a `begin` after
the call is authorized and an `end` (`ok`, `refused` or `error` with its error code) when it finishes, as
`PUT /v1/action` to `127.0.0.1:<port>` (the port comes from `<GLOWCURSOR_HOME>/port`, default 47800; the token from
`<GLOWCURSOR_HOME>/bridge.token`). Only the tool, the agent, a call id and a small detail are sent: button, clicks,
scroll direction, key combo and modifiers, and for `pc_type` the number of characters. Typed text, URLs, app names and
window titles are never sent. It is display only and best effort: every request gives up after 150 ms, errors are
ignored (one log line at the first failure) and no call waits for it, except that `pc_screenshot` and `pc_zoom` wait
up to 30 ms for the cursor to hide its glow so captures show the plain arrow. Stopping and re-enabling PC control
push `PUT /v1/overlay/kill`; the daemon (`bruce-comm serve`) also checks the stop flag every 250 ms, so stops from the
hotkey, the BruceControl menu and the CLI show too, and repeats the push every 10 s while PC control is stopped.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `BRUCE_PC_HELPER_APP` | `~/Applications/BruceControl.app` | Where `npm run build:helper` installs the helper and which app Bruce Comm starts. |
| `BRUCE_PC_HELPER_SOCKET` | `<home>/pc-control/helper.sock` | Socket Bruce Comm connects to (mainly for tests; the helper itself always listens there). |
| `BRUCE_PC_HELPER_NO_LAUNCH` | off | `1`: never start the helper; calls fail while it is not running (tests). |
| `BRUCE_PC_MAX_LONG_EDGE` | `1568` | Longest screenshot edge in pixels. |
| `BRUCE_PC_MAX_PIXELS` | `1150000` | Largest screenshot area in pixels. |
| `GLOWCURSOR_HOME` | `~/.glowcursor` | Where the GlowCursor bridge finds the cursor's `port` and `bridge.token` files. |
| `BRUCE_GLOW` | on | `0` (or `false` / `off` / `no`): never talk to GlowCursor (see [GlowCursor bridge](#glowcursor-bridge)). |

Bruce Comm starts BruceControl with its own data folder and database (`--home`, `--db`), so `BRUCE_COMM_HOME` and
`BRUCE_COMM_DB` apply to the helper too.

Files under `<home>/pc-control/` (`<home>` is the data directory, `~/.bruce-comm` by default):

- `helper.sock`: directory mode 0700, socket 0600; only processes of your own user may connect. BruceControl always
  listens here, at the data folder's real path (symlinks resolved; on macOS `/tmp` and `/var` are `/private/tmp` and
  `/private/var`). That full path must stay under 104 bytes (a macOS limit), so keep the data folder path short; a
  longer one gives a `pc_helper_error` that says so before BruceControl is started.
- `state.json`: a read-only copy of BruceControl's Keychain state (mode 0600). BruceControl never reads it.
- `thumbs/`: the action log thumbnails.

Outside the data directory: the login-Keychain item "Bruce Control state" (service `com.bruce.comm.pccontrol`, account
`state`) and the per-user lock `~/Library/Application Support/com.bruce.comm.pccontrol/instance.lock`. Helper builds
before 1.1.0 kept a key under account `state-hmac-key`; it is no longer used, and you can delete it in Keychain Access.

### Residual risks

- **The allowlist guards against agent mistakes and casual misuse, not against malicious programs.** Any program running
  under your macOS account can claim an enabled agent's id (by setting `BRUCE_AGENT_ID`) or talk to the helper's socket
  directly, and act as that agent while it is switched on. Starting its own BruceControl for another data folder or
  database gives it no grants: the Keychain state is bound to both, so that helper sees none, and each new grant needs
  your Touch ID. Switch agents off when you are done: that removes the grant.
- **What protects the grants:** the Touch ID prompt, whose text BruceControl writes itself and which names the agent, and
  the Keychain item's access list: macOS asks before an app other than BruceControl reads it, so deny such prompts.
  Whether another program running as you can replace or delete the item without a prompt has not been verified.
  Deleting it removes the grants; the stop then rests on the database and on a running BruceControl's memory.
- **The hard stops are:** the kill switch (held in BruceControl's memory, in the Keychain and in the database; lifting it
  needs Touch ID), the Touch ID prompts for switching agents on, and the macOS permissions themselves. Switching
  BruceControl off in System Settings ends all PC control at the system level.
- **A stop or switch-off that BruceControl was not told about** ("BruceControl was not told" in the dashboard, a WARNING
  in the CLI) lives only in the database until BruceControl next starts. A program that edits the database back before
  then undoes it. Stop again once BruceControl runs, or press ⌃⌥⌘K.
- **An enabled agent can do whatever you can do with mouse and keyboard**: send mail, delete files, approve things. It
  also reads whatever is on screen, so text on a web page or in a mail can talk it into something (prompt injection).
  Switch agents on only while you watch, keep ⌃⌥⌘K in mind, and switch them off when done.
- **Screenshots leave the Mac.** They go to the model behind the MCP client. Close or hide private windows first.
- **The log is plain files.** Typed text (up to 500 characters) and thumbnails are stored unencrypted in your data
  directory. Do not let agents type passwords.

### PC control troubleshooting

Errors reach agents as `Error [<code>]` with a hint; the REST API answers with the HTTP status shown.

| Code | HTTP | Meaning |
|---|---|---|
| `unsupported_platform` | 501 | Not macOS. |
| `pc_control_refused` | 403 | No pre-bound identity, agent not registered, or an unattended runner session. |
| `pc_not_allowed` | 403 | The agent is not switched on, or BruceControl has no Touch ID grant for it. |
| `pc_killed` | 409 | The kill switch is on. |
| `pc_permission_missing` | 409 | BruceControl lacks Accessibility or Screen Recording (the message names which). |
| `pc_auth_failed` | 403 | Touch ID / password failed or was canceled; nothing changed. |
| `pc_helper_busy` | 409 | Another Touch ID prompt from BruceControl is already open. |
| `pc_helper_missing` | 503 | BruceControl.app is not installed. |
| `pc_helper_not_running` | 503 | BruceControl is not running and was not started (launching off, or it did not open its socket within 8 s). |
| `pc_helper_timeout` | 504 | No answer in time (30 s by default; Touch ID requests 120 s). |
| `pc_helper_error` | 502 | Anything else from or about the helper: another data folder, an outdated build, waiting for the Keychain, socket path too long. |
| `pc_stop_failed` | 500 | A stop or switch-off reached neither the database nor BruceControl. |

**`pc_helper_missing`.** BruceControl.app is not at `~/Applications/BruceControl.app` (or `BRUCE_PC_HELPER_APP`). Run
`npm run build:helper` in the Bruce Comm folder. If the app is there but never starts, open it once from Finder to see
whether macOS blocks it, and rebuild if it does.

**`pc_permission_missing`.** The message names the permission (Accessibility or Screen Recording). Switch BruceControl on
under System Settings > Privacy & Security. After a rebuild, remove BruceControl from the list and add it again. If it
still fails, quit the helper from its menu bar item; the next call starts it again.

**`pc_killed`.** The kill switch is on (perhaps ⌃⌥⌘K pressed by accident). `pc_status` and the dashboard show who
stopped it and when. Lift it with **Re-enable (Touch ID)** in the dashboard or *Re-enable PC control…* in the menu bar.

**`pc_not_allowed`.** The agent is not switched on, or BruceControl has no Touch ID grant for it: its Keychain state was
missing, unreadable or saved for another data folder (the panel's *Helper grant* column then says "not granted"). Switch
the agent off and on again in the dashboard's PC control panel.

**`pc_control_refused`.** The session has no pre-bound identity: add `BRUCE_AGENT_ID` (stdio) or `?agent=<id>` (HTTP) to
the client's config, restart the client and make sure the agent is registered. In a runner session this is by design:
PC control needs an attended window.

**"BruceControl is running for another Bruce Comm data folder"** (`pc_helper_error`). Only one BruceControl runs per
macOS user, and the running one serves another data folder or database. When it does not answer on this folder's socket
at all, the call fails after about 8 s with "running, but not for this Bruce Comm data folder". Either way, quit it from
its menu bar item; the next PC action starts it for this folder. **"an outdated build"**: run `npm run build:helper`,
then quit the running BruceControl.

**"waiting for Keychain approval"** (`pc_helper_error`). BruceControl is still reading its state, usually because a
Keychain prompt is waiting for you (often hidden behind other windows). Answer it, allowing it only when it names
BruceControl, then retry.

**"waiting for the Bruce Comm database"** (`pc_helper_error`). BruceControl could not read the Bruce Comm database for
its startup check (busy or locked) and keeps retrying; switching an agent on or re-enabling also waits for it (up to
20 s) before any Touch ID prompt. Retry in a moment; if it persists, check that the daemon is not stuck and quit and
restart BruceControl from its menu bar.

**`pc_helper_busy`.** A Touch ID prompt from BruceControl is already open (another switch-on or re-enable). Finish or
cancel it, then try again.

**"BruceControl was not told" / `pc_stop_failed`.** The stop or switch-off is in the database, but BruceControl could not
be reached; it applies it when it next starts. `pc_stop_failed` means the database write failed as well: press ⌃⌥⌘K or
use *Stop all PC control* in the menu bar, then retry.

**"socket path is too long"** (`pc_helper_error`). The data folder path, with symlinks resolved, is too long for a macOS
socket (104 bytes in all). BruceControl always listens on `<data folder>/pc-control/helper.sock`, so use a shorter
`BRUCE_COMM_HOME` / `--home`; `BRUCE_PC_HELPER_SOCKET` does not help (it only changes where Bruce Comm connects).

**What did the helper do?** See the unified-log command under [Action log](#action-log).

**Clicks land in the wrong place.** Coordinates refer to the last screenshot's display. Take a fresh `pc_screenshot`
after changing resolution or plugging in or rearranging monitors, and use `pc_zoom` rather than guessing small targets.

## CLI reference

`bruce-comm <command> [options]`. Global options: `--json` (machine-readable output), `--home <dir>` (data directory),
`-h` / `--help`. `bruce-comm help <command>` shows a command's options. Human commands work directly on the database: no
daemon is needed. Writes act as the reserved actor `human`.

| Command | What it does |
|---|---|
| `serve [--port n] [--host 127.0.0.1] [--token secret]` | Run the HTTP daemon: MCP at `/mcp`, REST at `/api`, dashboard at `/`. |
| `stdio [--agent-id id] [--runner-task task-id]` | Serve one MCP session over stdin/stdout (what clients launch). Nothing but protocol on stdout. `--runner-task` is set by the runner for the CLI it starts (a one-shot session for that task). |
| `runner [--config file] [--only id,id] [--once]` | Process tasks with headless agent CLIs from `runners.json`. |
| `runner init [--force]` / `runner check` | Write the example `runners.json` (all entries disabled) / diagnose it. |
| `status` | Queue and agent overview, session counts, daemon state. |
| `agents` | List registered agents (presence, sessions, skills, flags). |
| `agent <id>` | One agent card: instructions, skills, queue counters, connected sessions. |
| `sessions [--agent id] [--all]` | Connected sessions (windows, app instances, runners); `--all` adds closed ones. |
| `close-session <S-id>` | Close a stale session. Pinned work goes to the agent's other sessions; work in progress is re-queued. Uses the daemon when it is running, so it can also disconnect an HTTP client. |
| `tasks [--status s,s] [--agent id] [--role sent\|inbox\|assigned\|all] [--limit n]` | List tasks, newest first. |
| `task <id>` | One task with its full history. |
| `send (--to <agent\|*> \| --skill s \| --broadcast) --title T [--body B \| --body-file F] [--input JSON] [--priority n] [--message] [--wait secs] [--expires-in secs] [--session S-id \| --workspace path\|name]` | Send a task or message as the human, optionally to one window. `--wait` blocks until it is settled. |
| `cancel <id> [--reason text]` | Cancel an unfinished task. |
| `answer <id> <text>` | Answer an agent's question on an `input_required` task. |
| `note <id> <text>` | Add a note to a task's history. |
| `pending` | Tasks waiting for your approval. |
| `approve <id> [--note text]` / `deny <id> [--reason text]` | Approve or refuse a held task. `approve` also accepts a queued task from an agent that nobody approved yet, which an approval-gated agent could otherwise never claim (for example skill-routed work queued before its recipient turned approval on). |
| `agent-set <id> [--require-approval true\|false] [--accept-from a,b\|*] [--max-concurrent n] [--status online\|busy\|away\|offline]` | Change an agent's settings as the human (only the human can switch approval off). |
| `unregister <agent-id>` | Remove an agent. Its tasks are canceled if only it could do them, otherwise re-queued. An agent that requires approval can only be removed here or in the dashboard, never through MCP. |
| `purge [--days 7]` | Delete finished tasks older than N days. |
| `config <client\|all> [--transport stdio\|http] [--port n] [--agent-id id]` | Print ready-to-paste client config. |
| `install <client> [--transport stdio\|http] [--agent-id id] [--port n] [--yes] [--dry-run] [--config-file path]` | Merge the entry into the client's config file (with a backup). |
| `doctor` | Check Node, database, daemon port, token, runner config, agent CLIs and client configs; suggest the next step. |
| `pc-control status` / `pc-control stop` | PC control (macOS): kill switch, helper, permissions and agents (`--json` for JSON) / engage the kill switch: written to the database and sent to BruceControl, which is started if needed (up to 10 s). It prints a WARNING when BruceControl could not be told or the database could not be written; a repeated stop keeps the first who/when. No CLI command switches agents on or lifts the stop; that needs Touch ID in the dashboard. |
| `version`, `help [command]` | Version, help. |

Exit code 1 on errors, with a one-line message and a hint (`BRUCE_COMM_DEBUG=1` adds stack traces).

## MCP tools reference

Every tool accepts an optional `agent_id` meaning *you, the caller* (in `get_agent` and `list_sessions` it names the agent to
look up instead). Errors come back as `Error [<code>]: <message>` plus a `Hint:` line.

| Tool | Use it to |
|---|---|
| `register_agent` | Create or update your profile (patch semantics), set your status, label this window (`session_label`, `session_workspaces`); binds the session. |
| `unregister_agent` | Remove your profile for good (to go offline for a while, set `status="offline"` instead). Refused for an agent that requires approval, and in a pre-bound window for agents other than its own and the ones it registered. |
| `list_agents` | Find agents by skill, platform or text, with presence, sessions and whether they accept you. |
| `get_agent` | Read an agent's full card, instructions and live sessions before sending it work. |
| `bruce_status` | Who you are (or how to register), this session, your counters and tasks, queue stats, dashboard URL, your wait cap. |
| `send_task` | Queue a task or message to an agent, `"*"`, a skill or everyone; optionally to one window; optionally wait. |
| `get_task` | Full details and history of one task. |
| `list_tasks` | Tasks you sent (`role=sent`), your inbox, tasks assigned to you, or all; filter by status, thread, kind. |
| `wait_for_result` | Block until tasks you sent are finished or asking you a question (`mode` all / any). |
| `cancel_task` | Withdraw a task you sent. |
| `reply_to_task` | Answer the question on a task you sent (it resumes), or add a note to a task you take part in. |
| `get_next_task` | Claim your next task and receive messages; long-polls with `wait_seconds`. |
| `update_task_progress` | Report progress and renew the lease. |
| `request_input` | Ask the sender a question; the task pauses. |
| `complete_task` | Finish with a self-contained `result` and optional `result_data` JSON. |
| `fail_task` | Report failure; `retry=true` re-queues while attempts remain. |
| `reject_task` | Decline permanently (not your job, out of scope, unsafe). |
| `release_task` | Hand a task back unchanged without using an attempt. |
| `list_sessions` | Live sessions (windows) of all agents or one, with client, label, workspaces; `this_is_you` marks yours. |
| `pc_status` | PC control: whether you are allowed, whether it is stopped, helper and permission state, displays, how to get access. |
| `pc_screenshot` | Take a downscaled screenshot of one display (image content, scale stated, all displays listed). |
| `pc_zoom` | See part of the last screenshot at higher resolution (scale per axis, `kx` / `ky`, stated). |
| `pc_click` | Click at screenshot pixel coordinates (button, 1-3 clicks, modifiers). |
| `pc_mouse_move` | Move the pointer to screenshot pixel coordinates. |
| `pc_drag` | Drag along a path of 2-50 points on one display. |
| `pc_scroll` | Scroll up, down, left or right at a point. |
| `pc_type` | Type text into the focused field. |
| `pc_key` | Press a key or combo (`cmd+s`, `Return`; Mac shortcuts use `cmd`). |
| `pc_open_app` | Start or activate an app by name or bundle id. |
| `pc_open_url` | Open an http/https URL, optionally in a given app. |
| `pc_list_windows` | List windows (id, app, title, bounds) and the frontmost app. |
| `pc_focus_window` | Bring a window or app to the front. |
| `pc_cursor_position` | Pointer position in screen points and screenshot pixels. |

**PC control tools (`pc_*`, macOS).** They take **no `agent_id`**: they act only as the session's pre-bound identity
(`BRUCE_AGENT_ID`, `--agent-id`, `?agent=`, `X-Bruce-Agent`), only for agents you switched on in the dashboard, and
never in unattended runner sessions. Coordinates are pixels of the last screenshot's display. Details in
[PC control](#pc-control-computer-use-macos).

**Long-poll caps.** `get_next_task`, `wait_for_result` and `send_task(wait_seconds)` block for at most 50 s in most clients,
because Claude Desktop, Codex and Cursor's agent CLI cut tool calls off at about 60 s even while progress notifications
flow. VS Code and Claude Code calls that carry a progress token may block up to 300 s (progress is sent every 10 s).
`BRUCE_COMM_MAX_WAIT_SECONDS` overrides the cap for every client. `bruce_status` shows the cap that applies.

## Resources & prompts

| Resource | Type | Content |
|---|---|---|
| `bruce://guide` | Markdown | The full protocol guide for agents. |
| `bruce://agents` | JSON | The agent directory. |
| `bruce://sessions` | JSON | Live sessions of all agents. |
| `bruce://agents/{agent_id}` | Markdown | One agent's card, including instructions. |
| `bruce://tasks/{task_id}` | JSON | A task and its history. |
| `bruce://inbox/{agent_id}` | JSON | What an agent could claim now and what it is working on. |

All resources are subscribable (`notifications/resources/updated` when their content changes); the resource list
changes when agents register or leave.

| Prompt | Arguments | Purpose |
|---|---|---|
| `bruce_worker_mode` | `agent_id`*, `skills`, `platform` | Register (or update) and loop forever: get a task, do it, report, repeat. |
| `bruce_delegate` | `goal`*, `to_agent` | Find the right agent, read its instructions, send a self-contained task, wait, report back. |
| `bruce_register` | `agent_id`, `platform` | Write an excellent profile (especially the instructions) and register it. |

## Security model

Bruce Comm assumes **one trusted user on one machine**. Its job is to stop other machines, web pages and
over-eager or misled agents from misusing the queue.

### Trust model

- **Identity is claimed, not proven.** An agent is whoever it says it is: the `agent_id` it passes, or the id its
  client config pre-binds. There are no per-agent credentials. That fits what Bruce Comm is for: cooperating agents,
  all started by you, on your own computer.
- **What the guards are for:** mistakes, runaway loops and agents talked into something by text they received:
  - the approval gate is human-only: approving, denying, switching `require_approval` off and removing an agent that
    has it on exist only in the dashboard, the CLI and the REST API, never as MCP tools;
  - a pre-bound window (`BRUCE_AGENT_ID`, `?agent=`) keeps its own identity: a call that names another agent acts for
    that call only, and the window can change or unregister only its own agent and agents it created, so one
    manipulated client cannot rewrite or remove the other agents' profiles (task calls in another agent's name still
    work: the `vscode-chat` runner relies on them);
  - `accept_from` limits who may send an agent work;
  - rate, queue, delegation-depth and broadcast limits stop agents that delegate in circles or flood each other;
  - provenance wrapping marks everything another agent wrote as a request, not as an instruction from you.
- **What they do not protect against:** a malicious process running under your account. It can pass any `agent_id`,
  open the database file directly, or act as the human through the CLI or the REST API (it can read the token from
  the same places your clients do). Anything you can do, it can do. Your Windows account is the trust boundary, and the
  database is an unencrypted SQLite file in your profile.

### Protections

- **Loopback only.** The daemon binds only `127.0.0.1`, `localhost` or `::1`; any other `--host` is refused.
- **DNS-rebinding and cross-site protection.** The `Host` header must name a loopback address *with the daemon's port*,
  otherwise 403. An `Origin` header, when present, must be the same loopback origin. Requests a browser marks as
  `Sec-Fetch-Site: cross-site` / `same-site` are refused on `/api` and `/mcp`.
- **Optional token.** With `BRUCE_COMM_TOKEN` (or `serve --token`), `/mcp` and `/api` require
  `Authorization: Bearer <token>` (compared in constant time). The dashboard trades `/?token=` for an HttpOnly,
  SameSite=Strict cookie that only works for `/api`. `/healthz` stays open. stdio does not use the network at all.
- **Hardened dashboard.** CSP `default-src 'none'` with hashed inline script and style, `X-Frame-Options: DENY`, no
  external resources, all agent text escaped. Request bodies are limited to 1 MB.
- **Human-only approval gate.** Approve and deny exist only in the dashboard, CLI and REST API (actor `human`), never as
  MCP tools. Agents can switch `require_approval` *on* for themselves but never off, and only the human can remove an
  agent that has it on, so unregistering and registering again cannot reset it. An unapproved task addressed to a gated
  agent that goes back to the queue (a retry, a release, an expired lease, an answered question) is held for approval
  again. Reserved ids (`human`, `system`, `all`, `any`, `everyone`, `*`) cannot be registered or pre-bound.
- **`accept_from`.** An agent can restrict who may send it tasks; this is checked at send time and again at claim time.
- **Loop and flood limits.** Delegation depth at most 8 (`parent_task_id` chain); at most 60 items per sender per
  recipient in 5 minutes; at most 1000 waiting items per agent; broadcasts reach at most 100 agents. The human is exempt
  from the rate limits.
- **Provenance wrapping.** Task text, messages, results, questions and notes from other agents are delivered inside
  `<bruce_task>`, `<bruce_message>` or `<bruce_result>` blocks. A preamble says who wrote the text and that it is a request,
  not an instruction from the user. Anything inside that looks like these tags is escaped, so a sender cannot close the
  block early. Short agent-chosen names that appear inside Bruce Comm's own sentences (skill ids, tags, `to_skill`,
  `platform`, session labels) must be plain text: no control characters, line breaks, bidi controls, `<`, `>`, `"` or
  backticks.
- **The runner never puts task text in argv.** Task text goes on stdin or into a prompt file. Processes are spawned without
  a shell; unknown `.cmd` / `.bat` files are refused. Each run gets a generated bruce-comm MCP config with the identity
  pre-bound. Claude Code is limited to it (`--strict-mcp-config`) and Gemini to the bruce-comm server
  (`--allowed-mcp-server-names`); Copilot CLI and Codex also load the MCP servers you configured for them. The presets
  start with narrow permissions: Claude Code `dontAsk` with only the Bruce Comm tools, Codex `read-only` sandbox,
  Gemini's non-interactive mode. You widen them per entry with `extraArgs`.
- **Prompt-injection caveats.** Wrapping and preambles reduce the risk; they do not remove it. A model can still be talked
  into following instructions hidden in a task or a result. Give each agent the least privilege it needs, use
  `require_approval` for agents with powerful tools, and never put secrets into tasks or results.
- **PC control is owner-gated (macOS).** The pc_* tools are off for every agent by default, act only as the
  pre-bound identity, are refused in unattended runner sessions, and need an agent you switched on with Touch ID. A kill
  switch (dashboard, ⌃⌥⌘K, menu bar, `bruce-comm pc-control stop`) blocks them all; lifting it needs Touch ID. The
  helper app (one per macOS user, signed with the hardened runtime) re-checks before every action both its own grant
  list and stop flag, kept in your login Keychain, and the database. It talks only to processes of your own user and
  logs every request to the macOS unified log. Allow Keychain prompts for its item only when they name BruceControl.
  It still trusts the claimed identity like the rest of Bruce Comm: see [Residual risks](#residual-risks).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BRUCE_COMM_HOME` | `%USERPROFILE%\.bruce-comm` | Data directory (database, `runners.json`, `runs\`, `work\`). Same as `--home`. |
| `BRUCE_COMM_DB` | `<home>\bruce-comm.db` | Database file. |
| `BRUCE_COMM_PORT` | `7457` | Daemon port (also used for the dashboard URL and generated HTTP configs). Same as `serve --port`. |
| `BRUCE_COMM_HOST` | `127.0.0.1` | Bind address; only `127.0.0.1`, `localhost` or `::1` are accepted. |
| `BRUCE_COMM_TOKEN` | none | Shared secret for `/mcp` and `/api`. Same as `serve --token`. |
| `BRUCE_AGENT_ID` | none | Pre-binds a stdio session to this agent id (same as `stdio --agent-id`). |
| `BRUCE_COMM_RUNNER_TASK` | none | Set by the runner for the CLIs it starts: the stdio session is a one-shot session for that task (same as `stdio --runner-task`). |
| `BRUCE_COMM_MAX_WAIT_SECONDS` | per client (50 / 300) | Longest a long-poll may block, for every client (5-3600). |
| `BRUCE_COMM_DEBUG` | off | `1` prints stack traces for CLI errors. |
| `BRUCE_COMM_CLIENT_CONFIG_DIR` | none | Redirects `install` / `doctor` to `<dir>\<client>\<file>` instead of the real client configs (for testing). |
| `CODEX_HOME`, `COPILOT_HOME` | `%USERPROFILE%\.codex`, `%USERPROFILE%\.copilot` | Respected when locating those clients' config files. |
| `BRUCE_PC_HELPER_APP`, `BRUCE_PC_HELPER_SOCKET`, `BRUCE_PC_HELPER_NO_LAUNCH`, `BRUCE_PC_MAX_LONG_EDGE`, `BRUCE_PC_MAX_PIXELS` | see [PC control](#environment-variables) | PC control helper location and screenshot limits (macOS). |

HTTP clients can pre-bind with `/mcp?agent=<id>` or the header `X-Bruce-Agent: <id>`.

Data directory layout: `bruce-comm.db` (plus `-wal` / `-shm`), `runners.json`, `runs\<task>-<attempt>-<claim time>\`
(per-run prompt and MCP config, deleted afterwards unless `keepRunFiles`), `runs\workspace-restore-*.json` (originals of
workspace config files a runner has changed; replayed by the next start if the runner was killed), `work\<agent-id>\`
(default runner working directory). Keep the
data directory outside `AppData`: stdio servers started by a Microsoft Store Claude Desktop see a virtualized copy of
`AppData` (`doctor` warns about this).

## Troubleshooting

**Claude Desktop does not pick up the config.** On a Microsoft Store (MSIX) install the real file is
`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json`. The documented
`%APPDATA%\Claude` path only exists inside the app's container, and the app's "Edit Config" button may open the wrong
file. `bruce-comm install claude-desktop` finds the right one. Also check:

- Quit Claude Desktop from the tray *before* editing; it rewrites the file on exit.
- Run `install` from a normal terminal. Writes to `AppData` from processes started inside Claude Desktop (including its
  bundled Claude Code) are virtualized, so the app never sees them.
- Read `<config folder>\logs\mcp-server-bruce-comm.log`.

**Tool calls time out.** Long-polls are capped at 50 s for most clients; Claude Desktop and Codex stop calls after about
60 s, and some Claude Desktop builds after 4 minutes. If a client still times out:

- Ask the agent to use `wait_seconds=25`, or set `BRUCE_COMM_MAX_WAIT_SECONDS=25` in that client's `env` block.
- Codex: the generated config sets `tool_timeout_sec = 120`.
- `bruce_status` shows the cap in effect and whether the client sent a progress token.

**Gemini CLI is slow to start.** Startup plus MCP discovery can take 30-60 s. The generated client config sets
`"timeout": 600000`. For the runner preset use `timeoutSeconds` of at least 120 (`runner check` warns). Hidden or
non-TTY launches need `GEMINI_CLI_NO_RELAUNCH=true`; the runner sets it. Log in once interactively first.

**Port 7457 is in use.** `bruce-comm doctor` tells you whether the port is free. Use `bruce-comm serve --port 7460` (or
`BRUCE_COMM_PORT`) and regenerate HTTP client configs with `config` / `install --port 7460`, since the port is part of the
URL. stdio clients do not depend on the port.

**`Error [not_registered]`.** The session has no registered identity. Pre-binding (`BRUCE_AGENT_ID`, `?agent=`) only
names the session; the agent must call `register_agent` once with `instructions`. If the agent was removed in the
dashboard or with `bruce-comm unregister`, register again. In a new session, pass `agent_id` on the first call.

**Stale sessions.** Each process that hosts sessions heartbeats them every 30 s. The sweeper closes a session when:

- its host process has exited and its heartbeat is more than 45 s old (so usually within about a minute);
- no host process is recorded and it has had no heartbeat for 120 s;
- its host process still runs but has not heartbeated for 6 hours (a hung host).

A stale heartbeat alone does not close a session whose host is still running (the machine slept, the process stalled):
after 120 s it only counts as not connected (tasks pinned to it may go to other windows meanwhile), and it is connected
again with its host's next heartbeat. A session closed for a missing heartbeat is reopened the same way. If Windows
gave a crashed host's PID to another process, its sessions linger like this for up to 6 hours; close them yourself.

Closing re-queues the session's work in progress (on its last attempt the task fails instead) and releases tasks pinned
to it. To see and close sessions yourself: `bruce-comm sessions --all`, `bruce-comm close-session S-...`, or the
dashboard. A closed stdio connection stays open in its client until that client exits, so restart that window; an HTTP
client is disconnected by the daemon.

**Tasks are not delivered.** `bruce-comm agent <id>` shows what the agent can claim, what is pinned to another
session or workspace, and what awaits approval. Look for:

- an agent at its `max_concurrent_tasks`;
- a sender that is not in the recipient's `accept_from`;
- a recipient with `require_approval`: its tasks wait for you (`bruce-comm pending`, then `approve`);
- a `to_workspace` that no open window matches (`send_task` warns about this).

**Tools missing in VS Code or Visual Studio.** Reload the MCP servers. In VS Code allow the tools; in Visual Studio enable
them in the Copilot Chat tool picker, where they are off by default.

## Robustness

- **Sleep and resume.** A session whose host process is still running is closed only after 6 hours without a
  heartbeat, so work in progress is not re-queued while the machine sleeps. A session that was closed for a missing
  heartbeat comes back as soon as its host heartbeats again. Tasks pinned to a window that stopped heartbeating do not
  wait for it: after 120 s another window with the same workspace (any window, if none was recorded) may take them.
- **Ghost long-polls.** When an HTTP client drops a request (crash, reload, network error), the daemon cancels it as if
  the client had sent `notifications/cancelled`. A `get_next_task` cut short this way hands back the task it had claimed
  and the messages it had taken.
- **Approval.** Only the human can switch `require_approval` off or remove an agent that has it on (dashboard, REST API,
  CLI), so another agent cannot reset it by unregistering and registering that agent again. Unapproved tasks that come
  back to such an agent's queue are held again, and work nobody could claim unapproved (skill-routed or `"*"` work when
  every willing agent requires approval) is held at send time instead of waiting forever.
- **Runner.** A run ends when the CLI exits, even if a background process keeps its output pipes open, and timeouts and
  kills always end it. A question (`request_input`) ends the run, and the answer starts a new one. Each claim gets its
  own run directory. Workspace config the runner merged is restored after a crash or a hard kill. `where.exe` and
  `taskkill.exe` are started from `System32`.

## Limitations

- **No push into chats.** Interactive agents only work while a worker-mode loop runs in an open window. Use the runner
  for real background processing.
- **At-least-once delivery.** A task can be delivered again after an expired lease or a crash. Workers should check the
  attempt number and history before repeating side effects.
- **One machine, one user.** There is no networking between machines, no per-agent authentication, and no encryption at
  rest.
- **Workspaces need roots or a declaration.** Clients that do not support MCP roots report no folders; the agent must
  pass `session_workspaces`.
- **The `cursor-agent` and `vscode-chat` presets are experimental.** `vscode-chat` cannot return output; the Copilot
  agent must call `complete_task`.
- **Size limits:**

  | Field | Limit |
  |---|---|
  | Title | 300 chars |
  | Body | 100,000 chars |
  | Instructions | 20,000 chars |
  | Result | 200,000 chars |
  | Notes and questions | 20,000 chars |
  | JSON payloads | 200,000 chars |
  | HTTP request body | 1 MB |
  | Captured runner output | 1 MB per stream |

- **Housekeeping is manual.** Finished tasks stay until you run `bruce-comm purge`.
- **Experimental SQLite module.** `node:sqlite` is still experimental in Node; its warning is suppressed.

## Architecture

The components, the data model, the task state machine, session routing, delivery semantics and cross-process wake-up
are covered in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Source map: `src/store` (queue and data model), `src/mcp` (tools, resources, prompts), `src/transports` (stdio, HTTP),
`src/dashboard` (REST API, SSE, page), `src/runner` (headless runner), `src/cli.ts` and `src/clients.ts` (CLI, client
configs), `src/pccontrol` (PC control: tools, policy, geometry, log) and `native/macos/BruceControl` (the macOS helper,
built by `scripts/build-pc-helper.sh`).
