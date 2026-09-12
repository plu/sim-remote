import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Entry { proc: ChildProcess; socket: string; ready: Promise<string> }

const SOCK_DIR = join(tmpdir(), 'sim-remote');

/** Cold start on a loaded or virtualised machine is much slower than on a
 *  warm laptop; 20s was not enough on CI. */
const SPAWN_TIMEOUT_MS = 60_000;

/** Spawns and supervises one idb_companion per simulator. */
export class CompanionSupervisor {
  #entries = new Map<string, Entry>();
  #stopping = new Set<string>();

  async socketFor(udid: string): Promise<string> {
    const existing = this.#entries.get(udid);
    if (existing) return existing.ready;
    return this.#spawn(udid).ready;
  }

  #spawn(udid: string): Entry {
    mkdirSync(SOCK_DIR, { recursive: true });
    const socket = join(SOCK_DIR, `${udid}.sock`);
    rmSync(socket, { force: true });

    const proc = spawn('idb_companion', [
      '--udid', udid,
      '--grpc-domain-sock', socket,
      '--log-level', 'info',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString().slice(0, 2000); });

    const ready = new Promise<string>((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (existsSync(socket)) { clearInterval(poll); resolve(socket); }
        else if (Date.now() - started > SPAWN_TIMEOUT_MS) {
          clearInterval(poll);
          reject(new Error(
            `idb_companion for ${udid} did not create a socket in ${SPAWN_TIMEOUT_MS / 1000}s`,
          ));
        }
      }, 100);
      proc.on('error', (e) => {
        clearInterval(poll);
        reject(new Error(`could not start idb_companion (is it installed? brew install facebook/fb/idb-companion): ${e.message}`));
      });
      proc.on('exit', (code) => {
        clearInterval(poll);
        if (!existsSync(socket)) reject(new Error(`idb_companion exited (${code}): ${stderr.trim()}`));
      });
    });
    ready.catch(() => { /* surfaced to the caller of socketFor */ });

    proc.on('exit', () => {
      this.#entries.delete(udid);
      rmSync(socket, { force: true });
      if (!this.#stopping.delete(udid)) {
        console.warn(`[supervisor] companion for ${udid} exited; will respawn on demand`);
      }
    });

    const entry: Entry = { proc, socket, ready };
    this.#entries.set(udid, entry);
    return entry;
  }

  stop(udid: string): void {
    const e = this.#entries.get(udid);
    if (!e) return;
    this.#stopping.add(udid);
    e.proc.kill('SIGTERM');
    this.#entries.delete(udid);
  }

  stopAll(): void { for (const udid of [...this.#entries.keys()]) this.stop(udid); }
}
