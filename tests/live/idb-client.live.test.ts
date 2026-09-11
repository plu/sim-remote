import { CompanionSupervisor } from '../../src/server/companion/supervisor.ts';
import { listBootedSims } from '../../src/server/companion/discovery.ts';
import { IdbClient } from '../../src/server/idb/client.ts';

let sup: CompanionSupervisor;
let client: IdbClient;

beforeAll(async () => {
  const sims = await listBootedSims();
  if (sims.length === 0) throw new Error('live tests need a booted simulator');
  sup = new CompanionSupervisor();
  client = IdbClient.connect(await sup.socketFor(sims[0]!.udid));
});
afterAll(() => { client?.close(); sup?.stopAll(); });

test('describe reports a sane point-space screen', async () => {
  const { screen } = await client.describe();
  expect(screen.width).toBeGreaterThan(200);
  expect(screen.width).toBeLessThan(2000);
  expect(screen.height).toBeGreaterThan(screen.width);
});

test('video delivers H264 data within a few seconds', async () => {
  let bytes = 0;
  const h = client.startVideo((c) => { bytes += c.length; }, () => {});
  await new Promise((r) => setTimeout(r, 4000));
  h.stop();
  expect(bytes).toBeGreaterThan(10_000);
});

test('hid input is accepted and the accessibility tree is readable', async () => {
  const hid = client.openHid(() => {});
  hid.button('HOME');
  await new Promise((r) => setTimeout(r, 1500));
  hid.end();
  const tree = await client.accessibilityInfo();
  expect(tree.length).toBeGreaterThan(100);
});
