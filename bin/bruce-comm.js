#!/usr/bin/env node
// Bruce Comm launcher - plain ESM so it works before/without a build of its own.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// node:sqlite emits an ExperimentalWarning on first use. Suppress ONLY that warning, and do it before
// anything imports node:sqlite: a static import of ../dist/cli.js would load node:sqlite before this
// code runs, so the CLI is imported dynamically below.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function emitWarning(warning, ...args) {
  const options = args[0];
  const type = typeof options === 'string' ? options : options && typeof options === 'object' ? options.type : undefined;
  const name = warning instanceof Error ? warning.name : type;
  const message = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
  if ((name === 'ExperimentalWarning' || type === 'ExperimentalWarning') && /sqlite/i.test(message)) return;
  return originalEmitWarning.call(process, warning, ...args);
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist', 'cli.js');
if (!fs.existsSync(entry)) {
  // stderr only: stdout belongs to the MCP protocol when a client launches "bruce-comm stdio".
  process.stderr.write(`Bruce Comm is not built yet: run npm install && npm run build in ${root}\n`);
  process.exit(1);
}

const { main } = await import(pathToFileURL(entry).href);
const code = await main(process.argv.slice(2));
process.exitCode = code;
// Exit even if a library left a handle open - but only after stdout/stderr have been flushed.
process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
