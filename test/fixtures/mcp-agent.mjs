// Fake headless agent that reports through MCP (resultFrom "mcp"): it starts the Bruce Comm stdio server exactly as
// written in the runner-generated {mcpConfigFile} (identity pre-bound), reports progress and calls complete_task.
// With $PROBE_FILE set it then also calls get_next_task - as a CLI following "call get_next_task" advice would - and
// writes what the server told it (instructions, reply texts) to that file as JSON.
// Arguments: <mcpConfigFile> <taskId> <agentId>.
// Started only by the test suite (BRUCE_TEST_FIXTURE=1); `node --test` executing this file directly is a no-op.
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.env.BRUCE_TEST_FIXTURE !== '1') process.exit(0);

const [mcpConfigFile, taskId, agentId] = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const entry = JSON.parse(fs.readFileSync(mcpConfigFile, 'utf8')).mcpServers['bruce-comm'];
const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...process.env, ...(entry.env ?? {}) }, stderr: 'inherit' });
const client = new Client({ name: 'fake-mcp-agent', version: '0.0.1' });
await client.connect(transport);
const tools = await client.listTools();
// No agent_id here: the identity comes from --agent-id in the generated config.
const progress = await client.callTool({ name: 'update_task_progress', arguments: { task_id: taskId, message: 'halfway', percent: 50 } });
const done = await client.callTool({
  name: 'complete_task',
  arguments: { agent_id: agentId, task_id: taskId, result: `MCP-DONE (${tools.tools.length} tools, prompt ${prompt.length} chars)` },
});
process.stderr.write(`progress isError=${progress.isError ?? false}; complete isError=${done.isError ?? false}\n`);
if (process.env.PROBE_FILE) {
  const text = (res) => res.content.map((c) => c.text ?? '').join('\n');
  const next = await client.callTool({ name: 'get_next_task', arguments: { wait_seconds: 0 } });
  const probe = { instructions: client.getInstructions(), progress: text(progress), complete: text(done), next: text(next), nextIsError: next.isError === true };
  fs.writeFileSync(process.env.PROBE_FILE, JSON.stringify(probe, null, 2));
}
await client.close();
process.stdout.write('this stdout must be ignored in mcp mode\n');
