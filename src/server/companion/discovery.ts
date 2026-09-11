import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface BootedSim { udid: string; name: string; runtime: string }

/** 'com.apple.CoreSimulator.SimRuntime.iOS-26-5' -> 'iOS 26.5' */
function prettyRuntime(key: string): string {
  const tail = key.split('.').pop() ?? key;
  const m = /^([A-Za-z]+)-(.+)$/.exec(tail);
  return m ? `${m[1]} ${m[2]!.replace(/-/g, '.')}` : tail;
}

export function parseBootedDevices(simctlJson: string): BootedSim[] {
  let parsed: unknown;
  try { parsed = JSON.parse(simctlJson); }
  catch { throw new Error('could not parse simctl device list output'); }

  const devices = (parsed as { devices?: Record<string, unknown[]> }).devices ?? {};
  const out: BootedSim[] = [];
  for (const [runtimeKey, list] of Object.entries(devices)) {
    for (const d of list as Array<Record<string, unknown>>) {
      if (d.state === 'Booted' && d.isAvailable !== false) {
        out.push({ udid: String(d.udid), name: String(d.name), runtime: prettyRuntime(runtimeKey) });
      }
    }
  }
  return out;
}

export async function listBootedSims(): Promise<BootedSim[]> {
  const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', '--json']);
  return parseBootedDevices(stdout);
}
