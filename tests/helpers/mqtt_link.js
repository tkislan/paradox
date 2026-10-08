import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { expect, vi } from 'vitest';
import { FakePanel } from '../mock_paradox.js';
import { leaseBroker } from '../mosquitto.js';
import {
  BUILD_DIR, captureConsole, loadBridge, loadSpec, onCleanup, setBridgeEnv, settle, spyProcessExit, useFakeClock,
  waitFor,
} from '../support.js';
import { track } from './outcomes.js';

vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 }); // a test may wait for a free broker (up to 60 s) before it starts; its cleanup talks to the broker too

export const spec = loadSpec('mqtt');

export const ARM_REQUEST = 'GET /statuslive.html?area=00&value=r';

export const DISARM_REQUEST = 'GET /statuslive.html?area=00&value=d';

export const ARM_TOPIC = 'paradox/command/arm';

export const DISARM_TOPIC = 'paradox/command/disarm';

// A password no log line may ever contain.
export const SECRET_PASSWORD = 'Sup3r-Secret-Pw';

// The brokers answer through a docker log stream and a real network, so waits are generous; fake time never limits them.
export const eventually = (condition, message) => waitFor(condition, { timeout: 15000, message });

// The link never exposes its MQTT client. One left open would reconnect forever and, once its broker is gone,
// call the real process.exit after the exit recorder has been removed, so each test closes its clients while
// the recorder is still installed. With redirectDials, the only place the suite looks past the wire.
function closeMqttClientsAfterTest() {
  const mqttLib = createRequire(path.join(BUILD_DIR, 'mqtt_link.js'))('mqtt'); // the module instance the bridge itself gets
  const connect = mqttLib.connect;
  const clients = [];
  vi.spyOn(mqttLib, 'connect').mockImplementation((...args) => {
    const client = connect(...args);
    clients.push(client);
    return client;
  });
  onCleanup(() => endAll(clients));
  return clients;
}

// end() on a client that is already ending never calls back, so tests that end clients themselves must not hang the cleanup.
export const endAll = (clients) => Promise.all(clients.filter((client) => !client.disconnecting).map((client) => new Promise((resolve) => client.end(true, resolve))));

/**
 * Records every TCP dial the mqtt library makes and sends the connection to `target` instead: the way to see
 * which host and port the bridge dials without owning that port and without a DNS lookup. Only the bridge's
 * dials (a numeric port) are touched; the harness's own client dials normally.
 */
export function redirectDials(target) {
  const dialed = [];
  const createConnection = net.createConnection;
  vi.spyOn(net, 'createConnection').mockImplementation((...args) => {
    if (typeof args[0] !== 'number') return createConnection(...args);
    const [port, host] = args;
    dialed.push({ host, port });
    return createConnection(target.port, target.hostname);
  });
  return dialed;
}

/** A QoS 0 PUBLISH exactly as a broker would send it (short enough for a one-byte remaining length). */
export function publishPacket(topic, payload) {
  const topicBytes = Buffer.from(topic);
  const body = Buffer.from(payload);
  return Buffer.concat([Buffer.from([0x30, 2 + topicBytes.length + body.length, topicBytes.length >> 8, topicBytes.length & 0xff]), topicBytes, body]);
}

/**
 * Leases a broker and points the bridge's environment at it. `route` puts a faultable `proxy`, a CONNECT
 * `proxy` in between ('silent': a black-holed proxy, a broker that reads the CONNECT and never answers); the bridge logs in as the lease's default user unless `env` says otherwise.
 */
export async function arrange({ route = 'direct', env = {} } = {}) {
  const broker = await leaseBroker();
  const proxy = route === 'direct' ? null : await broker.proxy();
  if (route === 'silent') proxy.blackhole();
  const target = proxy ?? broker;
  const output = captureConsole();
  const clock = useFakeClock();
  const exit = spyProcessExit();
  const clients = closeMqttClientsAfterTest();
  setBridgeEnv({
    MQTT_HOSTNAME: target.hostname,
    MQTT_PORT: target.port,
    MQTT_USERNAME: broker.credentials.username,
    MQTT_PASSWORD: broker.credentials.password,
    ...env,
  });
  const { createMqttLink } = loadBridge().load('mqtt_link.js');
  return { broker, proxy, clock, exit, output, clients, createMqttLink };
}

/** Connects the link and waits until the broker has seen both SUBSCRIBE packets. */
export async function startLink({ broker, createMqttLink }) {
  const link = await createMqttLink();
  await eventually(() => broker.subscriptions.length === 2, 'both subscriptions');
  return link;
}

export async function arrangeWithPanel({ panel: panelOptions, ...options } = {}) {
  const panel = await new FakePanel(panelOptions).start();
  const context = await arrange({ ...options, env: { HOSTNAME: panel.hostname, ...options.env } });
  const link = await startLink(context);
  return { ...context, panel, link };
}

// Mosquitto logs a refused topic as "(denied)" where it logs the QoS of a granted one, which `broker.subscriptions` does not list.

// What the code under test did to the broker. `broker.events` is no use for "nothing happened": it can list a disconnect
// of the compose healthcheck whose connect line predates the lease.
export const NOTHING = { connects: [], connacks: [], subscriptions: [], clientPublishes: [] };

export const seenByBroker = ({ connects, connacks, subscriptions, clientPublishes }) => ({ connects, connacks, subscriptions, clientPublishes });

export const settled = (tracked) => eventually(() => tracked.state !== 'pending', 'the connect attempt to settle');

/**
 * Advances the fake clock in 1 s steps until `condition` holds; the mqtt client redials on its own 1 s timer.
 * The condition is checked first and the steps are spaced out in real time, so a redial can finish before the
 * next step would start another one.
 */
export function advanceUntil(clock, condition, message) {
  return waitFor(async () => {
    if (await condition()) return true;
    await clock.advance(1000);
    return false;
  }, { timeout: 15000, interval: 50, message });
}

export async function expectCredentialsReachBroker({
  username, password, expected_broker_username: brokerUsername, expected_broker_password: brokerPassword, expected_login: expectedLogin = 'accepted',
}) {
  vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined); // Node 24 warns about URLs it has to guess at
  const { broker, proxy, createMqttLink } = await arrange({ route: 'proxy', env: { MQTT_USERNAME: username, MQTT_PASSWORD: password } });
  // A refused row still gets an account of that name, so the refusal can only be about the password that never arrived.
  await broker.addUser({ username: brokerUsername, password: brokerPassword ?? 'not-the-missing-one' });

  const link = track(createMqttLink());
  await settled(link);
  await broker.syncLog();

  expect(proxy.connects.map(({ username: sent, password: sentPassword }) => ({ username: sent, password: sentPassword }))).toEqual([{ username: brokerUsername, password: brokerPassword }]);
  if (expectedLogin === 'refused') {
    expect(link.state).toBe('rejected');
    expect(link.error).toMatchObject({ message: 'Connection refused: Not authorized', code: 5 });
    expect(broker.connacks).toEqual([5]);
    return;
  }
  expect(link.state).toBe('resolved');
  expect(broker.connacks).toEqual([0]);
  expect(broker.connects).toHaveLength(1);
  expect(broker.connects[0].username).toBe(brokerUsername);
}

export async function expectPortDialed({ mqtt_port: mqttPort, expected_dialed_port: expectedPort }) {
  vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
  const { broker, createMqttLink } = await arrange({ env: { MQTT_PORT: mqttPort } });
  const dialed = redirectDials(broker);

  await createMqttLink();

  expect(dialed).toEqual([{ host: '127.0.0.1', port: expectedPort }]);
}

export async function expectHostDialed({ mqtt_hostname: hostname, mqtt_port: mqttPort, expected_dialed: expected }) {
  vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
  const { broker, createMqttLink } = await arrange({ env: { MQTT_HOSTNAME: hostname, MQTT_PORT: mqttPort } });
  const dialed = redirectDials(broker);

  await createMqttLink();

  expect(dialed).toEqual([expected]);
}

export async function expectCommandsExecuted({ messages, expected_panel_requests: expected }) {
  const { broker, panel } = await arrangeWithPanel();

  for (const { topic, payload } of messages) await broker.publish(topic, payload);
  // Messages are handled in order, so once this sentinel's request has arrived everything before it was handled too.
  await broker.publish(DISARM_TOPIC, 'sentinel');
  const all = [...expected, DISARM_REQUEST].sort();
  await eventually(() => panel.requestLines.length >= all.length, 'the panel requests');
  await settle(); // requests are separate connections: a stray one may still be on its way

  expect([...panel.requestLines].sort()).toEqual(all);
}
