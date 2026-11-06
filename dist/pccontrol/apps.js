import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BruceError } from '../util.js';
/**
 * App name -> bundle id, resolved on the Node side so pc_open_app also finds apps outside the helper's own search
 * folders (Finder lives in /System/Library/CoreServices). The helper opens a bundle id through LaunchServices, so passing
 * one needs no helper change (a helper rebuild would make the owner re-grant its macOS permissions).
 */
/** Folders searched for "<name>.app", in order. */
export function appSearchDirs(home = os.homedir()) {
    return [
        '/Applications',
        '/Applications/Utilities',
        '/System/Applications',
        '/System/Applications/Utilities',
        path.join(home, 'Applications'),
        '/System/Library/CoreServices/Applications',
        '/System/Library/CoreServices',
    ];
}
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/;
const CACHE_MS = 60_000;
/** Throws invalid_argument for anything that is not a plain app name or bundle id (no paths). */
export function checkAppName(raw) {
    const name = raw.trim();
    if (!name || name.length > 255)
        throw new BruceError('invalid_argument', 'App name must be 1-255 characters.');
    if (name.includes('/') || name.startsWith('.') || name.includes('\0')) {
        throw new BruceError('invalid_argument', 'App name must be a plain name or bundle id, not a path.', 'For example "Finder", "TextEdit" or "com.apple.finder".');
    }
    return name;
}
export function looksLikeBundleId(name) {
    return BUNDLE_ID.test(name) && !/\.app$/i.test(name);
}
export class AppResolver {
    dirs;
    readBundleId;
    listings = new Map();
    results = new Map();
    constructor(options = {}) {
        this.dirs = options.dirs ?? appSearchDirs();
        this.readBundleId = options.readBundleId ?? plutilBundleId;
    }
    get searchDirs() {
        return this.dirs;
    }
    /**
     * What to send to the helper's open_app: the bundle id of the first matching "<name>.app" (case-insensitive) in the
     * search folders, else the name unchanged (a bundle id passes straight through; the helper reports not_found).
     */
    async target(raw) {
        const name = checkAppName(raw);
        if (looksLikeBundleId(name))
            return name;
        const match = await this.find(name);
        return match?.bundleId ?? name;
    }
    /** The matching app bundle (path + bundle id when readable), or null. */
    async find(raw) {
        const name = checkAppName(raw);
        const base = (/\.app$/i.test(name) ? name.slice(0, -4) : name).trim();
        if (!base)
            return null;
        const key = base.toLowerCase();
        const cached = this.results.get(key);
        if (cached && Date.now() - cached.at < CACHE_MS)
            return cached.value;
        let value = null;
        for (const dir of this.dirs) {
            const entry = this.list(dir).find((e) => e.toLowerCase() === `${key}.app`);
            if (!entry)
                continue;
            const appPath = path.join(dir, entry);
            let bundleId = null;
            try {
                bundleId = await this.readBundleId(appPath);
            }
            catch {
                bundleId = null;
            }
            value = { path: appPath, bundleId: bundleId && looksLikeBundleId(bundleId) ? bundleId : null };
            break;
        }
        this.results.set(key, { at: Date.now(), value });
        return value;
    }
    list(dir) {
        const cached = this.listings.get(dir);
        if (cached && Date.now() - cached.at < CACHE_MS)
            return cached.entries;
        let entries = [];
        try {
            entries = fs.readdirSync(dir).filter((e) => /\.app$/i.test(e));
        }
        catch {
            entries = [];
        }
        this.listings.set(dir, { at: Date.now(), entries });
        return entries;
    }
}
/** CFBundleIdentifier via /usr/bin/plutil (reads binary and XML plists); null when missing. */
export function plutilBundleId(appPath) {
    const plist = path.join(appPath, 'Contents', 'Info.plist');
    return new Promise((resolve) => {
        execFile('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { timeout: 2000 }, (err, stdout) => {
            const id = String(stdout ?? '').trim();
            resolve(err || !id ? null : id);
        });
    });
}
//# sourceMappingURL=apps.js.map