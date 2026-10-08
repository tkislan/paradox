import { describe, expect, it } from 'vitest';
import { settle, waitFor, withTitle } from '../support.js';
import { FAULTS, spec } from '../fixtures/app.js';
import { canConnect, createBridge, runScenario } from '../helpers/app.js';

describe('scenarios', () => {
  const groups = Object.keys(spec).filter((group) => Array.isArray(spec[group]));
  for (const group of groups) {
    describe(group, () => {
      it.each(withTitle(spec[group]))('$title', runScenario);
    });
  }
});

describe('startup', () => {
  it('does not connect to the broker nor open the REST port while the login is still in progress', async () => {
    const world = await createBridge({ panel: { faults: [{ path: '/index.html', kind: 'hang' }] } });

    world.load();
    await waitFor(() => world.panel.requestsTo('/index.html').length === 1, { message: 'the login to reach the index page' });
    await settle(100);
    await world.broker.syncLog();

    expect(world.broker.events).toEqual([]);
    expect(await canConnect(world.port)).toBe(false);

    await world.panel.stop();
    await waitFor(() => world.exitCodes().length === 1, { message: 'the failed login to end the process' });
    await world.broker.syncLog();
    expect(world.exitCodes()).toEqual([1]);
    expect(world.broker.events).toEqual([]);
  });

  it('connects with the configured MQTT credentials as MQTT 3.1.1 with keepalive 60, a random client id, a clean session and no will, and subscribes with QoS 0', async () => {
    const world = await createBridge();

    world.load();
    await world.awaitReady();
    await world.broker.syncLog();

    // The broker never shows a password; the user bridge/secret only exists with that password, so CONNACK 0 is the evidence.
    expect(world.broker.connects).toEqual([{
      clientId: expect.stringMatching(/^mqttjs_[0-9a-f]{8}$/),
      protocolLevel: 4,
      clean: true,
      keepalive: 60,
      username: world.broker.credentials.username,
      will: false,
    }]);
    expect(world.broker.connacks).toEqual([0]);
    expect(world.broker.events.filter(({ type }) => type === 'subscribe').map(({ topics }) => topics)).toEqual([
      [{ topic: 'paradox/command/arm', qos: 0 }],
      [{ topic: 'paradox/command/disarm', qos: 0 }],
    ]);
  });
});

describe('REST API', () => {
  it('serves /status as compact JSON with the keys in this order', async () => {
    const world = await createBridge({ panel: { statuszone: [5, 0, 1, ...new Array(29).fill(0)], useraccess: [2, 0] } });
    world.load();
    await world.awaitReady();

    const response = await world.rest({ method: 'GET', path: '/status' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.text).toBe(`{"statuszone":[5,0,1,${new Array(29).fill(0).join(',')}],"useraccess":[2,0],"alarms":[0]}`);
  });

  it('answers /arm and /disarm with the plain text OK', async () => {
    const world = await createBridge();
    world.load();
    await world.awaitReady();

    const response = await world.rest({ method: 'POST', path: '/arm' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.text).toBe('OK');
  });
});

describe('shutdown', () => {
  it('waits for a request in flight, refuses new connections meanwhile, and only then exits', async () => {
    const world = await createBridge();
    world.load();
    await world.awaitReady();
    world.panel.respondWith('/statuslive.html', FAULTS.hang, { times: 1 });
    const abort = new AbortController();
    const pending = world.rest({ method: 'GET', path: '/status', signal: abort.signal }).catch((error) => error.name);
    await waitFor(() => world.panel.requestsTo('/statuslive.html').length === 1, { message: 'the panel to get the request' });

    world.signal('SIGTERM');
    await settle(100);

    expect(await canConnect(world.port)).toBe(false);
    expect(world.exitCodes()).toEqual([]);

    abort.abort();
    expect(await pending).toBe('AbortError');
    await waitFor(() => world.exitCodes().length === 1, { message: 'the exit after the server closed' });
    expect(world.exitCodes()).toEqual([143]);
  });
});
