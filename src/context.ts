import { loadConfig, type BruceConfig } from './config.js';
import { openDatabase } from './db.js';
import { ChangeNotifier } from './notifier.js';
import { BruceStore } from './store/store.js';

/** Everything a transport, the CLI or the runner needs. One per process. */
export interface BruceContext {
  config: BruceConfig;
  store: BruceStore;
  notifier: ChangeNotifier;
  /** Diagnostics go to stderr - stdout belongs to the MCP stdio protocol. */
  log: (message: string) => void;
  close: () => void;
}

export function createContext(overrides: Partial<BruceConfig> = {}, options: { quiet?: boolean } = {}): BruceContext {
  const config = loadConfig(overrides);
  const db = openDatabase(config.dbPath);
  const store = new BruceStore(db);
  const notifier = new ChangeNotifier(store);
  let closed = false;
  if (!options.quiet) tolerateBrokenStderr();
  return {
    config,
    store,
    notifier,
    log: options.quiet ? () => {} : writeDiagnostic,
    close: () => {
      if (closed) return;
      closed = true;
      notifier.close();
      db.close();
    },
  };
}

/** One diagnostic line on stderr. Never throws: diagnostics are best effort. */
function writeDiagnostic(message: string): void {
  try {
    process.stderr.write(`[bruce-comm] ${message}\n`);
  } catch {
    // stderr is gone (the client closed its end): nothing to report to
  }
}

let stderrGuarded = false;

/**
 * Keep the process alive when stderr breaks: a client that closes the read end of our stderr pipe (EPIPE) would
 * otherwise turn the next diagnostic line into an uncaught 'error' event. Idempotent.
 */
export function tolerateBrokenStderr(): void {
  if (stderrGuarded) return;
  stderrGuarded = true;
  process.stderr.on('error', () => {
    // nothing sensible to do: diagnostics are best effort
  });
}
