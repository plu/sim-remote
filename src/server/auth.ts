import { randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE = 'sim_remote_session';

export interface Config {
  host: string;
  port: number;
  auth: boolean;
  token: string;
  /** Origin users actually reach, when a proxy terminates TLS in front. */
  publicOrigin: string | null;
}

export function parseArgs(argv: string[]): Config {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    host: get('--host') ?? '0.0.0.0',
    port: Number(get('--port') ?? 8080),
    auth: !argv.includes('--no-auth'),
    token: get('--token') ?? randomBytes(16).toString('hex'),
    publicOrigin: get('--public-origin') ?? null,
  };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface AuthableRequest { url?: string | undefined; headers: { cookie?: string | undefined } }

export function checkAuth(req: AuthableRequest, cfg: Config): boolean {
  if (!cfg.auth) return true;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const q = url.searchParams.get('token');
  if (q && safeEqual(q, cfg.token)) return true;
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '');
  return m ? safeEqual(m[1]!, cfg.token) : false;
}
