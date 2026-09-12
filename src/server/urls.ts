import { networkInterfaces } from 'node:os';
import type { Config } from './auth.ts';

export interface BrowseUrls {
  local: string;
  shareable: string[];
  /** True when teammates would be sent to a plain-http, non-localhost origin. */
  lanNeedsHttps: boolean;
}

const WILDCARD = new Set(['0.0.0.0', '::', '']);

/** IPv4 addresses other machines can actually reach. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/**
 * Turn the bind address into URLs a person can actually open. A wildcard bind
 * is NOT browsable: pasting http://0.0.0.0:8080 gives a blank page in Safari
 * and a broken one in Chrome.
 */
export function browseUrls(cfg: Config, lan: string[]): BrowseUrls {
  const suffix = cfg.auth ? `/?token=${cfg.token}` : '/';
  const url = (host: string) => `http://${host}:${cfg.port}${suffix}`;
  const wildcard = WILDCARD.has(cfg.host);

  // A proxy in front (Caddy) serves the origin people actually open, so print
  // that rather than this process's bind address.
  if (cfg.publicOrigin) {
    return {
      local: `${cfg.publicOrigin}${suffix}`,
      shareable: [`${cfg.publicOrigin}${suffix}`],
      lanNeedsHttps: !cfg.publicOrigin.startsWith('https://'),
    };
  }

  return {
    local: url(wildcard ? 'localhost' : cfg.host),
    shareable: wildcard ? lan.map(url) : [],
    lanNeedsHttps: wildcard && lan.length > 0,
  };
}
