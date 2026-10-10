import { createRequire } from 'node:module';
import type { MqttClient } from 'mqtt';
import { expect, vi } from 'vitest';
import { FakePanel } from '../mock_paradox.ts';
import { type Broker, watchBroker } from '../mosquitto.ts';
import type { Expect, PanelFault, Scenario, ScenarioBroker, ScenarioPanel, Step } from '../spec/schemas.ts';
import {
  captureConsole, isolateProcessListeners, onCleanup, reservePort, setBridgeEnv, settle,
  specText, spyProcessExit, useFakeClock, waitFor,
} from '../support.ts';
import {
  FAULTS, QUIET_MS, REACH_TIMEOUT_MS, READY_TIMEOUT_MS, WAIT_INTERVAL_MS, login,
} from '../fixtures/app.ts';

const require = createRequire(import.meta.url);

vi.setConfig({ testTimeout: 90000 });

const faultResponse = (fault: PanelFault) => {
  if (fault.kind !== 'page') return FAULTS[fault.kind];
  return { status: 200, headers: { 'Content-Type': 'text/html' }, body: specText(fault.page) };
};

const addFault = (panel: FakePanel, fault: PanelFault) => panel.respondWith(fault.path, faultResponse(fault), fault.times ? { times: fault.times } : {});

/** Swaps vitest's own handler out so the test can observe unhandled rejections instead of failing the run. */
function captureUnhandledRejections(seen: unknown[]) {
  const saved = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', (reason) => seen.push(reason));
  onCleanup(() => {
    process.removeAllListeners('unhandledRejection');
    saved.forEach((listener) => process.on('unhandledRejection', listener));
  });
}

/**
 * Puts the bridge's MQTT client under the test's topic prefix: what it publishes and subscribes to goes under the
 * prefix, and the messages it receives arrive with the prefix removed. mqtt_link.js calls `mqtt.connect` through the
 * module object, which makes this possible. The clients are also collected, because the bridge never ends its client
 * and the mocked process.exit lets it live on, so the test has to.
 */
function connectBridgeUnder(prefix: string) {
  const mqtt = require('mqtt');
  const connect = mqtt.connect;
  const clients: MqttClient[] = [];
  const subscribed: string[] = [];
  mqtt.connect = function connectUnderPrefix(...args) {
    const client = connect.apply(this, args);
    const { publish, subscribe, emit } = client;
    client.publish = (topic, ...rest) => publish.call(client, prefix + topic, ...rest);
    // mqtt_link.js passes a topic only; the callback tells the test that the broker has acknowledged the subscription.
    client.subscribe = (topic) => subscribe.call(client, prefix + topic, (error) => { if (!error) subscribed.push(topic); });
    client.emit = (event, ...rest) => emit.call(client, event, ...(event === 'message' ? [rest[0].slice(prefix.length), ...rest.slice(1)] : rest));
    clients.push(client);
    return client;
  };
  onCleanup(() => { mqtt.connect = connect; });
  return { clients, subscribed };
}

/**
 * Everything one scenario needs: fake panel, a connection to the broker under a fresh topic prefix, fake clock, silenced
 * console, recorded process.exit. `load()` starts the bridge (app.js runs at import time).
 */
export async function createBridge({ panel: panelSpec = {}, broker: brokerSpec = {}, env = {} }: {
  panel?: ScenarioPanel;
  broker?: ScenarioBroker;
  env?: Record<string, string | undefined>;
} = {}) {
  // Before the fake clock, which would freeze the connection's timers.
  const broker = await watchBroker();
  const logs = captureConsole();
  const exit = spyProcessExit();
  isolateProcessListeners();
  const clock = useFakeClock();
  const bridgeMqtt = connectBridgeUnder(broker.prefix);

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

  for (const [topic, payload] of Object.entries<string>(brokerSpec.retained ?? {})) await broker.publish(topic, payload, { retain: true });

  setBridgeEnv({
    HOSTNAME: panelSpec.down ? `127.0.0.1:${await reservePort()}` : panel.hostname,
    USERNAME: login.username,
    PASSWORD: login.password,
    MQTT_HOSTNAME: broker.hostname,
    MQTT_PORT: String(broker.port),
    ...env,
  });

  // rawListeners, not listeners: a handler registered with once() must be removed by its first call, as a real signal would.
  const sigtermBefore = process.rawListeners('SIGTERM');
  const shutdownHandlers = () => process.rawListeners('SIGTERM').filter((listener) => !sigtermBefore.includes(listener));
  const exitCodes = () => exit.mock.calls.map(([code]) => code);

  const world = {
    panel,
    broker,
    clock,
    logs,
    exitCodes,
    seen: { published: 0, requests: 0, exits: 0, errors: 0 },
    hungRequests: (panelSpec.faults ?? []).some((fault) => fault.kind === 'hang'),
    load: () => require('../../src/app.js'),
    awaitReady: () => waitFor(() => bridgeMqtt.subscribed.length === 2, {
      timeout: READY_TIMEOUT_MS, interval: WAIT_INTERVAL_MS, message: 'the bridge to subscribe to both command topics',
    }),
  };

  // The bridge's own shutdown path stops its timers and closes its REST server, which a mocked
  // process.exit would otherwise leave running. The panel goes first: a request still hanging at
  // this point must fail while the 'error' handler is attached, because stop() detaches it.
  onCleanup(async () => {
    await panel.stop();
    if (world.hungRequests) await settle(QUIET_MS);
    const handlers = shutdownHandlers();
    if (handlers.length > 0) {
      const exitsBefore = exitCodes().length;
      // Best effort: a throw here would abort the cleanup loop and leave servers, port claims and listeners behind
      // for every later test, turning one failure into dozens.
      await Promise.resolve()
        .then(() => handlers.forEach((handler) => handler('SIGTERM')))
        .then(() => waitFor(() => exitCodes().length > exitsBefore, { interval: 1, message: 'the shutdown to finish' }))
        .catch(() => {});
    }
    // Left alone the client stays connected, or redials from a real timer once the fake clock is gone. A connected
    // client calls process.exit when it closes: that must land on the spy, so this runs before the spy and the clock
    // are restored.
    await Promise.all(bridgeMqtt.clients.map((client) => new Promise<void>((resolve) => {
      // Only a live stream still has a 'close' to wait for.
      if (client.connected) client.once('close', resolve);
      else resolve();
      client.end(true);
    })));
  });

  return world;
}

type World = Awaited<ReturnType<typeof createBridge>>;

async function perform(world: World, step: Step) {
  if (step.panel_status) world.panel.setStatus(step.panel_status);
  if (step.panel_fault) {
    addFault(world.panel, step.panel_fault);
    world.hungRequests ||= step.panel_fault.kind === 'hang';
  }
  if (step.panel_expire_session) world.panel.expireSession();
  if (step.panel_down) await world.panel.stop();
  if (step.mqtt_command) {
    const { topic, payload } = typeof step.mqtt_command === 'string'
      ? { topic: `paradox/command/${step.mqtt_command}`, payload: '' }
      : step.mqtt_command;
    await world.broker.publish(topic, payload);
  }
  if (step.advance_ms) await world.clock.advance(step.advance_ms);
}

/**
 * Waits until the expected effects showed up, lets stray extra effects arrive, then compares
 * everything that happened since the previous check with the expectation.
 */
async function expectOutcome(world: World, expected: Expect, { checkRequests = true, quiet = true } = {}) {
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
  const reached = () => {
    const now = fresh();
    return now.published.length >= wantPublished.length
      && (!checkRequests || now.requests.length >= wantRequestTotal)
      && now.exits.length >= wantExits.length
      && (expected.logged_error !== true || now.errors.length > 0);
  };
  // On a timeout the comparison below reports what is missing, which beats a bare timeout error.
  await waitFor(reached, { timeout: REACH_TIMEOUT_MS, interval: WAIT_INTERVAL_MS }).catch(() => {});
  if (quiet) await settle(QUIET_MS);
  // What makes "the bridge published nothing more" checkable.
  await broker.barrier();

  const now = fresh();
  const actual: Record<string, any> = { mqtt_published: now.published, process_exit: now.exits };
  const wanted: Record<string, any> = { mqtt_published: wantPublished, process_exit: wantExits };
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
  if (expected.broker_retained !== undefined) {
    actual.broker_retained = {};
    for (const topic of Object.keys(expected.broker_retained)) actual.broker_retained[topic] = await broker.retained(topic);
    wanted.broker_retained = expected.broker_retained;
  }

  expect(actual).toEqual(wanted);

  world.seen.published += now.published.length;
  world.seen.requests += now.requests.length;
  world.seen.exits += now.exits.length;
  world.seen.errors += now.errors.length;
}

/** The bridge publishes every message retained: a client that subscribes afterwards gets the last payload of each topic. */
async function expectRetainedState(broker: Broker) {
  const last = {};
  broker.published.forEach(({ topic, payload }) => { last[topic] = payload; });
  const actual = {};
  for (const topic of Object.keys(last)) actual[topic] = await broker.retained(topic);
  expect(actual).toEqual(last);
}

export async function runScenario(row: Scenario) {
  const unhandled: unknown[] = [];
  // Registered before the capture so that it runs after vitest's own handler is back: a failing check must not leave it removed.
  // Also covers rejections raised while the scenario is being torn down.
  onCleanup(() => expect(unhandled).toEqual([]));
  captureUnhandledRejections(unhandled);
  const world = await createBridge(row);
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
