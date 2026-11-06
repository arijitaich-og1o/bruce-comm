import { dataVersion } from './db.js';
import { sleep } from './util.js';
/**
 * Wakes long-polls and subscribers when the queue changes.
 *
 * Local mutations (made through this process's BruceStore) are delivered instantly. Mutations by
 * OTHER processes sharing the database (stdio servers spawned by each client, the runner, the HTTP
 * daemon) are detected by polling `PRAGMA data_version`, which only changes when another connection
 * commits. Listeners then receive an empty change (taskIds/agentIds unknown) and should re-check.
 */
export class ChangeNotifier {
    store;
    pollMs;
    listeners = new Set();
    unsubscribeStore;
    timer = null;
    lastVersion;
    constructor(store, pollMs = 400) {
        this.store = store;
        this.pollMs = pollMs;
        this.lastVersion = dataVersion(store.db);
        this.unsubscribeStore = store.onChange((change) => this.fire(change));
    }
    /** Subscribe to every change (local or cross-process). Returns an unsubscribe function. */
    subscribe(listener) {
        this.listeners.add(listener);
        this.ensurePolling();
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0)
                this.stopPolling();
        };
    }
    /** Resolve on the next change, after `timeoutMs`, or when `signal` aborts - whichever is first. */
    waitForChange(timeoutMs, signal) {
        if (signal?.aborted)
            return Promise.resolve('aborted');
        return new Promise((resolve) => {
            const controller = new AbortController();
            const unsubscribe = this.subscribe(() => finish('change'));
            const onAbort = () => finish('aborted');
            signal?.addEventListener('abort', onAbort, { once: true });
            sleep(timeoutMs, controller.signal).then(() => finish('timeout'));
            let done = false;
            function finish(outcome) {
                if (done)
                    return;
                done = true;
                unsubscribe();
                controller.abort();
                signal?.removeEventListener('abort', onAbort);
                resolve(outcome);
            }
        });
    }
    /**
     * Repeatedly run `attempt` until it returns a non-null value, the deadline passes or the signal
     * aborts. Re-checks on every change and at least every `recheckMs` (covers time-based transitions
     * such as delayed tasks becoming due and leases expiring). `onTick` runs on each wake-up so
     * callers can send MCP progress notifications that keep client request timeouts alive.
     */
    async pollUntil(attempt, options) {
        const started = Date.now();
        const deadline = started + Math.max(0, options.timeoutMs);
        const recheckMs = options.recheckMs ?? 5000;
        for (;;) {
            const value = attempt();
            if (value !== null)
                return value;
            const remaining = deadline - Date.now();
            if (remaining <= 0 || options.signal?.aborted)
                return null;
            const outcome = await this.waitForChange(Math.min(remaining, recheckMs), options.signal);
            if (outcome === 'aborted')
                return null;
            options.onTick?.(Date.now() - started);
        }
    }
    close() {
        this.stopPolling();
        this.unsubscribeStore();
        this.listeners.clear();
    }
    fire(change) {
        for (const listener of [...this.listeners]) {
            try {
                listener(change);
            }
            catch {
                // one bad listener must not starve the others
            }
        }
    }
    ensurePolling() {
        if (this.timer)
            return;
        this.lastVersion = dataVersion(this.store.db);
        this.timer = setInterval(() => {
            let version;
            try {
                version = dataVersion(this.store.db);
            }
            catch {
                return;
            }
            if (version !== this.lastVersion) {
                this.lastVersion = version;
                this.fire({ taskIds: [], agentIds: [] });
            }
        }, this.pollMs);
        this.timer.unref();
    }
    stopPolling() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
}
//# sourceMappingURL=notifier.js.map