import { parseArgs, checkAuth, COOKIE } from '../src/server/auth.ts';

const cfg = { host: '0.0.0.0', port: 8080, auth: true, token: 'secret' };

test('defaults: auth on, LAN bind, generated token', () => {
  const c = parseArgs([]);
  expect(c.auth).toBe(true);
  expect(c.host).toBe('0.0.0.0');
  expect(c.port).toBe(8080);
  expect(c.token.length).toBeGreaterThan(8);
});

test('generated tokens differ between runs', () => {
  expect(parseArgs([]).token).not.toBe(parseArgs([]).token);
});

test('--no-auth disables auth and --port/--host are honoured', () => {
  const c = parseArgs(['--no-auth', '--port', '9999', '--host', '127.0.0.1']);
  expect(c.auth).toBe(false);
  expect(c.port).toBe(9999);
  expect(c.host).toBe('127.0.0.1');
});

test('accepts a correct query token', () => {
  expect(checkAuth({ url: '/?token=secret', headers: {} }, cfg)).toBe(true);
});

test('accepts a valid session cookie', () => {
  expect(checkAuth({ url: '/', headers: { cookie: `${COOKIE}=secret` } }, cfg)).toBe(true);
});

test('finds the cookie among others', () => {
  expect(checkAuth({ url: '/', headers: { cookie: `a=1; ${COOKIE}=secret; b=2` } }, cfg)).toBe(true);
});

test('rejects a wrong or missing token', () => {
  expect(checkAuth({ url: '/?token=nope', headers: {} }, cfg)).toBe(false);
  expect(checkAuth({ url: '/', headers: {} }, cfg)).toBe(false);
  expect(checkAuth({ url: '/', headers: { cookie: `${COOKIE}=wrong` } }, cfg)).toBe(false);
});

test('rejects a token of a different length without throwing', () => {
  expect(checkAuth({ url: '/?token=x', headers: {} }, cfg)).toBe(false);
});

test('allows everything when auth is disabled', () => {
  expect(checkAuth({ url: '/', headers: {} }, { ...cfg, auth: false })).toBe(true);
});
