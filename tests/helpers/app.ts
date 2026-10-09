import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import type { MqttClient } from 'mqtt';
import mqttPacket from 'mqtt-packet';
import { expect, vi } from 'vitest';
import { FakePanel, type FakePanelOptions } from '../mock_paradox.ts';
import { leaseBroker } from '../mosquitto.ts';
import {
  captureConsole, isolateProcessListeners, onCleanup, reservePort, setBridgeEnv, settle,
  specText, spyProcessExit, useFakeClock, waitFor,
} from '../support.ts';
import {
  FAULTS, QUIET_MS, REACH_TIMEOUT_MS, READY_TIMEOUT_MS, SIGNALS, WAIT_INTERVAL_MS, login,
} from '../fixtures/app.ts';

const require = createRequire(import.meta.url);

vi.setConfig({ testTimeout: 90000 });

/** The `panel` and `broker` a scenario starts from, as in spec/system_scenarios.json. */
type PanelFault = { path: string; kind: string; times?: number; page?: string | { file: string } };
type PanelSpec = Pick<FakePanelOptions, 'zones' | 'statuszone' | 'useraccess'> & { accept_login?: boolean; faults?: PanelFault[]; down?: boolean };
type BrokerSpec = { retained?: Record<string, string>; silent?: boolean; down?: boolean; accept_credentials?: boolean };

const faultResponse = ({ kind, page }) => {
  if (kind !== 'page') return FAULTS[kind];
  return { status: 200, headers: { 'Content-Type': 'text/html' }, body: specText(page) };
};

const addFault = (panel, fault) => panel.respondWith(fault.path, faultResponse(fault), fault.times ? { times: fault.times } : {});

export const canConnect = (port: number, host = '127.0.0.1') => new Promise<boolean>((resolve) => {
  const socket = net.connect(port, host);
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});

// agent: false makes every request use a fresh connection that closes with the response, so a finished
// request never keeps server.close() waiting.
function request(port, { method, path, host = '127.0.0.1', signal }) {
  return new Promise<{ status: number | undefined; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
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
export function captureProcessEvent(event: string, seen: any[] = []) {
  // Process types listeners() only per known event name.
  const saved = (process as NodeJS.EventEmitter).listeners(event) as Array<(...args: any[]) => void>;
  process.removeAllListeners(event);
  process.on(event, (error) => seen.push(error));
  onCleanup(() => {
    process.removeAllListeners(event);
    saved.forEach((listener) => process.on(event, listener));
  });
  return seen;
}

/**
 * The bridge never ends its MQTT client (KB-33) and the mocked process.exit lets it live on, so the clients it creates are
 * collected to be ended by the test. mqtt_link.js calls `mqtt.connect` through the module object, which makes this possible.
 */
function collectBridgeMqttClients() {
  const mqtt = require('mqtt');
  const connect = mqtt.connect;
  const clients: MqttClient[] = [];
  mqtt.connect = function connectAndRemember(...args) {
    const client = connect.apply(this, args);
    clients.push(client);
    return client;
  };
  onCleanup(() => { mqtt.connect = connect; });
  return clients;
}

/**
 * Everything one scenario needs: fake panel, a leased Mosquitto, fake clock, silenced console, recorded
 * process.exit. `load()` starts the bridge (app.js runs at import time). `relay` routes the bridge through a TCP relay
 * in front of the broker, for what Mosquitto cannot do itself: a broker that is gone or never answers, bytes a broker
 * would never send.
 */
export async function createBridge({ panel: panelSpec = {}, broker: brokerSpec = {}, env = {}, relay: relayed = false }: {
  panel?: PanelSpec;
  broker?: BrokerSpec;
  env?: Record<string, string | undefined>;
  relay?: boolean;
} = {}) {
  // Before the fake clock: the lease reads the broker log from "now", and fake time moves on.
  const broker = await leaseBroker();
  const logs = captureConsole();
  const exit = spyProcessExit();
  isolateProcessListeners();
  const clock = useFakeClock();
  const mqttClients = collectBridgeMqttClients();

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

  for (const [topic, payload] of Object.entries(brokerSpec.retained ?? {})) await broker.publish(topic, payload, { retain: true });
  const relay = relayed ? await broker.proxy() : null;
  const connectPackets = relay ? relay.connects : [];
  // createBridge() callers ask for the relay with these.
  if (brokerSpec.silent) relay!.blackhole();
  if (brokerSpec.down) await relay!.stop();

  const port = await reservePort();
  setBridgeEnv({
    HOSTNAME: panelSpec.down ? `127.0.0.1:${await reservePort()}` : panel.hostname,
    USERNAME: login.username,
    PASSWORD: login.password,
    PORT: String(port),
    MQTT_HOSTNAME: (relay ?? broker).hostname,
    MQTT_PORT: String((relay ?? broker).port),
    MQTT_USERNAME: broker.credentials.username,
    MQTT_PASSWORD: brokerSpec.accept_credentials === false ? `not-${broker.credentials.password}` : broker.credentials.password,
    ...env,
  });

  // rawListeners, not listeners: a handler registered with once() must be removed by its first call, as a real signal would.
  const listenersBefore = Object.fromEntries(SIGNALS.map((name) => [name, process.rawListeners(name)]));
  const bridgeHandlers = (name) => process.rawListeners(name).filter((listener) => !listenersBefore[name].includes(listener));
  const exitCodes = () => exit.mock.calls.map(([code]) => code);

  const world = {
    panel,
    broker,
    relay,
    connectPackets,
    port,
    clock,
    logs,
    exitCodes,
    seen: { published: 0, brokerPublishes: 0, requests: 0, exits: 0, errors: 0 },
    lastRest: null as { status: number | undefined; body: unknown } | null,
    hungRequests: (panelSpec.faults ?? []).some((fault) => fault.kind === 'hang'),
    load: () => require('../../src/app.js'),
    signal: (name) => bridgeHandlers(name).forEach((handler) => handler(name)),
    rest: (call) => request(port, call),
    // CONNECT packets sent to the broker: Mosquitto answers every one (CONNACK 5 for a failed login, which its log
    // does not list as a connect), a relay that does not forward has to count them itself.
    connectCount: () => (relay ? connectPackets.length : broker.connacks.length),
    // The REST port opens after the MQTT link is created, the SUBSCRIBEs may still be on their way to the broker.
    awaitReady: async () => {
      await waitFor(() => canConnect(port), { timeout: READY_TIMEOUT_MS, interval: WAIT_INTERVAL_MS, message: 'the REST server to listen' });
      await waitFor(() => broker.subscriptions.length >= 2, { timeout: READY_TIMEOUT_MS, message: 'the broker to see both subscriptions' });
    },
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
    // Left alone the client stays subscribed on the leased instance, or redials from a real timer once the fake clock is
    // gone, into whatever a later test runs on that instance or port. A connected client calls process.exit when it
    // closes: that must land on the spy, so this runs before the spy and the clock are restored.
    await Promise.all(mqttClients.map((client) => new Promise<void>((resolve) => {
      // Only a live stream still has a 'close' to wait for.
      if (client.connected) client.once('close', resolve);
      else resolve();
      client.end(true);
    })));
  });

  return world;
}

const needsRelay = ({ broker = {}, steps = [] }: { broker?: BrokerSpec; steps?: any[] }) => Boolean(broker.silent || broker.down || steps.some((step) => step.mqtt_message));

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
  if (step.broker_drop_clients) await world.broker.kick(world.broker.credentials.username);
  if (step.mqtt_command) {
    const { topic, payload } = typeof step.mqtt_command === 'string'
      ? { topic: `paradox/command/${step.mqtt_command}`, payload: '' }
      : step.mqtt_command;
    await world.broker.publish(topic, payload);
  }
  if (step.mqtt_message) {
    const { topic, payload } = step.mqtt_message;
    world.relay.inject(mqttPacket.generate({ cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain: false, dup: false }));
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
  const wantRequestTotal = wantRequestCounts ? Object.values<number>(wantRequestCounts).reduce((a, b) => a + b, 0) : wantRequests.length;
  const wantExits = expected.process_exit ?? [];
  const { broker } = world;

  const fresh = () => ({
    published: broker.published.slice(world.seen.published),
    requests: world.panel.requestLines.slice(world.seen.requests),
    exits: world.exitCodes().slice(world.seen.exits),
    errors: world.logs.error.slice(world.seen.errors),
  });
  // The broker log is parsed on every access, so only what the expectation mentions is looked at while polling.
  const reached = () => {
    const now = fresh();
    return now.published.length >= wantPublished.length
      && (!checkRequests || now.requests.length >= wantRequestTotal)
      && now.exits.length >= wantExits.length
      && (expected.logged_error !== true || now.errors.length > 0)
      && (expected.broker_connects === undefined || world.connectCount() >= expected.broker_connects)
      && (expected.broker_connacks === undefined || broker.connacks.length >= expected.broker_connacks.length)
      && (expected.broker_subscriptions === undefined || broker.subscriptions.length >= expected.broker_subscriptions.length);
  };
  // On a timeout the comparison below reports what is missing, which beats a bare timeout error.
  await waitFor(reached, { timeout: REACH_TIMEOUT_MS, interval: WAIT_INTERVAL_MS }).catch(() => {});
  if (quiet) await settle(QUIET_MS);
  // The broker's log lags its connections; this is what makes "the broker saw / published nothing more" checkable.
  await broker.syncLog();

  const now = fresh();
  const actual: Record<string, any> = {
    mqtt_published: now.published.map(({ topic, payload, retain }) => ({ topic, payload, retain })),
    process_exit: now.exits,
  };
  const wanted: Record<string, any> = { mqtt_published: wantPublished, process_exit: wantExits };
  if (checkRequests && wantRequestCounts) {
    actual.panel_request_counts = {};
    now.requests.forEach((line) => { actual.panel_request_counts[line] = (actual.panel_request_counts[line] ?? 0) + 1; });
    wanted.panel_request_counts = wantRequestCounts;
  } else if (checkRequests) {
    actual.panel_requests = anyOrder ? [...now.requests].sort() : now.requests;
    wanted.panel_requests = anyOrder ? [...wantRequests].sort() : wantRequests;
  }
  // The broker's own account of what the bridge sent, independent of the paradox/# observer: a PUBLISH on any other topic
  // shows up here, and QoS, retain flag and length are what the broker received.
  const sent = broker.clientPublishes.slice(world.seen.brokerPublishes);
  actual.broker_log_publishes = sent;
  wanted.broker_log_publishes = wantPublished.map(({ topic, payload, retain }) => ({ topic, qos: 0, retain, bytes: Buffer.byteLength(payload) }));
  if ('logged_error' in expected) {
    actual.logged_error = now.errors.length > 0;
    wanted.logged_error = expected.logged_error;
  }
  if ('broker_connects' in expected) {
    actual.broker_connects = world.connectCount();
    wanted.broker_connects = expected.broker_connects;
  }
  if ('broker_connacks' in expected) {
    actual.broker_connacks = broker.connacks;
    wanted.broker_connacks = expected.broker_connacks;
  }
  if ('broker_subscriptions' in expected) {
    actual.broker_subscriptions = broker.subscriptions.map(({ topic }) => topic);
    wanted.broker_subscriptions = expected.broker_subscriptions;
  }
  if ('broker_retained' in expected) {
    actual.broker_retained = {};
    for (const topic of Object.keys(expected.broker_retained)) actual.broker_retained[topic] = await broker.retained(topic);
    wanted.broker_retained = expected.broker_retained;
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
  world.seen.brokerPublishes += sent.length;
  world.seen.requests += now.requests.length;
  world.seen.exits += now.exits.length;
  world.seen.errors += now.errors.length;
}

/** What a client that subscribes after the scenario gets: the last message the bridge published on each retained topic. */
async function expectRetainedState(broker) {
  const lastRetained = {};
  broker.published.filter(({ retain }) => retain).forEach(({ topic, payload }) => { lastRetained[topic] = payload; });
  const actual = {};
  for (const topic of Object.keys(lastRetained)) actual[topic] = await broker.retained(topic);
  expect(actual).toEqual(lastRetained);
}

export async function runScenario(row) {
  const unhandled = [];
  // Registered before the capture so that it runs after vitest's own handler is back: a failing check must not leave it removed.
  // Also covers rejections raised while the scenario is being torn down.
  onCleanup(() => expect(unhandled).toEqual([]));
  captureProcessEvent('unhandledRejection', unhandled);
  const world = await createBridge({ ...row, relay: needsRelay(row) });
  const start = row.start ?? {};

  world.load();
  if (start.ready !== false) await world.awaitReady();
  await expectOutcome(world, start.expect ?? {}, {
    checkRequests: start.expect?.panel_requests !== undefined,
    // Without startup expectations a stray startup message would show up in the first step anyway.
    quiet: start.expect !== undefined,
  });

  for (const step of row.steps ?? []) {
    await perform(world, step);
    await expectOutcome(world, step.expect ?? {});
  }
  await expectRetainedState(world.broker);
  expect(unhandled).toEqual([]);
}
