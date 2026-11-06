// pc_open_app name -> app resolution (src/pccontrol/apps.ts). Real-folder checks run on macOS only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AppResolver, appSearchDirs, checkAppName, looksLikeBundleId } from '../dist/pccontrol/apps.js';

const MAC = process.platform === 'darwin';

function fakeApps(apps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-apps-'));
  const dirs = ['a', 'b'].map((d) => path.join(root, d));
  dirs.forEach((d) => fs.mkdirSync(d));
  for (const [dir, name, id] of apps) {
    const contents = path.join(dirs[dir], `${name}.app`, 'Contents');
    fs.mkdirSync(contents, { recursive: true });
    if (id) {
      fs.writeFileSync(
        path.join(contents, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>\n`,
      );
    }
  }
  return { root, dirs };
}

test('search folders include CoreServices (Finder) after the usual app folders', () => {
  const dirs = appSearchDirs('/Users/x');
  assert.equal(dirs[0], '/Applications');
  assert.ok(dirs.includes('/Users/x/Applications'));
  assert.ok(dirs.includes('/System/Library/CoreServices'));
  assert.ok(dirs.includes('/System/Library/CoreServices/Applications'));
  assert.ok(dirs.indexOf('/System/Applications') < dirs.indexOf('/System/Library/CoreServices'), 'regular apps win');
});

test('names vs bundle ids vs paths', () => {
  assert.equal(looksLikeBundleId('com.apple.finder'), true);
  assert.equal(looksLikeBundleId('Finder'), false);
  assert.equal(looksLikeBundleId('Visual Studio Code'), false);
  assert.equal(looksLikeBundleId('Finder.app'), false, '.app suffix is a name');
  assert.equal(checkAppName('  TextEdit '), 'TextEdit');
  for (const bad of ['', '   ', '/Applications/Finder.app', '../x', '.hidden', 'a\0b', 'x'.repeat(256)]) {
    assert.throws(() => checkAppName(bad), /invalid_argument|App name/, JSON.stringify(bad).slice(0, 40));
  }
});

test('fake folders: case-insensitive match, first folder wins, bundle id read from Info.plist', async () => {
  const { root, dirs } = fakeApps([
    [0, 'Alpha', 'com.example.alpha'],
    [1, 'Alpha', 'com.example.alpha.second'],
    [1, 'Beta Tool', 'com.example.beta'],
    [1, 'NoPlist', null],
  ]);
  try {
    const r = new AppResolver({ dirs });
    assert.equal(await r.target('alpha'), 'com.example.alpha');
    assert.equal(await r.target('ALPHA.app'), 'com.example.alpha');
    assert.equal(await r.target('Beta Tool'), 'com.example.beta');
    assert.equal(await r.target('NoPlist'), 'NoPlist', 'no readable bundle id: the name goes to the helper unchanged');
    assert.equal(await r.target('Missing'), 'Missing', 'unknown names pass through (the helper reports not_found)');
    assert.equal(await r.target('com.example.direct'), 'com.example.direct', 'bundle ids are not looked up');
    assert.deepEqual(await r.find('nope'), null);
    await assert.rejects(() => r.target('../Alpha'), /App name/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real Mac: Finder and other CoreServices apps resolve to their bundle ids', { skip: !MAC }, async () => {
  const r = new AppResolver();
  assert.equal(await r.target('Finder'), 'com.apple.finder');
  assert.equal(await r.target('finder'), 'com.apple.finder');
  if (fs.existsSync('/System/Library/CoreServices/Applications/Archive Utility.app')) {
    assert.equal(await r.target('Archive Utility'), 'com.apple.archiveutility');
  }
  if (fs.existsSync('/System/Applications/TextEdit.app')) {
    assert.equal(await r.target('TextEdit'), 'com.apple.TextEdit');
  }
  const finder = await r.find('Finder');
  assert.equal(finder?.path, '/System/Library/CoreServices/Finder.app');
});
