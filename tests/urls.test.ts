import { browseUrls } from '../src/server/urls.ts';

const cfg = { host: '0.0.0.0', port: 8080, auth: true, token: 'abc', publicOrigin: null };
const lan = ['192.168.1.131', '10.0.0.5'];

test('a wildcard bind never prints 0.0.0.0 as a browsable url', () => {
  const urls = browseUrls(cfg, lan);
  expect(urls.local).toBe('http://localhost:8080/?token=abc');
  expect(urls.local).not.toContain('0.0.0.0');
  expect(urls.shareable.join(' ')).not.toContain('0.0.0.0');
});

test('a wildcard bind lists every LAN address for sharing', () => {
  expect(browseUrls(cfg, lan).shareable).toEqual([
    'http://192.168.1.131:8080/?token=abc',
    'http://10.0.0.5:8080/?token=abc',
  ]);
});

test('the IPv6 wildcard is treated the same way', () => {
  expect(browseUrls({ ...cfg, host: '::' }, lan).local).toBe('http://localhost:8080/?token=abc');
});

test('an explicit host is used as given and is not shareable-listed', () => {
  const urls = browseUrls({ ...cfg, host: '127.0.0.1' }, lan);
  expect(urls.local).toBe('http://127.0.0.1:8080/?token=abc');
  expect(urls.shareable).toEqual([]);
});

test('no token is appended when auth is disabled', () => {
  expect(browseUrls({ ...cfg, auth: false }, lan).local).toBe('http://localhost:8080/');
});

test('shareable addresses are flagged as needing a secure context', () => {
  // WebCodecs and crypto.randomUUID only exist in a secure context, and
  // http://<lan-ip> is not one — only localhost is.
  expect(browseUrls(cfg, lan).lanNeedsHttps).toBe(true);
  expect(browseUrls({ ...cfg, host: '127.0.0.1' }, lan).lanNeedsHttps).toBe(false);
});

test('a public https origin is printed instead of the bind address', () => {
  const urls = browseUrls({ ...cfg, host: '127.0.0.1', publicOrigin: 'https://192.168.1.131:8443' }, lan);
  expect(urls.local).toBe('https://192.168.1.131:8443/?token=abc');
  expect(urls.shareable).toEqual(['https://192.168.1.131:8443/?token=abc']);
  expect(urls.lanNeedsHttps).toBe(false);   // https is a secure context
});

test('a public http origin is still flagged as insecure', () => {
  expect(browseUrls({ ...cfg, publicOrigin: 'http://192.168.1.131:9000' }, lan).lanNeedsHttps).toBe(true);
});
