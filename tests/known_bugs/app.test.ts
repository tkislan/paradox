import net, { type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loadKnownBugSpec, onCleanup, settle, waitFor, withTitle } from '../support.ts';
import { FAULTS, QUIET_MS, login } from '../fixtures/app.ts';
import { canConnect, captureProcessEvent, createBridge, runScenario } from '../helpers/app.ts';

const spec = loadKnownBugSpec('system_scenarios');

describe('scenarios', () => {
  const groups = Object.keys(spec).filter((group) => Array.isArray(spec[group]) && group !== 'missing_env');
  for (const group of groups) {
    describe(group, () => {
      it.each(withTitle(spec[group]))('$title', runScenario);
    });
  }
});

describe('missing environment variable', () => {
  it.each(withTitle(spec.missing_env))('$title', async ({ missing, expected_error }) => {
    const world = await createBridge({ env: Object.fromEntries(missing.map((key) => [key, undefined])) });

    expect(() => world.load()).toThrow(new Error(expected_error));

    await settle(QUIET_MS);
    await world.broker.syncLog();
    expect(world.panel.requests).toEqual([]);
    expect(world.broker.events).toEqual([]);
    expect(world.exitCodes()).toEqual([]);
    expect(await canConnect(world.port)).toBe(false);
  });
});

describe('startup', () => {
  it('KNOWN BUG KB-8: an empty MQTT password makes the bridge send the username with a trailing colon and no password, which the broker rejects with CONNACK 5', async () => {
    const world = await createBridge({ relay: true, env: { MQTT_PASSWORD: '' } });

    world.load();
    await waitFor(() => world.exitCodes().length === 1, { message: 'the rejected login to end the process' });
    await world.broker.syncLog();

    // Mosquitto does not log the username of a refused login, so the relay reports what it was sent.
    expect(world.connectPackets).toHaveLength(1);
    expect(world.connectPackets[0].username).toBe(`${world.broker.credentials.username}:`);
    expect(world.connectPackets[0].password).toBeNull();
    expect(world.broker.connacks).toEqual([5]);
    expect(world.exitCodes()).toEqual([1]);
    expect(await canConnect(world.port)).toBe(false);
  });

  it('KNOWN BUG KB-37: PORT already in use ends in an uncaught exception, not in the exit(1) handler', async () => {
    const uncaught = captureProcessEvent('uncaughtException');
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    onCleanup(() => new Promise((resolve) => blocker.close(resolve)));
    const world = await createBridge({ env: { PORT: String((blocker.address() as AddressInfo).port) } });

    world.load();
    await waitFor(() => uncaught.length > 0, { message: 'the listen error' });

    expect(uncaught).toHaveLength(1);
    expect(uncaught[0].code).toBe('EADDRINUSE');
    expect(world.exitCodes()).toEqual([]);
  });
});

describe('logging', () => {
  it('KNOWN BUG KB-35: a login request failing with HTTP 500 is logged as the whole axios error, whose request params hold the hashed panel username and password', async () => {
    const world = await createBridge({ panel: { faults: [{ path: '/default.html', kind: 'http_500' }] } });

    world.load();
    await waitFor(() => world.exitCodes().length === 1, { message: 'the failed login to end the process' });

    // With the session value, which is logged too, the two hashes allow an offline guess of the (short) panel PIN.
    const loggedParams = world.logs.error.flat().map((entry) => entry?.config?.params).filter(Boolean);
    expect(loggedParams).toEqual([{ u: login.u, p: login.p }]);
    expect(world.logs.log).toContainEqual([`Session value: ${login.session}`]);
  });
});

describe('REST API', () => {
  it('KNOWN BUG KB-19: any client of any network interface can disarm the alarm, the server listens on all interfaces', async () => {
    const world = await createBridge({ panel: { useraccess: [2, 0] } });
    world.load();
    await world.awaitReady();

    // 127.0.0.2 is loopback but not 127.0.0.1: a server bound to 127.0.0.1 only would refuse it.
    const response = await world.rest({ method: 'POST', path: '/disarm', host: '127.0.0.2' });

    expect(response.status).toBe(200);
    expect(world.panel.requestLines.at(-1)).toBe('GET /statuslive.html?area=00&value=d');
    expect(world.panel.requests.at(-1)!.headers.authorization).toBeUndefined();
    expect(world.panel.useraccess).toEqual([1, 0]);
  });

  it('KNOWN BUG KB-13: a request to a panel that never answers never completes, however long the bridge runs', async () => {
    const world = await createBridge();
    world.load();
    await world.awaitReady();
    world.panel.respondWith('/statuslive.html', FAULTS.hang, { times: 1 });
    const abort = new AbortController();
    let finished = false;
    const pending = world.rest({ method: 'GET', path: '/status', signal: abort.signal })
      .then(() => { finished = true; }, () => { finished = true; });
    await waitFor(() => world.panel.requestsTo('/statuslive.html').length === 1, { message: 'the panel to get the request' });

    await world.clock.advance(60000);
    await settle(100);

    expect(finished).toBe(false);
    expect(world.exitCodes()).toEqual([]);
    abort.abort();
    await pending;
  });
});

describe('shutdown', () => {
  it('KNOWN BUG KB-33: shutdown sends no DISCONNECT and no offline message to the broker', async () => {
    const world = await createBridge();
    world.load();
    await world.awaitReady();

    world.signal('SIGTERM');
    await waitFor(() => world.exitCodes().length === 1, { message: 'the shutdown to finish' });
    await settle(QUIET_MS);
    await world.broker.syncLog();

    // Everything the broker saw of the bridge: it connected and subscribed, and its connection is still open.
    expect(world.broker.events.map(({ type }) => type)).toEqual(['connect', 'connack', 'subscribe', 'subscribe']);
    expect(world.broker.published).toEqual([]);
    expect(await world.broker.retained('paradox/status/armed')).toBeNull();
  });

  it('KNOWN BUG KB-27: a poll still in flight when the bridge shuts down and then failing is an unhandled rejection', async () => {
    const unhandled = captureProcessEvent('unhandledRejection');
    const world = await createBridge();
    world.load();
    await world.awaitReady();
    world.panel.respondWith('/statuslive.html', FAULTS.hang, { times: 1 });
    await world.clock.advance(1000);
    await waitFor(() => world.panel.requestsTo('/statuslive.html').length === 1, { message: 'the poll to reach the panel' });
    world.signal('SIGTERM');
    await waitFor(() => world.exitCodes().length === 1, { message: 'the shutdown to finish' });

    await world.panel.stop();
    await waitFor(() => unhandled.length > 0, { message: 'the failed poll' });

    // stop() removed the 'error' listener, so the failure neither reaches the exit(1) handler nor a catch.
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0].message).toBe('socket hang up');
    expect(world.exitCodes()).toEqual([143]);
  });
});

describe('MQTT link after startup', () => {
  it('KNOWN BUG KB-7: an MQTT error after connecting is logged by the stale pre-connect handler and also exits with 1', async () => {
    const world = await createBridge({ relay: true });
    world.load();
    await world.awaitReady();

    // A packet of the reserved type 15 makes the client's parser fail with an 'error' event.
    world.relay!.inject([0xf0, 0x00]);
    await waitFor(() => world.exitCodes().length > 0, { message: 'the MQTT error to end the process' });
    await settle(QUIET_MS);

    expect(world.exitCodes()).toEqual([1]);
    expect(world.logs.error).toHaveLength(1);
    expect(world.logs.error[0][0]).toBeInstanceOf(Error);
  });
});
