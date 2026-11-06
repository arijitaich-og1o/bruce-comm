// Fake headless CLI that asks a question. Arguments: <mcpConfigFile> <promptFile> <taskId> <agentId>.
// First run (no answer in the prompt): connects to Bruce Comm as written in the runner's {mcpConfigFile}, calls
// request_input, then keeps running for $LINGER_MS (default 60000) ms instead of stopping - like a CLI that goes on
// polling. Its PID is written to $PID_FILE.
// Resumed run (the prompt holds the answer "ANSWER-42"): reads its run files after $RESUME_DELAY_MS (default 1000) ms,
// like a real CLI loading its MCP config / prompt file during startup, then prints "RESUMED with ANSWER-42".
// Started only by the test suite (BRUCE_TEST_FIXTURE=1); `node --test` executing this file directly is a no-op.
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.env.BRUCE_TEST_FIXTURE !== '1') process.exit(0);

const [mcpConfigFile, promptFile, taskId, agentId] = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');

if (!prompt.includes('ANSWER-42')) {
  if (process.env.PID_FILE) fs.writeFileSync(process.env.PID_FILE, JSON.stringify({ child: process.pid }));
  const entry = JSON.parse(fs.readFileSync(mcpConfigFile, 'utf8')).mcpServers['bruce-comm'];
  const client = new Client({ name: 'fake-ask-agent', version: '0.0.1' });
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...process.env, ...(entry.env ?? {}) }, stderr: 'ignore' }));
  const asked = await client.callTool({ name: 'request_input', arguments: { agent_id: agentId, task_id: taskId, question: 'Which port?' } });
  await client.close();
  process.stdout.write(`asked a question (isError=${asked.isError ?? false})\n`);
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.LINGER_MS ?? 60000)));
  process.stdout.write('still here\n');
  process.exit(0);
}

await new Promise((resolve) => setTimeout(resolve, Number(process.env.RESUME_DELAY_MS ?? 1000)));
try {
  fs.readFileSync(mcpConfigFile, 'utf8');
  fs.readFileSync(promptFile, 'utf8');
} catch (err) {
  process.stderr.write(`cannot read my run files: ${err.message}\n`);
  process.exit(2);
}
process.stdout.write('RESUMED with ANSWER-42\n');
