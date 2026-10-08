import { createRequire } from 'node:module';
import net from 'node:net';
import { vi } from 'vitest';
import { FakeBroker } from '../mock_mqtt.js';
import { FakePanel } from '../mock_paradox.js';
import {
  captureConsole, loadBridge, loadSpec, onCleanup, reservePort, setBridgeEnv, spyProcessExit, useFakeClock, waitFor,
} from '../support.js';

export const spec = loadSpec('mqtt');

const mqttLib = createRequire(import.meta.url)('mqtt');

export const ARM_REQUEST = 'GET /statuslive.html?area=00&value=r';

export const DISARM_REQUEST = 'GET /statuslive.html?area=00&value=d';

// A password no log line may ever contain.
export const SECRET_PASSWORD = 'Sup3r-Secret-Pw';

// The link never exposes its MQTT client. One left open would reconnect forever and, once its broker is gone,
// call the real process.exit after the exit recorder has been removed, so each test closes its clients while
// the recorder is still installed. With redirectDials, the only place the suite looks past the wire.
function closeMqttClientsAfterTest() {
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
 * which host and port the bridge dials without owning that port and without a DNS lookup.
 */
export function redirectDials(target) {
  const dialed = [];
  const createConnection = net.createConnection;
  vi.spyOn(net, 'createConnection').mockImplementation((port, host) => {
    dialed.push({ host, port });
    return createConnection(target.port, target.hostname);
  });
  return dialed;
}

/** Answers every SUBSCRIBE with the failure code 0x80, as a broker whose ACL forbids the topic does. */
export class RefusingSubscriptions extends FakeBroker {
  respond(client, packet) {
    if (packet.cmd !== 'subscribe') {
      super.respond(client, packet);
      return;
    }
    client.send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => 0x80) });
  }
}

/** `broker: false` leaves the MQTT port closed; the port is returned so a test can open it later. */
export async function arrange({ broker: brokerOptions = {}, brokerClass = FakeBroker, env = {} } = {}) {
  const output = captureConsole();
  const clock = useFakeClock();
  const exit = spyProcessExit();
  let broker = null;
  let port;
  if (brokerOptions === false) {
    port = await reservePort();
  } else {
    broker = await new brokerClass(brokerOptions).start();
    port = broker.port;
  }
  const clients = closeMqttClientsAfterTest();
  setBridgeEnv({ MQTT_PORT: port, ...env });
  const { createMqttLink } = loadBridge().load('mqtt_link.js');
  return { broker, port, clock, exit, output, clients, createMqttLink };
}

/** Connects the link and waits until the broker has seen both SUBSCRIBE packets. */
export async function startLink({ broker, createMqttLink }) {
  const link = await createMqttLink();
  await waitFor(() => broker.subscriptions.length === 2, { message: 'both subscriptions' });
  return link;
}

export async function arrangeWithPanel({ panel: panelOptions, ...options } = {}) {
  const panel = await new FakePanel(panelOptions).start();
  const context = await arrange({ ...options, env: { HOSTNAME: panel.hostname, ...options.env } });
  const link = await startLink(context);
  return { ...context, panel, link };
}

export const settled = (tracked) => waitFor(() => tracked.state !== 'pending', { message: 'the connect attempt to settle' });

/** Delivers a PUBLISH to every connected client even if it never subscribed to the topic. */
export function deliverToBridge(broker, topic, payload) {
  broker.clients.forEach((client) => client.send({
    cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain: false, dup: false,
  }));
}

/** Writes raw bytes onto the broker side of every client connection. */
export function injectBytes(broker, bytes) {
  broker.clients.forEach((client) => client.socket.write(Buffer.from(bytes)));
}

/** Advances the fake clock until `condition` holds; the mqtt client reconnects on its own 1 s timer. */
export function advanceUntil(clock, condition, message) {
  return waitFor(async () => {
    await clock.advance(1000);
    return condition();
  }, { message });
}
