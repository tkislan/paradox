import http from 'node:http';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { FakeBroker } from '../mock_mqtt.js';
import { FakePanel, renderLoginPage } from '../mock_paradox.js';
import {
  captureConsole, isolateProcessListeners, loadBridge, loadSpec, onCleanup, reservePort, setBridgeEnv, settle, specText,
  spyProcessExit, useFakeClock, waitFor, withTitle,
} from '../support.js';

const spec = loadSpec('system_scenarios');
const login = spec.login;

// Loopback round trips take well under a millisecond; this is the window in which unexpected extra effects can still show up.
const QUIET_MS = 10;
const WAIT_INTERVAL_MS = 2;

const MQTT_USERNAME = 'bridge';
const MQTT_PASSWORD = 'secret';
const SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'];

const FAULTS = {
  http_500: { status: 500, headers: { 'Content-Type': 'text/plain' }, body: 'Internal Server Error' },
  reset: { destroy: true },
  hang: { hang: true },
  login_page: { status: 200, headers: { 'Content-Type': 'text/html' }, body: renderLoginPage(login.session) },
  garbage: { status: 200, headers: { 'Content-Type': 'text/html' }, body: '<html>no status tables here</html>' },
  wrong_title: {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
    body: '<html><head><title>Not the panel</title></head><body></body></html>',
  },
};

const faultResponse = ({ kind, page }) => {
  if (kind !== 'page') return FAULTS[kind];
  return { status: 200, headers: { 'Content-Type': 'text/html' }, body: specText(page) };
};

const addFault = (panel, fault) => panel.respondWith(fault.path, faultResponse(fault), fault.times ? { times: fault.times } : {});

const canConnect = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const socket = net.connect(port, host);
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});

// agent: false makes every request use a fresh connection that closes with the response, so a finished
// request never keeps server.close() waiting.
function request(port, { method, path, host = '127.0.0.1', signal }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path, agent: false, signal }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Swaps vitest's own handler out so the test can observe the event instead of failing the run. */
function captureProcessEvent(event, seen = []) {
  const saved = process.listeners(event);
  process.removeAllListeners(event);
  process.on(event, (error) => seen.push(error));
  onCleanup(() => {
    process.removeAllListeners(event);
    saved.forEach((listener) => process.on(event, listener));
  });
  return seen;
}

/**
 * Everything one scenario needs: fake panel and broker, fake clock, silenced console, recorded
 * process.exit. `load()` starts the bridge (app.js runs at import time).
 */
async function createBridge({ panel: panelSpec = {}, broker: brokerSpec = {}, env = {} } = {}) {
  const logs = captureConsole();
  const exit = spyProcessExit();
  isolateProcessListeners();
  const clock = useFakeClock();

  const panel = new FakePanel({
    sessionValue: login.session,
    credentials: panelSpec.accept_login === false ? {} : { [login.session]: { u: login.u, p: login.p } },
    requireLogin: true,
    zones: panelSpec.zones,
    statuszone: panelSpec.statuszone,
    useraccess: panelSpec.useraccess,
  });
  await panel.start();
  (panelSpec.faults ?? []).forEach((fault) => addFault(panel, fault));

  const broker = new FakeBroker({
    credentials: brokerSpec.accept_credentials === false ? { username: 'someone', password: 'else' } : undefined,
    silent: brokerSpec.silent,
  });
  await broker.start();
  Object.entries(brokerSpec.retained ?? {}).forEach(([topic, payload]) => broker.retained.set(topic, payload));

  const port = await reservePort();
  setBridgeEnv({
    HOSTNAME: panelSpec.down ? `127.0.0.1:${await reservePort()}` : panel.hostname,
    USERNAME: login.username,
    PASSWORD: login.password,
    PORT: String(port),
    MQTT_HOSTNAME: broker.hostname,
    MQTT_PORT: String(brokerSpec.down ? await reservePort() : broker.port),
    MQTT_USERNAME,
    MQTT_PASSWORD,
    ...env,
  });

  // rawListeners, not listeners: a handler registered with once() must be removed by its first call, as a real signal would.
  const listenersBefore = Object.fromEntries(SIGNALS.map((name) => [name, process.rawListeners(name)]));
  const bridgeHandlers = (name) => process.rawListeners(name).filter((listener) => !listenersBefore[name].includes(listener));
  const exitCodes = () => exit.mock.calls.map(([code]) => code);

  const world = {
    panel,
    broker,
    port,
    clock,
    logs,
    exitCodes,
    seen: { published: 0, requests: 0, exits: 0, errors: 0 },
    lastRest: null,
    hungRequests: (panelSpec.faults ?? []).some((fault) => fault.kind === 'hang'),
    load: () => loadBridge().load('app.js'),
    signal: (name) => bridgeHandlers(name).forEach((handler) => handler(name)),
    rest: (call) => request(port, call),
    awaitRestServer: () => waitFor(() => canConnect(port), { interval: WAIT_INTERVAL_MS, message: 'the REST server to listen' }),
  };

  // The bridge's own shutdown path stops its timers and closes the REST server, which a mocked
  // process.exit would otherwise leave running. The panel goes first: a request still hanging at
  // this point must fail while the 'error' handler is attached, because stop() detaches it.
  onCleanup(async () => {
    await panel.stop();
    if (world.hungRequests) await settle(QUIET_MS);
    const handlers = bridgeHandlers('SIGTERM');
    if (handlers.length > 0) {
      const exitsBefore = exitCodes().length;
      // Best effort: the shutdown tests report a broken shutdown. A throw here would abort the cleanup loop and leave
      // servers, port claims and listeners behind for every later test, turning one failure into dozens.
      await Promise.resolve()
        .then(() => handlers.forEach((handler) => handler('SIGTERM')))
        .then(() => waitFor(() => exitCodes().length > exitsBefore, { interval: 1, message: 'the shutdown to finish' }))
        .catch(() => {});
    }
    // A connected MQTT client calls process.exit when the broker goes away; that must land on the spy
    // and the fake clock, not on a real exit or a real reconnect timer after the test.
    const connected = broker.clients.size > 0 && broker.subscriptions.length > 0;
    const exitsBefore = exitCodes().length;
    await broker.stop();
    if (connected) await waitFor(() => exitCodes().length > exitsBefore, { interval: 1, timeout: 500 }).catch(() => {});
  });

  return world;
}

function restBody({ headers, text }) {
  return text !== '' && String(headers['content-type']).includes('json') ? JSON.parse(text) : text;
}

async function perform(world, step) {
  if (step.panel_status) world.panel.setStatus(step.panel_status);
  if (step.panel_fault) {
    addFault(world.panel, step.panel_fault);
    world.hungRequests ||= step.panel_fault.kind === 'hang';
  }
  if (step.panel_expire_session) world.panel.expireSession();
  if (step.panel_down) await world.panel.stop();
  if (step.broker_drop_clients) world.broker.dropClients();
  if (step.mqtt_command) {
    const { topic, payload } = typeof step.mqtt_command === 'string'
      ? { topic: `paradox/command/${step.mqtt_command}`, payload: '' }
      : step.mqtt_command;
    world.broker.publish(topic, payload);
  }
  if (step.mqtt_message) {
    const { topic, payload } = step.mqtt_message;
    const packet = { cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain: false, dup: false };
    world.broker.clients.forEach((client) => client.send(packet));
  }
  if (step.signal) world.signal(step.signal);
  world.lastRest = null;
  if (step.rest) {
    const response = await world.rest(step.rest);
    world.lastRest = { status: response.status, body: restBody(response) };
  }
  if (step.advance_ms) await world.clock.advance(step.advance_ms);
}

/**
 * Waits until the expected effects showed up, lets stray extra effects arrive, then compares
 * everything that happened since the previous check with the expectation.
 */
async function expectOutcome(world, expected, { checkRequests = true, quiet = true } = {}) {
  const wantPublished = expected.mqtt_published ?? [];
  const anyOrder = expected.panel_requests_any_order !== undefined;
  const wantRequests = expected.panel_requests ?? expected.panel_requests_any_order ?? [];
  const wantRequestCounts = expected.panel_request_counts;
  const wantRequestTotal = wantRequestCounts ? Object.values(wantRequestCounts).reduce((a, b) => a + b, 0) : wantRequests.length;
  const wantExits = expected.process_exit ?? [];

  const fresh = () => ({
    published: world.broker.published.slice(world.seen.published),
    requests: world.panel.requestLines.slice(world.seen.requests),
    exits: world.exitCodes().slice(world.seen.exits),
    errors: world.logs.error.slice(world.seen.errors),
  });
  const reached = () => {
    const now = fresh();
    return now.published.length >= wantPublished.length
      && (!checkRequests || now.requests.length >= wantRequestTotal)
      && now.exits.length >= wantExits.length
      && (expected.logged_error !== true || now.errors.length > 0)
      && world.broker.connects.length >= (expected.broker_connects ?? 0)
      && world.broker.subscriptions.length >= (expected.broker_subscriptions ?? []).length;
  };
  // On a timeout the comparison below reports what is missing, which beats a bare timeout error.
  await waitFor(reached, { timeout: 1500, interval: WAIT_INTERVAL_MS }).catch(() => {});
  if (quiet) await settle(QUIET_MS);

  const now = fresh();
  const actual = {
    mqtt_published: now.published.map(({ topic, payload, retain }) => ({ topic, payload, retain })),
    process_exit: now.exits,
  };
  const wanted = { mqtt_published: wantPublished, process_exit: wantExits };
  if (checkRequests && wantRequestCounts) {
    actual.panel_request_counts = {};
    now.requests.forEach((line) => { actual.panel_request_counts[line] = (actual.panel_request_counts[line] ?? 0) + 1; });
    wanted.panel_request_counts = wantRequestCounts;
  } else if (checkRequests) {
    actual.panel_requests = anyOrder ? [...now.requests].sort() : now.requests;
    wanted.panel_requests = anyOrder ? [...wantRequests].sort() : wantRequests;
  }
  if ('logged_error' in expected) {
    actual.logged_error = now.errors.length > 0;
    wanted.logged_error = expected.logged_error;
  }
  if ('broker_connects' in expected) {
    actual.broker_connects = world.broker.connects.length;
    wanted.broker_connects = expected.broker_connects;
  }
  if ('broker_subscriptions' in expected) {
    actual.broker_subscriptions = world.broker.subscriptions;
    wanted.broker_subscriptions = expected.broker_subscriptions;
  }
  if ('rest_listening' in expected) {
    actual.rest_listening = await canConnect(world.port);
    wanted.rest_listening = expected.rest_listening;
  }
  if ('rest_response' in expected) {
    const { status, body } = world.lastRest ?? {};
    actual.rest_response = 'body' in expected.rest_response ? { status, body } : { status };
    wanted.rest_response = expected.rest_response;
  }

  expect(actual).toEqual(wanted);
  expect(now.published.map(({ qos }) => qos)).toEqual(now.published.map(() => 0));

  world.seen.published += now.published.length;
  world.seen.requests += now.requests.length;
  world.seen.exits += now.exits.length;
  world.seen.errors += now.errors.length;
}

async function runScenario(row) {
  const unhandled = [];
  // Registered before the capture so that it runs after vitest's own handler is back: a failing check must not leave it removed.
  // Also covers rejections raised while the scenario is being torn down.
  onCleanup(() => expect(unhandled).toEqual([]));
  captureProcessEvent('unhandledRejection', unhandled);
  const world = await createBridge(row);
  const start = row.start ?? {};

  world.load();
  if (start.ready !== false) await world.awaitRestServer();
  await expectOutcome(world, start.expect ?? {}, {
    checkRequests: start.expect?.panel_requests !== undefined,
    // Without startup expectations a stray startup message would show up in the first step anyway.
    quiet: start.expect !== undefined,
  });

  for (const step of row.steps ?? []) {
    await perform(world, step);
    await expectOutcome(world, step.expect ?? {});
  }
  expect(unhandled).toEqual([]);
}

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
    expect(world.panel.requests).toEqual([]);
    expect(world.broker.connects).toEqual([]);
    expect(world.exitCodes()).toEqual([]);
    expect(await canConnect(world.port)).toBe(false);
  });
});

describe('startup', () => {
  it('does not connect to the broker nor open the REST port while the login is still in progress', async () => {
    const world = await createBridge({ panel: { faults: [{ path: '/index.html', kind: 'hang' }] } });

    world.load();
    await waitFor(() => world.panel.requestsTo('/index.html').length === 1, { message: 'the login to reach the index page' });
    await settle(100);

    expect(world.broker.connects).toEqual([]);
    expect(await canConnect(world.port)).toBe(false);

    await world.panel.stop();
    await waitFor(() => world.exitCodes().length === 1, { message: 'the failed login to end the process' });
    expect(world.exitCodes()).toEqual([1]);
    expect(world.broker.connects).toEqual([]);
  });

  it('connects with the configured MQTT credentials as MQTT 3.1.1 with keepalive 60, a random client id, a clean session and no will, and subscribes with QoS 0', async () => {
    const world = await createBridge();

    world.load();
    await world.awaitRestServer();

    expect(world.broker.connects).toHaveLength(1);
    expect(world.broker.connects[0]).toMatchObject({
      username: MQTT_USERNAME,
      password: MQTT_PASSWORD,
      protocolId: 'MQTT',
      protocolVersion: 4,
      keepalive: 60,
      clientId: expect.stringMatching(/^mqttjs_[0-9a-f]{8}$/),
      clean: true,
    });
    expect(world.broker.connects[0].will).toBeUndefined();
    const subscribes = world.broker.packets.filter((packet) => packet.cmd === 'subscribe');
    expect(subscribes.map((packet) => packet.subscriptions)).toEqual([
      [{ topic: 'paradox/command/arm', qos: 0 }],
      [{ topic: 'paradox/command/disarm', qos: 0 }],
    ]);
  });

  it('KNOWN BUG KB-8: an empty MQTT password makes the broker see the username with a trailing colon and no password', async () => {
    const world = await createBridge({ env: { MQTT_PASSWORD: '' } });

    world.load();
    await world.awaitRestServer();

    expect(world.broker.connects[0].username).toBe(`${MQTT_USERNAME}:`);
    expect(world.broker.connects[0].password).toBeUndefined();
  });

  it('KNOWN BUG KB-37: PORT already in use ends in an uncaught exception, not in the exit(1) handler', async () => {
    const uncaught = captureProcessEvent('uncaughtException');
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, resolve));
    onCleanup(() => new Promise((resolve) => blocker.close(resolve)));
    const world = await createBridge({ env: { PORT: String(blocker.address().port) } });

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
  it('serves /status as compact JSON with the keys in this order', async () => {
    const world = await createBridge({ panel: { statuszone: [5, 0, 1, ...new Array(29).fill(0)], useraccess: [2, 0] } });
    world.load();
    await world.awaitRestServer();

    const response = await world.rest({ method: 'GET', path: '/status' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.text).toBe(`{"statuszone":[5,0,1,${new Array(29).fill(0).join(',')}],"useraccess":[2,0],"alarms":[0]}`);
  });

  it('answers /arm and /disarm with the plain text OK', async () => {
    const world = await createBridge();
    world.load();
    await world.awaitRestServer();

    const response = await world.rest({ method: 'POST', path: '/arm' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.text).toBe('OK');
  });

  it('KNOWN BUG KB-19: any client of any network interface can disarm the alarm, the server listens on all interfaces', async () => {
    const world = await createBridge({ panel: { useraccess: [2, 0] } });
    world.load();
    await world.awaitRestServer();

    // 127.0.0.2 is loopback but not 127.0.0.1: a server bound to 127.0.0.1 only would refuse it.
    const response = await world.rest({ method: 'POST', path: '/disarm', host: '127.0.0.2' });

    expect(response.status).toBe(200);
    expect(world.panel.requestLines.at(-1)).toBe('GET /statuslive.html?area=00&value=d');
    expect(world.panel.requests.at(-1).headers.authorization).toBeUndefined();
    expect(world.panel.useraccess).toEqual([1, 0]);
  });

  it('KNOWN BUG KB-13: a request to a panel that never answers never completes, however long the bridge runs', async () => {
    const world = await createBridge();
    world.load();
    await world.awaitRestServer();
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
    await world.awaitRestServer();

    world.signal('SIGTERM');
    await waitFor(() => world.exitCodes().length === 1, { message: 'the shutdown to finish' });
    await settle(QUIET_MS);

    expect(world.broker.packets.map((packet) => packet.cmd)).toEqual(['connect', 'subscribe', 'subscribe']);
    expect(world.broker.published).toEqual([]);
  });

  it('waits for a request in flight, refuses new connections meanwhile, and only then exits', async () => {
    const world = await createBridge();
    world.load();
    await world.awaitRestServer();
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

  it('KNOWN BUG KB-27: a poll still in flight when the bridge shuts down and then failing is an unhandled rejection', async () => {
    const unhandled = captureProcessEvent('unhandledRejection');
    const world = await createBridge();
    world.load();
    await world.awaitRestServer();
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
    const world = await createBridge();
    world.load();
    await world.awaitRestServer();

    // A packet of the reserved type 15 makes the client's parser fail with an 'error' event.
    world.broker.clients.forEach((client) => client.socket.write(Buffer.from([0xf0, 0x00])));
    await waitFor(() => world.exitCodes().length > 0, { message: 'the MQTT error to end the process' });
    await settle(QUIET_MS);

    expect(world.exitCodes()).toEqual([1]);
    expect(world.logs.error).toHaveLength(1);
    expect(world.logs.error[0][0]).toBeInstanceOf(Error);
  });
});
