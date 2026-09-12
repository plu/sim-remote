import { execFile } from 'node:child_process';
import { readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Locate the app bundle in an extracted archive. Handles a top-level
 * `Foo.app`, an ipa-style `Payload/Foo.app`, and Finder's `__MACOSX` noise.
 * Nested bundles (extensions, watch apps) are ignored: only the outermost
 * bundle is installable.
 */
export function findAppBundle(dir: string): string {
  const isBundle = (p: string) => {
    try { return statSync(p).isDirectory(); } catch { return false; }
  };

  const search = (base: string): string | null => {
    let entries: string[];
    try { entries = readdirSync(base); } catch { return null; }

    for (const name of entries) {
      if (name.startsWith('.') || name === '__MACOSX') continue;
      const full = join(base, name);
      if (name.endsWith('.app') && isBundle(full)) return full;
    }
    // Recurse only into plain directories, so an outer .app always wins.
    for (const name of entries) {
      if (name.startsWith('.') || name === '__MACOSX') continue;
      const full = join(base, name);
      if (!name.endsWith('.app') && isBundle(full)) {
        const hit = search(full);
        if (hit) return hit;
      }
    }
    return null;
  };

  const found = search(dir);
  if (!found) throw new Error('no .app bundle found in the uploaded archive');
  return found;
}

/** Extract a zip into a fresh temp directory and return the app bundle path. */
export async function extractAppBundle(zipPath: string): Promise<{ appPath: string; workDir: string }> {
  const workDir = mkdtempSync(join(tmpdir(), 'sim-remote-upload-'));
  try {
    // -o overwrite, -qq quiet. unzip refuses absolute paths itself.
    await run('unzip', ['-oqq', zipPath, '-d', workDir], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    // unzip's stderr is a wall of text; a short message is far more useful in
    // the toast the user actually sees.
    rmSync(workDir, { recursive: true, force: true });
    throw new Error('that file is not a valid zip archive');
  }

  let appPath: string;
  try {
    appPath = findAppBundle(workDir);
  } catch (e) {
    rmSync(workDir, { recursive: true, force: true });
    throw e;
  }

  // Refuse anything that escaped the extraction directory (zip slip).
  if (!resolve(appPath).startsWith(resolve(workDir))) {
    rmSync(workDir, { recursive: true, force: true });
    throw new Error('archive tried to write outside the extraction directory');
  }
  return { appPath, workDir };
}

/** Read CFBundleIdentifier from the bundle itself, rather than trusting the
 *  install response (idb's InstallResponse.uuid is an install id, not a
 *  bundle id). */
export async function readBundleId(appPath: string): Promise<string> {
  try {
    const { stdout } = await run('plutil', [
      '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(appPath, 'Info.plist'),
    ]);
    const id = stdout.trim();
    if (!id) throw new Error('empty');
    return id;
  } catch {
    throw new Error(`could not read the bundle identifier from ${appPath}`);
  }
}
