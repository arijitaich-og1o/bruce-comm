# Bruce Comm architecture

How Bruce Comm is put together: processes, the data model, the task state machine, sessions and routing, delivery
guarantees, cross-process wake-up and the security design. For setup and usage see the [README](../README.md).

## 1. Components and process model

```
   MCP clients                         Bruce Comm processes                         storage
   -----------                         --------------------                         -------
   Claude Desktop  --stdio-->  bruce-comm stdio  (one per client connection) --+
   VS Code         --stdio-->  bruce-comm stdio                               |
   Gemini CLI      --stdio-->  bruce-comm stdio                               +-->  bruce-comm.db
   Cursor          --HTTP--->  bruce-comm serve  (/mcp, /api, /, /healthz)  --+     (SQLite, WAL)
   browser         --HTTP--->      (dashboard + REST + SSE)                   |
                               bruce-comm runner (spawns headless CLIs)     --+
                               bruce-comm <cli command> (human, one-shot)   --+
```

There is no central broker. **The SQLite database is the single source of truth**, and every process opens it directly.
Any number of processes can run at once: one stdio server per client connection, at most one daemon per port, any
number of runners, and the CLI commands.

| Component | Source | Role |
|---|---|---|
| Store | `src/store/store.ts`, `types.ts`, `src/db.ts` | All state and rules: agents, sessions, tasks, events, routing, leases, limits. Every mutation runs in a `BEGIN IMMEDIATE` transaction. |
| Notifier | `src/notifier.ts` | Wakes long-polls and subscribers on local changes at once, and on other processes' commits by polling `PRAGMA data_version` every 400 ms. |
| Context | `src/context.ts`, `src/config.ts` | One per process: config, store, notifier, a stderr logger. |
| MCP layer | `src/mcp/*` | `createBruceServer()` builds one `McpServer` per connection with 19 tools, 6 resources and 3 prompts, and links the connection to a session row. |
| stdio transport | `src/transports/stdio.ts` | Serves one MCP session on stdin/stdout. Exits when stdin closes or stdout breaks. Sweeps every 15 s. |
| HTTP daemon | `src/transports/http.ts`, `src/dashboard/*` | Streamable HTTP MCP at `/mcp` (stateful sessions), REST API at `/api`, SSE at `/api/events`, dashboard at `/`. Sweeps every 5 s. |
| Runner | `src/runner/*` | Registers runner agents, claims their tasks through a `runner` session, spawns headless CLIs, supervises and reports. |
| CLI | `src/cli.ts`, `bin/bruce-comm.js` | Human commands straight on the database, plus `serve`, `stdio`, `runner`. |
| Client configs | `src/clients.ts` | Config snippets and the merging installer for 12 MCP clients. |

## 2. Data model

Four tables (`PRAGMA user_version` = 4 after migrations 1-4). JSON columns are stored as text. Timestamps are epoch
milliseconds; the MCP layer renders ISO-8601.

**`agents`**: one row per registered agent ("agent card").

| Column | Notes |
|---|---|
| `id` | Primary key; lower-case, 2-64 chars `[a-z0-9._-]`, starting with a letter or digit. Reserved: `human`, `system`, `all`, `any`, `everyone`, `*`. |
| `name`, `description`, `platform`, `instructions` | Profile. `instructions` is required. |
| `skills`, `tags` | JSON. Skill ids, skill tags and agent tags (lower-cased) are the routing keys for `to_skill`. |
| `accept_from` | JSON list of allowed senders; `["*"]` by default. |
| `max_concurrent` | Maximum tasks in `working` at once (default 3). |
| `require_approval` | Tasks to this agent wait for the human. Agents can only switch it on. |
| `owner`, `workspace`, `version`, `metadata` | Informational. |
| `status`, `status_message` | Self-declared availability: `online` / `busy` / `away` / `offline`. |
| `registered_at`, `updated_at`, `last_seen_at`, `listening_until` | Liveness. `listening_until` is set during a long-poll. |

Presence is derived, from most to least reachable:

| Presence | Condition |
|---|---|
| `listening` | `listening_until` is in the future |
| `active` | seen in the last 2 minutes |
| `connected` | has at least one connected session |
| `idle` | seen in the last 30 minutes |
| `offline` | none of the above |

**`sessions`** (migration 2): one row per MCP connection or runner.

| Column | Notes |
|---|---|
| `id` | `S-` + 8 Crockford base32 characters. |
| `agent_id` | Bound agent, or null until the connection identifies itself. |
| `transport` | `stdio`, `http` or `runner`. |
| `client_name`, `client_version` | From the MCP `initialize` handshake (runner: `bruce-comm-runner`). |
| `label` | Set by the agent (`register_agent(session_label)`); runner: `<preset> runner`. |
| `workspaces` | JSON list of normalised folders: MCP roots plus `session_workspaces` (declared first). At most 20. |
| `host_pid` | PID of the Bruce Comm process hosting the connection (liveness check). |
| `started_at`, `heartbeat_at`, `last_active_at`, `listening_until` | Liveness. |
| `closed_at`, `close_reason` | Set once closed. |

`connected` = not closed and heartbeat younger than 120 s. `listening` = `listening_until` in the future.

**`tasks`**: tasks *and* messages (`kind`).

| Column | Notes |
|---|---|
| `id` | `T-XXXXXXXXXX` for tasks, `M-XXXXXXXXXX` for messages. Lookups are case-insensitive. |
| `kind`, `from_agent`, `to_agent`, `to_skill` | Routing. Exactly one of `to_agent` (an id; null with no skill means "any agent") / `to_skill` / broadcast. |
| `title`, `body`, `input` | The request (`input` is JSON). |
| `priority` | 0-9, default 5. |
| `depth`, `parent_task_id`, `thread_id` | Delegation chain (depth at most 8) and conversation thread. |
| `broadcast_id`, `idempotency_key` | Fan-out group; de-duplication key as the sender gave it, unique per sender and recipient (migration 4), so every copy of a broadcast keeps the same key. |
| `requires_approval`, `approved_by` | Approval gate. |
| `status`, `status_message`, `progress` | State machine (section 3). |
| `assignee`, `lease_seconds`, `lease_expires_at`, `attempts`, `max_attempts`, `claimed_at` | Claim and lease. |
| `result`, `result_data`, `error`, `result_seen` | Outcome; `result_seen` drives the sender's `results_ready` counter. |
| `from_session` | Session that sent it (migration 3), used for reply routing. |
| `to_session`, `to_workspace` | Session pinning (migration 2). |
| `resume_session` | Marks a `to_session` pin added when an answered task waits for the window that asked (migration 4); dropped with the pin when that reservation ends. |
| `assignee_session` | Session that claimed it. |
| `created_at`, `updated_at`, `not_before`, `expires_at`, `completed_at` | Scheduling and timing. |

**`task_events`**: an append-only history per task (`seq`, `task_id`, `at`, `actor`, `type`, `message`, `data`). Event types:
`created`, `claimed`, `delivered`, `progress`, `input_requested`, `input_provided`, `completed`, `failed`, `retrying`,
`rejected`, `released`, `lease_expired`, `canceled`, `expired`, `approved`, `denied`, `rerouted`, `note`. Workers receive
this history with every delivery, so a retried or resumed task shows what already happened.

## 3. Task state machine

```
                     send (recipient requires approval, or requires_approval=true; never for the human)
                       |
                       v
              +-------------------+   deny (human)
              | awaiting_approval |----------------------------------------------> rejected
              +-------------------+
                       | approve (human)
                       v
  send ------->   +----------+ <------------------------------------------------------------+
                  |  queued  | <-------------------------------------------+               |
                  +----------+                                             |               |
                       | claimNext (attempts + 1, lease starts)           |               |
                       v                                                   |               |
                  +----------+  update_task_progress (renews the lease)    |               |
         +------- | working  | ------------------------------+             |               |
         |        +----------+                               |             |               |
         |          |  |  |  \_ release / its session closed -+-> queued    |               |
         |          |  |  |     (release does not use an attempt)          |               |
         |          |  |  \_ lease expired, attempts left -----------------+               |
         |          |  \_ fail(retry=true), attempts left ------------------+               |
         |          |                                                                       |
         |          | request_input                                                         |
         |          v                                                                       |
         |   +----------------+  reply_to_task / answer (sender or human):                 |
         |   | input_required | -- re-queued, reserved for the same assignee and session ---+
         |   +----------------+    (does not use an attempt)
         |
         +--> complete_task ............................................> completed
         +--> fail_task (no retry, or no attempts left) ................> failed
         +--> lease expired on the last attempt ("giving up") ..........> failed
         +--> its session closed on the last attempt ("giving up") .....> failed
         +--> reject_task ..............................................> rejected

  queued or awaiting_approval, never claimed, expires_at passed .......> expired
  any non-terminal state, cancel by the sender or the human ...........> canceled
  message: queued --delivered by get_next_task--> completed (no result, no questions)
```

- Terminal states: `completed`, `failed`, `canceled`, `rejected`, `expired`.
- `complete_task`, `fail_task`, `reject_task` and `release_task` are also accepted while a task is `input_required`.
- Expiry (`expires_in_seconds`) only applies to a task nobody has claimed yet. A task that was claimed once and came back
  to the queue (answered question, retry, release, expired lease) never expires.
- Held at send time: tasks to an agent that requires approval, tasks sent with `requires_approval=true`, and skill-routed
  or `"*"` tasks when every agent that could take them requires approval. Never tasks from the human.
- When an agent switches `require_approval` on, its unapproved queued tasks from other agents move to
  `awaiting_approval`. An unapproved task addressed to such an agent that goes back to the queue later (re-queue,
  release, expired lease, closed session, answered question) goes to `awaiting_approval` instead of `queued`.
- `approve` also accepts a `queued` task from an agent that nobody approved: it stays queued, now approved, so an
  approval-gated agent may claim it (for example skill-routed work queued before that agent turned its gate on).
- Unregistering an agent cancels tasks addressed only to it and re-queues tasks it held that others may take (or fails
  them on their last attempt).

## 4. Identity, sessions and routing

### Identity

Every tool call resolves the caller in this order: the call's `agent_id` argument, then the session's binding, otherwise
`not_registered`. A successful call with an explicit, registered `agent_id` binds the session, and so does
`register_agent`. Transports can pre-bind:

- stdio: `--agent-id` or env `BRUCE_AGENT_ID`;
- HTTP: `/mcp?agent=<id>` or header `X-Bruce-Agent`.

Pre-bound ids are validated, so a reserved or malformed id is refused at connect time. The binding is mirrored into the
session row. In a pre-bound session, an explicit `agent_id` naming another agent acts for that call only and does not
rebind the session (a VS Code window completing a task its `vscode-chat` runner agent claimed stays the window's own
agent); `register_agent` still rebinds.

A pre-bound session also remembers its **configured agent** (`configuredAgentId`, fixed even when `register_agent`
rebinds the window) and the agents it registered itself. It may change or remove only those profiles:
`register_agent` naming another existing agent binds the window without changing that profile (profile fields are
refused with `not_allowed`, and a create that races another registration does not overwrite it), and
`unregister_agent` for such an agent is refused. Task operations are not restricted. Sessions without a pre-bound id
keep the claim-based rules. Profile changes and removals made through MCP are logged with the session that made them.

A session the runner opens for a headless CLI is also marked as a one-shot **runner child** of its task (stdio
`--runner-task <id>` or env `BRUCE_COMM_RUNNER_TASK`, HTTP `&runner_task=<id>`). It gets no work-loop instructions or
`get_next_task` nudges, and `get_next_task` is refused there: the CLI works on that one task, and the runner restarts it
when an answer to its question arrives.

### Session lifecycle

Each MCP connection has a `SessionLink` (`src/mcp/sessions.ts`) that keeps its session row up to date:

1. **Open**: when the server is created (`openSession`, agent from the pre-binding, `host_pid` = this process).
2. **Handshake**: after `initialized`, record `clientInfo` name and version. If the client supports roots, call
   `roots/list` in the background and store the root URIs as workspaces:
   - stdio clients are asked at once, HTTP clients 1 s later (the request must travel on the client's GET stream);
   - the client has 5 s to answer. A failed request is retried with the next tool call (at once after the first
     failure, 30 s later after the second); after 3 failures in a row the session stops asking;
   - roots are listed again on `notifications/roots/list_changed`.
3. **Liveness**: one process-wide timer heartbeats every open session of the process every 30 s. Every tool call
   refreshes `last_active_at` and the heartbeat, and a `get_next_task` long-poll sets `listening_until`.
4. **Close**: when the connection closes (`onclose`), or a heartbeat tick finds the server disconnected twice, or
   the human closes the session (`close-session`, dashboard), or the sweeper finds it gone. The sweeper looks at open
   sessions whose heartbeat is more than 45 s old (1.5 heartbeat intervals) and closes:
   - a session whose host process has exited (`host process exited`), so usually within about a minute of the exit;
   - a session with no recorded host process once its heartbeat is more than 120 s old (`no heartbeat`);
   - a session whose host process is still running only after 6 hours of silence (a hung host, `no heartbeat`).

   A stale heartbeat alone therefore does not close the session of a live host (the machine slept, the clock jumped,
   the process stalled): after 120 s the session only stops counting as connected (its pins stop binding, see Routing
   rules), and the host's next heartbeat or tool call makes it connected again. A session closed with `no heartbeat`
   is reopened the same way; nothing that was re-queued or un-pinned when it closed is routed back. Sessions closed for
   any other reason stay closed.

Closing a session releases its work:

- Unfinished items pinned to it lose `to_session` and keep `to_workspace` (event `rerouted`).
- Tasks it was `working` on go back to `queued`. The attempt counts, since the conversation holding it is gone; on the
  last attempt the task fails instead, so a task that keeps killing its worker's host cannot cycle forever.
- Paused or queued tasks keep their assignee agent but lose the session affinity.

The runner opens one `runner` session per runner agent (workspace = its `cwd`) and re-opens it if someone closes it. On
start it closes sessions left behind by a crashed runner process for the same agent. The CLI that a runner spawns
connects through its own stdio session (a one-shot runner child, see Identity), so it shows up as a second session of
the same agent. When that CLI asks a question (`request_input`), the runner ends the run within 10 s, at once if the
answer is already there, and reports nothing for it. The answer re-queues the task reserved for the runner's session,
which starts it again in a new run.

### Routing rules

A task or message is claimable by agent **A** through session **S** when all of these hold:

```
kind matches  AND status = 'queued'
AND (not_before IS NULL OR not_before <= now)
AND (expires_at IS NULL OR claimed_at IS NOT NULL OR expires_at > now)   -- a deadline only until the first claim
AND ( assignee = A                                          -- reserved for A (e.g. answered question)
      OR ( assignee IS NULL AND
           ( to_agent = A
             OR ( to_agent IS NULL AND from_agent <> A       -- "*" or skill-routed, never your own
                  AND (to_skill IS NULL OR to_skill IN routing_keys(A)) ) ) ) )
AND ( to_session = S                                        -- pinned to this window
      OR ( (to_session IS NULL OR NOT connected(to_session))  -- a pin binds only while its window is connected
           AND (to_workspace IS NULL OR to_workspace IN session_keys(S)) ) )
AND (from the human OR sender allowed by A.accept_from)
AND (NOT A.require_approval OR from the human OR approved)
```

- `routing_keys(A)` = A's skill ids, skill tags and agent tags (lower-case).
- `session_keys(S)` = each normalised workspace path, its last folder name, and the lower-cased label. Normalisation
  lower-cases, turns `\` into `/`, removes trailing slashes and decodes `file:///c%3A/...` URIs, so
  `C:\Src\Shop`, `c:/src/shop/` and `file:///c%3A/src/shop` are the same key.
- `connected(X)` = session X is open and heartbeated within the last 120 s, the same test `list_sessions` and
  `send_task(to_session)` use. While the pinned session is connected, only it may take the item, whatever its
  workspaces or label are by now: the `to_workspace` stored next to the pin is only the fallback.
- While the pinned session is not connected (a hung or sleeping host, which the sweeper keeps open for up to 6 hours)
  the item behaves as unpinned: its `to_workspace`, if any, decides which sessions may take it. A claim through
  another session drops the pin and records a `rerouted` event; if nobody takes it, the pin binds again as soon as
  the session heartbeats or makes a call. Closing the session removes the pin for good.
- The sender and approval checks are part of the query, so items A may not receive never crowd out the ones it may.
- Claim order: tasks reserved for A first, then higher priority, then oldest. A claim is refused while A already holds
  `max_concurrent_tasks` working tasks (the reason is returned).
- A caller without a session (`S` unknown) can only claim work with no `to_workspace` and no binding pin.

**`send_task` routing:**

- `to_session` must be a *connected* session of the target agent; otherwise the error lists the agent's live sessions.
  The session's first workspace, or else its label, is stored as the fallback `to_workspace`.
- `to_workspace` is normalised and stored. A warning is returned if no connected session matches yet.
- Both require a specific `to_agent`, not `"*"`.

**Reply routing** (no explicit `to_session` / `to_workspace`, with `parent_task_id`):

- Sending to the parent's *sender* targets `parent.from_session`, the window that asked.
- Sending to the parent's *assignee* targets `parent.assignee_session`, the window that did the work.
- If that session is no longer connected, only its workspace (or label) is used as `to_workspace`.

**Answers:** `provideInput` re-queues the task reserved for the same assignee and, if the asking session is still
connected and the sender set no pin of its own, pins it to that session. This resume pin (`resume_session`) is
temporary: it is dropped when the task is claimed, goes back to the open queue, or that session closes. The answer
does not use up an attempt, and a gated recipient's unapproved task is held for approval first.

**Attention counters** (`pendingCounts(agent, session)`) are per session:

- `tasks` and `messages` count only what this session could claim.
- `questions_for_you` and `results_ready` count tasks sent from this session. Tasks sent without a session, or from a
  session that is closed or no longer connected, count in every session of the agent.

## 5. Delivery semantics

| Property | Behaviour |
|---|---|
| Guarantee | **At least once.** A claim is a lease. If the worker vanishes, the task is delivered again. Workers see `attempt N/M` and the full history, and must not repeat side effects blindly. |
| Lease | `lease_seconds` default 900 (allowed 30 s to 24 h). `update_task_progress` renews it. The runner renews it every `min(lease/2, 60 s)` (at least every 5 s) while the CLI runs. |
| Lease expiry | The sweeper re-queues the task (`lease_expired`) if `attempts < max_attempts`; otherwise it is **dead-lettered**: status `failed` with "Lease expired on attempt N of M without completion; giving up." |
| Attempts | `max_attempts` default 3 (at most 20). Each claim adds one. `release_task`, answering a question and a `get_next_task` canceled before the reply was seen do not count; `fail_task(retry=true)`, lease expiry and the worker's session closing do. |
| Retries | `fail_task(retry=true)` re-queues while attempts remain; the next delivery shows "Previous attempt failed with: ...". Runner entries retry only with `retryOnFailure: true`. |
| Dead letter | There is no separate queue. Exhausted tasks end as `failed` with the reason in `error`. The sender sees them through `results_ready` / `wait_for_result`, the human through `bruce-comm tasks --status failed` or the dashboard. |
| Expiry | `expires_in_seconds` means "expire if nobody claims it in time": a task still `queued` or `awaiting_approval` at `expires_at` that was never claimed becomes `expired`. Once claimed, the deadline no longer applies, even when the task comes back to the queue. |
| Delay | `delay_seconds` sets `not_before`; the task is invisible until then. |
| Ordering | By priority, then FIFO within a priority. Tasks reserved for the claimant come first. |
| Idempotency | A send whose `idempotency_key` the sender already used returns the original task(s) with `deduplicated: true` and queues nothing. Every copy of a broadcast stores the key exactly as given; the unique index is on `(from_agent, idempotency_key, to_agent)`. |
| Messages | Delivered once: `takeMessages` marks them `completed` in the same transaction (up to 20 per fetch). |
| Atomicity | Claims run `UPDATE ... WHERE id=? AND status='queued'` inside `BEGIN IMMEDIATE`, so two processes can never claim the same task. |
| Sweeping | Expired leases, unclaimed expiry and stale sessions are swept inside every claim and message fetch. Reads sweep at most once per second per process; the daemon sweeps every 5 s, each stdio server every 15 s. |
| Limits | Per sender and recipient: 60 items / 5 min. At most 1000 waiting items per agent, 100 broadcast recipients, depth 8. The human is exempt from the rate limits. |

## 6. Cross-process notification and long-polling

- **Local changes:** the store emits `{taskIds, agentIds}` after each committed mutation. The notifier fans that out
  to long-polls, resource subscriptions and the SSE hub at once.
- **Other processes:** while anyone is subscribed, the notifier polls `PRAGMA data_version` every 400 ms. The value
  changes only when *another* connection commits. Listeners then get an empty change and re-check. In practice a task
  sent from one client wakes a long-poll in another process within about half a second.
- **Long-polls** (`ToolCall.longPoll`) re-check on every change and at least every 3 s, which covers time-based
  transitions such as delays and lease expiry. `get_next_task` does a cheap read-only count first and a full claim
  transaction at most every 2.5 s, so unrelated activity costs no write locks.
- **Wait caps:**
  - `BRUCE_COMM_MAX_WAIT_SECONDS` (5-3600), if set, applies to every client;
  - otherwise 300 s for VS Code and Claude Code calls that carry a progress token;
  - otherwise 50 s (Claude Desktop, Codex and the Cursor agent CLI end calls at about 60 s regardless of progress).
- **Progress:** with a progress token, `notifications/progress` is sent at once and then every 10 s.
- **Cancellation:** if the client cancels a `get_next_task` that had already claimed a task or taken messages, the task
  is released (without using an attempt) and the messages go back to the queue. The HTTP daemon treats a dropped
  response (client crashed, reloaded or lost the connection) as `notifications/cancelled` for every request of that
  POST, so a ghost long-poll stops at once and hands back anything it had taken.
- **Resource subscriptions:** subscribed URIs are re-rendered on change (150 ms debounce), and
  `notifications/resources/updated` is sent only when the content hash changed. `notifications/resources/list_changed`
  follows agent registrations and removals (1 s debounce).
- **Dashboard:** `GET /api/events` is an SSE stream. It sends a `hello` event, then `change` events with
  `{taskIds, agentIds}` and a comment heartbeat every 20 s. The page falls back to polling every 5 s.
- **Runner:** waits on the notifier for up to 30 s at a time and refreshes its `listening` presence every 30 s
  (90 s TTL).

## 7. Storage and concurrency

- `node:sqlite` with `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`.
- Every write path uses `transaction()`, which runs `BEGIN IMMEDIATE` and so takes the write lock up front. Nested calls
  join the outer transaction.
- Migrations run under `BEGIN IMMEDIATE`, so concurrent first starts never apply one twice.
- A busy database surfaces to agents as `Error [busy]` with "Retry in a moment".

## 8. MCP response format

- **Success:** `content: [{type: "text", text}]`. The text is a one-line headline, then any provenance-wrapped blocks of
  agent-written content, then pretty JSON metadata with null and empty values dropped, then an optional nudge line.
- **Agent-written text stays inside the wrapped blocks.** Task titles, bodies, inputs, results, questions and notes appear
  only there, not in the JSON; `list_tasks` previews are the one exception. The blocks are `<bruce_task>`,
  `<bruce_message>` and `<bruce_result>`; anything inside that looks like these tags is escaped.
- **Footer:** when the caller is known, the JSON carries
  `_bruce: {you, tasks, messages, working, waiting_for_answer, questions_for_you, results_ready, awaiting_approval}`.
- **Errors:** `isError: true` with `Error [<code>]: <message>` and `Hint: <hint>`. Handlers never throw.
- **Schemas:** no `outputSchema` or `structuredContent`, so strict client-side validators cannot reject results.
  Every tool sets `title` and annotations.

## 9. Security design

- **Trust boundary:** the Windows user account. Identities are claimed; there is no per-agent authentication. The
  guards below keep cooperating agents from mistakes and manipulation (see the README's
  [Trust model](../README.md#trust-model)). Anything that can reach the loopback port (with the token, if one is set)
  or open the database file can act as any agent, and as the human.
- **Network surface:** only the daemon listens, and only on loopback (`127.0.0.1`, `localhost`, `::1`; anything else is
  refused at config load). `RequestGuard` checks every request:
  - `Host` must be a loopback name *with the daemon's port* (DNS rebinding);
  - `Origin`, when present, must be one of those origins;
  - `Sec-Fetch-Site: cross-site` / `same-site` is refused on `/api` and `/mcp`;
  - with a token, `/mcp` needs `Authorization: Bearer`, and `/api` accepts Bearer or the `bruce_token` cookie (HttpOnly,
    SameSite=Strict, 30 days), set by `/?token=` followed by a 303 to `/`. Token comparison is constant-time;
  - bodies are limited to 1 MB (413; the rest of the upload is drained so the client sees the response);
  - at most 1000 concurrent MCP sessions; idle ones are reaped after 30 min without requests or an open stream.
- **Dashboard:** a static string with a CSP of `default-src 'none'` plus SHA-256 hashes for its inline style and script,
  `X-Frame-Options: DENY`, COOP/CORP, a Permissions-Policy, no `innerHTML` and no external resources.
- **Human-only powers:** approve, deny, switching `require_approval` off and removing an agent that has it on exist
  only on the REST API, CLI and dashboard, all acting as `human`; purge only in the CLI. They are not MCP tools
  (`unregister_agent` refuses an agent that requires approval, so unregistering and registering again cannot reset the
  setting). Unapproved tasks re-queued to a gated agent are held again (section 3).
- **Abuse limits:** `accept_from`, rate and queue limits, delegation depth and broadcast caps (section 5).
- **Prompt-injection mitigation:** provenance preambles and escaped wrapper blocks for all agent-written text. Workers
  are told that such content is a request, not an instruction from their user. This reduces the risk; it does not remove
  it.
- **Runner process safety:**
  - task text only ever goes through stdin or a prompt file, never argv or a shell;
  - processes are spawned with `shell: false` and `windowsHide: true`;
  - `.cmd` / `.bat` files are refused unless they are recognised npm or VS Code shims, which are resolved to the real
    executable;
  - `where.exe` and `taskkill.exe` are started by their `System32` path: Windows searches the current directory before
    `PATH`, so a bare name would run a copy planted in the folder the runner was started from;
  - each run gets a generated bruce-comm MCP config with the identity pre-bound and the runner-child marker. Claude Code
    is restricted to it (`--strict-mcp-config`) and Gemini to that server (`--allowed-mcp-server-names`; the file takes
    the place of Gemini's system settings, the highest precedence, with the machine's own system settings copied in);
    Copilot CLI and Codex add it to the user's own MCP servers. Presets start with narrow permissions;
  - output is captured up to 1 MB per stream, and on timeout or cancel the whole process tree is killed
    (`taskkill /T /F`; process group on POSIX);
  - a run ends when the CLI exits: its pipes are awaited for at most 2 s more, because a background process it started
    can hold them open indefinitely. A kill that does not make the process exit still ends the run after 5 s;
  - a run directory (`<home>/runs/<task>-<attempt>-<claimed_at>`) and the in-flight bookkeeping belong to one claim, so a
    resumed task never shares or deletes the files of a run that is still winding down;
  - Cursor's workspace `.cursor/mcp.json` is merged temporarily and restored after the run, on a second Ctrl+C or a
    crash (process `exit` hook), and after a hard kill by the next runner start from a restore record written before
    the file was changed. A leftover entry carrying the runner-child marker is never taken for the user's own. The file
    carries one run's identity and task marker, so runs in the same `cwd` hold a per-directory lock in turn (process
    wide, first come first served); a waiting run is supervised like a running one (lease renewed, cancel ends the
    wait).
- **stdout hygiene:** in stdio mode only MCP protocol goes to stdout; all diagnostics go to stderr. The launcher
  suppresses only the `node:sqlite` ExperimentalWarning.

## 10. REST API

All routes are under the daemon (`http://127.0.0.1:7457`). JSON in and out. Errors look like
`{error: {code, message, hint}}` with status 400 / 401 / 403 / 404 / 405 / 409 / 413 / 415 / 429. Writes act as `human`.

| Method and path | Purpose |
|---|---|
| `GET /healthz` | `{ok, name, version}` (no token needed). |
| `GET /api/status` | Version, URLs, pid, `db_path`, `token_required`, live MCP / SSE counts, queue `stats`. |
| `GET /api/events` | SSE: `hello`, then `change` events; heartbeat every 20 s. |
| `GET /api/agents` | Agents with presence and sessions, plus `unregistered_sessions`. |
| `GET /api/agents/:id` | One agent, its sessions and its 20 most recent tasks. |
| `PATCH /api/agents/:id` | `{require_approval?, accept_from?, max_concurrent_tasks?, status?}` as the human. |
| `DELETE /api/agents/:id` | Unregister (404 if already gone). |
| `GET /api/sessions?agent=&include_closed=1&limit=` | Sessions (default: connected only). |
| `GET /api/sessions/:id` | One session. |
| `DELETE /api/sessions/:id` | Close it; if this daemon hosts the MCP connection, disconnect it too. Returns `{session, already_closed, disconnected}`. |
| `GET /api/tasks?status=&agent=&role=&thread=&kind=&limit=` | Compact rows (`body_preview`, `has_input`, `has_result`). `status` takes a comma list or `active` / `terminal`; `role` is `all`, `sent`, `inbox`, `assigned` or `to`; `limit` defaults to 100 (max 500). |
| `POST /api/tasks` | `{to_agent \| to_skill \| broadcast, kind?, title, body?, input?, priority?, expires_in_seconds?, delay_seconds?, thread_id?, idempotency_key?, lease_seconds?, max_attempts?, to_session?, to_workspace?}`. 201, or 200 when de-duplicated. |
| `GET /api/tasks/:id` | Task and events. |
| `POST /api/tasks/:id/cancel` | `{reason?}` |
| `POST /api/tasks/:id/input` | `{answer, data?}`: answer a question. |
| `POST /api/tasks/:id/notes` | `{note, data?}` |
| `POST /api/tasks/:id/approve` | `{note?}` |
| `POST /api/tasks/:id/deny` | `{reason?}` |

## 11. File layout

```
Bruce Comm/
  bin/bruce-comm.js          launcher: hides the node:sqlite warning, imports dist/cli.js, exits with its code
  src/
    cli.ts                   all CLI commands (parseArgs), tables / --json output, doctor
    clients.ts               client catalogue, config snippets, merging installer, daemon probe / REST helper
    config.ts  context.ts    configuration (env + overrides), per-process context
    db.ts                    open (WAL, pragmas), migrations 1-4, transaction(), data_version
    notifier.ts              ChangeNotifier: subscribe / waitForChange / pollUntil
    util.ts                  ids, ISO times, BruceError(code, message, hint)
    store/types.ts           domain types, statuses, LIMITS, reserved ids
    store/store.ts           BruceStore: agents, sessions, send, claim, report, sweep, stats, routing SQL
    mcp/server.ts            createBruceServer(): wires tools, resources, prompts, session link, lifecycle hooks
    mcp/tools/*.ts           agents.ts (register/unregister/list/get/status), sending.ts, working.ts, sessions.ts
    mcp/runtime.ts           ToolRuntime / ToolCall: identity, binding, long-poll, progress, footer, error format
    mcp/sessions.ts          SessionLink: session row per connection, roots, heartbeat, close
    mcp/format.ts            rendering, provenance wrapping, escaping
    mcp/identity.ts          caller resolution
    mcp/instructions.ts      server instructions, guide resource text, wait caps
    mcp/resources.ts         bruce:// resources, subscriptions
    mcp/prompts.ts           bruce_worker_mode, bruce_delegate, bruce_register
    transports/stdio.ts      stdio server
    transports/http.ts       HTTP daemon: guard, MCP session manager, routing, sweeper
    dashboard/api.ts         REST routes
    dashboard/events.ts      SSE hub
    dashboard/http-util.ts   body limits, JSON / error helpers, cookies, constant-time compare
    dashboard/page.ts        the dashboard HTML (+ CSP hashes, favicon)
    runner/runner.ts         runRunners(): select entries, signals, start workers
    runner/config.ts         runners.json schema, placeholders, defaults
    runner/presets.ts        claude-code, copilot-cli, gemini-cli, codex, cursor-agent, vscode-chat, custom
    runner/worker.ts         RunnerWorker: session, presence, claim loop, execute, supervise, finish
    runner/spawn.ts          command resolution (PATH, npm / VS Code shims), runProcess, tree kill
    runner/prompt.ts         prompt = wrapped brief + runner footer
    runner/setup.ts          runner init (example file) and runner check
    runner/workspace.ts      temporary merge of workspace config files (Cursor), per-cwd lock, restore records
  dist/                      compiled output (npm run build)
  docs/                      this file, AGENT-GUIDE.md

%USERPROFILE%\.bruce-comm\   (BRUCE_COMM_HOME)
  bruce-comm.db (+ -wal, -shm)   the queue
  runners.json                   runner configuration
  runs\<task>-<attempt>-<claimed_at>\   per-run prompt.md, MCP config, output (deleted unless keepRunFiles)
  runs\workspace-restore-*.json  originals of workspace files a runner changed (replayed at the next runner start)
  work\<agent-id>\               default runner working directory
```
