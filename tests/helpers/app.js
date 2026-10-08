import http from 'node:http';
import net from 'node:net';
import { expect } from 'vitest';
import { FakeBroker } from '../mock_mqtt.js';
import { FakePanel } from '../mock_paradox.js';
import {
  captureConsole, isolateProcessListeners, loadBridge, onCleanup, reservePort, setBridgeEnv, settle, specText,
  spyProcessExit, useFakeClock, waitFor,
} from '../support.js';
import { FAULTS, MQTT_PASSWORD, MQTT_USERNAME, QUIET_MS, SIGNALS, WAIT_INTERVAL_MS, login } from '../fixtures/app.js';

const faultResponse = ({ kind, page }) => {
  if (kind !== 'page') return FAULTS[kind];
  return { status: 200, headers: { 'Content-Type': 'text/html' }, body: specText(page) };
};

const addFault = (panel, fault) => panel.respondWith(fault.path, faultResponse(fault), fault.times ? { times: fault.times } : {});

export const canConnect = (port, host = '127.0.0.1') => new Promise((resolve) => {
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
export function captureProcessEvent(event, seen = []) {
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
export async function createBridge({ panel: panelSpec = {}, broker: brokerSpec = {}, env = {} } = {}) {
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

export async function runScenario(row) {
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
