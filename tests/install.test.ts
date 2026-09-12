import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAppBundle } from '../src/server/install.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'sim-remote-test-'));
}

test('finds a .app at the top level', () => {
  const d = scratch();
  mkdirSync(join(d, 'Kleinanzeigen.app'));
  expect(findAppBundle(d)).toBe(join(d, 'Kleinanzeigen.app'));
  rmSync(d, { recursive: true, force: true });
});

test('finds a .app inside an ipa-style Payload directory', () => {
  const d = scratch();
  mkdirSync(join(d, 'Payload', 'Thing.app'), { recursive: true });
  expect(findAppBundle(d)).toBe(join(d, 'Payload', 'Thing.app'));
  rmSync(d, { recursive: true, force: true });
});

test('ignores __MACOSX and dotfile noise', () => {
  const d = scratch();
  mkdirSync(join(d, '__MACOSX'), { recursive: true });
  mkdirSync(join(d, '.hidden.app'), { recursive: true });
  mkdirSync(join(d, 'Real.app'), { recursive: true });
  expect(findAppBundle(d)).toBe(join(d, 'Real.app'));
  rmSync(d, { recursive: true, force: true });
});

test('ignores nested .app bundles inside an outer app', () => {
  const d = scratch();
  mkdirSync(join(d, 'Outer.app', 'PlugIns', 'Inner.app'), { recursive: true });
  expect(findAppBundle(d)).toBe(join(d, 'Outer.app'));
  rmSync(d, { recursive: true, force: true });
});

test('throws a clear error when the archive holds no app bundle', () => {
  const d = scratch();
  writeFileSync(join(d, 'readme.txt'), 'nope');
  expect(() => findAppBundle(d)).toThrow(/no \.app bundle/i);
  rmSync(d, { recursive: true, force: true });
});

test('a .app file rather than a directory is not accepted', () => {
  const d = scratch();
  writeFileSync(join(d, 'Fake.app'), 'not a bundle');
  expect(() => findAppBundle(d)).toThrow(/no \.app bundle/i);
  rmSync(d, { recursive: true, force: true });
});

test('reads the bundle identifier from an app Info.plist', async () => {
  const { readBundleId } = await import('../src/server/install.ts');
  const d = scratch();
  const app = join(d, 'Thing.app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.thing</string>
</dict></plist>`);
  await expect(readBundleId(app)).resolves.toBe('com.example.thing');
  rmSync(d, { recursive: true, force: true });
});

test('a missing Info.plist gives a clear error', async () => {
  const { readBundleId } = await import('../src/server/install.ts');
  const d = scratch();
  const app = join(d, 'Empty.app');
  mkdirSync(app, { recursive: true });
  await expect(readBundleId(app)).rejects.toThrow(/bundle identifier/i);
  rmSync(d, { recursive: true, force: true });
});
