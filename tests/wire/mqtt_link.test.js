import { createRequire } from 'node:module';
import net from 'node:net';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { FakeBroker } from '../mock_mqtt.js';
import { FakePanel } from '../mock_paradox.js';
import {
  captureConsole, loadBridge, loadSpec, onCleanup, reservePort, setBridgeEnv, settle, spyProcessExit, useFakeClock, waitFor,
  withTitle,
} from '../support.js';

const spec = loadSpec('mqtt');
const mqttLib = createRequire(import.meta.url)('mqtt');

const ARM_REQUEST = 'GET /statuslive.html?area=00&value=r';
const DISARM_REQUEST = 'GET /statuslive.html?area=00&value=d';

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
const endAll = (clients) => Promise.all(clients.filter((client) => !client.disconnecting).map((client) => new Promise((resolve) => client.end(true, resolve))));

/**
 * Records every TCP dial the mqtt library makes and sends the connection to `target` instead: the way to see
 * which host and port the bridge dials without owning that port and without a DNS lookup.
 */
function redirectDials(target) {
  const dialed = [];
  const createConnection = net.createConnection;
  vi.spyOn(net, 'createConnection').mockImplementation((port, host) => {
    dialed.push({ host, port });
    return createConnection(target.port, target.hostname);
  });
  return dialed;
}

/** Answers every SUBSCRIBE with the failure code 0x80, as a broker whose ACL forbids the topic does. */
class RefusingSubscriptions extends FakeBroker {
  respond(client, packet) {
    if (packet.cmd !== 'subscribe') {
      super.respond(client, packet);
      return;
    }
    client.send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => 0x80) });
  }
}

/** `broker: false` leaves the MQTT port closed; the port is returned so a test can open it later. */
async function arrange({ broker: brokerOptions = {}, brokerClass = FakeBroker, env = {} } = {}) {
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
async function startLink({ broker, createMqttLink }) {
  const link = await createMqttLink();
  await waitFor(() => broker.subscriptions.length === 2, { message: 'both subscriptions' });
  return link;
}

async function arrangeWithPanel({ panel: panelOptions, ...options } = {}) {
  const panel = await new FakePanel(panelOptions).start();
  const context = await arrange({ ...options, env: { HOSTNAME: panel.hostname, ...options.env } });
  const link = await startLink(context);
  return { ...context, panel, link };
}

/** Observes a promise without awaiting it, so fake-clock tests can assert "still pending" at a given instant. */
function track(promise) {
  const result = { state: 'pending' };
  promise.then(
    (value) => Object.assign(result, { state: 'resolved', value }),
    (error) => Object.assign(result, { state: 'rejected', error }),
  );
  return result;
}

const settled = (tracked) => waitFor(() => tracked.state !== 'pending', { message: 'the connect attempt to settle' });

/** Delivers a PUBLISH to every connected client even if it never subscribed to the topic. */
function deliverToBridge(broker, topic, payload) {
  broker.clients.forEach((client) => client.send({
    cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain: false, dup: false,
  }));
}

/** Writes raw bytes onto the broker side of every client connection. */
function injectBytes(broker, bytes) {
  broker.clients.forEach((client) => client.socket.write(Buffer.from(bytes)));
}

/** Advances the fake clock until `condition` holds; the mqtt client reconnects on its own 1 s timer. */
function advanceUntil(clock, condition, message) {
  return waitFor(async () => {
    await clock.advance(1000);
    return condition();
  }, { message });
}

describe('createMqttLink(): connecting', () => {
  it('connects to MQTT_HOSTNAME:MQTT_PORT with a clean MQTT 3.1.1 session and the configured credentials', async () => {
    const { broker, createMqttLink } = await arrange({ env: { MQTT_USERNAME: 'bridge', MQTT_PASSWORD: 's3cret' } });

    await createMqttLink();

    expect(broker.connects).toHaveLength(1);
    expect(broker.connects[0]).toMatchObject({
      protocolId: 'MQTT', protocolVersion: 4, clean: true, keepalive: 60, username: 'bridge', password: 's3cret',
    });
  });

  it('lets the mqtt library pick a random client id', async () => {
    const { broker, createMqttLink } = await arrange();

    await createMqttLink();

    expect(broker.connects[0].clientId).toMatch(/^mqttjs_[0-9a-f]{8}$/);
  });

  it('KNOWN BUG KB-32: sends no will, so retained states outlive a dead bridge', async () => {
    const { broker, createMqttLink } = await arrange();

    await createMqttLink();

    expect(broker.connects[0].will).toBeUndefined();
  });

  it('logs "MQTT client connected", stays quiet afterwards and returns an object with only publish()', async () => {
    const { broker, exit, output, createMqttLink } = await arrange();

    const link = await startLink({ broker, createMqttLink });
    await settle();

    expect(Object.keys(link)).toEqual(['publish']);
    expect(output.log).toEqual([['MQTT client connected']]);
    expect(output.error).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('subscribes to the arm and disarm command topics only, at QoS 0', async () => {
    const { broker, createMqttLink } = await arrange();

    await startLink({ broker, createMqttLink });
    await settle();

    const subscriptions = broker.packets.filter((packet) => packet.cmd === 'subscribe').flatMap((packet) => packet.subscriptions);
    expect(subscriptions.sort((a, b) => a.topic.localeCompare(b.topic))).toEqual([
      { topic: 'paradox/command/arm', qos: 0 },
      { topic: 'paradox/command/disarm', qos: 0 },
    ]);
  });

  it('KNOWN BUG KB-30: a refused subscription goes unnoticed, the link resolves and logs nothing more', async () => {
    const { broker, exit, output, createMqttLink } = await arrange({ brokerClass: RefusingSubscriptions });

    await startLink({ broker, createMqttLink });
    await settle();

    expect(output.log).toEqual([['MQTT client connected']]);
    expect(output.error).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('leaves no connect-timeout timer behind once connected', async () => {
    const { broker, clients, createMqttLink } = await arrange();

    await startLink({ broker, createMqttLink });
    await endAll(clients); // the client's own keep-alive timer goes with it

    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no connect-timeout timer behind after a refused login', async () => {
    const { clients, createMqttLink } = await arrange({ broker: { credentials: { username: 'admin', password: 'secret' } } });

    await settled(track(createMqttLink()));
    await endAll(clients);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('connects when the broker demands exactly the configured credentials', async () => {
    const { broker, createMqttLink } = await arrange({ broker: { credentials: { username: 'mqttuser', password: 'mqttpass' } } });

    await startLink({ broker, createMqttLink });

    expect(broker.connects).toHaveLength(1);
  });

  it('dials MQTT_HOSTNAME and MQTT_PORT, both from the environment', async () => {
    const { broker, createMqttLink } = await arrange({ env: { MQTT_HOSTNAME: 'broker.example' } });
    const dialed = redirectDials(broker);

    await createMqttLink();

    expect(dialed).toEqual([{ host: 'broker.example', port: broker.port }]);
  });
});

describe('createMqttLink(): credentials in the connection URL', () => {
  it.each(withTitle(spec.credentials))('$title', async ({
    username, password, expected_broker_username: brokerUsername, expected_broker_password: brokerPassword, expected_connect_error: expectedError,
    expected_dialed: expectedDialed,
  }) => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined); // Node 24 warns about URLs it has to guess at
    const { broker, clock, output, createMqttLink } = await arrange({ env: { MQTT_USERNAME: username, MQTT_PASSWORD: password } });
    // Whatever the bridge dials instead of the broker goes to a closed port: no DNS, no stray connection.
    const dialed = expectedError ? redirectDials({ hostname: '127.0.0.1', port: await reservePort() }) : [];

    const link = track(createMqttLink());
    if (expectedError) {
      if (expectedError.after_ms > 0) await clock.advance(expectedError.after_ms);
      await settled(link);
      await settle();
      expect(link.state).toBe('rejected');
      expect(link.error.message).toBe(expectedError.message);
      expect(broker.connects).toEqual([]);
      expect(output.error).toEqual([]);
      // The mqtt client redials on its own 1 s timer, so the same wrong target may be dialed repeatedly.
      expect([...new Set(dialed.map(({ host, port }) => `${host}:${port}`))]).toEqual(expectedDialed ? [`${expectedDialed.host}:${expectedDialed.port}`] : []);
      return;
    }

    await settled(link);
    expect(link.state).toBe('resolved');
    expect(broker.connects).toHaveLength(1);
    expect(broker.connects[0].username).toBe(brokerUsername);
    expect(broker.connects[0].password ?? null).toBe(brokerPassword);
  });
});

describe('createMqttLink(): MQTT_PORT', () => {
  it.each(withTitle(spec.broker_ports.filter((row) => row.expected_dialed_port)))('$title', async ({ mqtt_port: mqttPort, expected_dialed_port: expectedPort }) => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const { broker, createMqttLink } = await arrange({ env: { MQTT_PORT: mqttPort } });
    const dialed = redirectDials(broker);

    await createMqttLink();

    expect(dialed).toEqual([{ host: '127.0.0.1', port: expectedPort }]);
  });

  it.each(withTitle(spec.broker_ports.filter((row) => row.expected_connect_error)))('$title', async ({ mqtt_port: mqttPort, expected_connect_error: expectedError }) => {
    const { broker, output, createMqttLink } = await arrange({ env: { MQTT_PORT: mqttPort } });

    const link = track(createMqttLink());
    await settled(link);

    expect(link.state).toBe('rejected');
    expect(link.error.message.startsWith(expectedError.message_prefix)).toBe(true);
    expect(broker.connects).toEqual([]);
    expect(output.error).toEqual([]);
  });
});

describe('createMqttLink(): MQTT_HOSTNAME', () => {
  it.each(withTitle(spec.broker_hosts))('$title', async ({ mqtt_hostname: hostname, mqtt_port: mqttPort, expected_dialed: expected }) => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const { broker, createMqttLink } = await arrange({ env: { MQTT_HOSTNAME: hostname, MQTT_PORT: mqttPort } });
    const dialed = redirectDials(broker);

    await createMqttLink();

    expect(dialed).toEqual([expected]);
  });
});

describe('createMqttLink(): secrets', () => {
  const PASSWORD = 'Sup3r-Secret-Pw';

  it('never logs the MQTT password while connecting, publishing or failing a command', async () => {
    const panel = await new FakePanel().start();
    const context = await arrange({ env: { HOSTNAME: panel.hostname, MQTT_PASSWORD: PASSWORD } });
    panel.respondWith('/statuslive.html', { status: 500, headers: {}, body: 'boom' });
    const link = await startLink(context);

    link.publish('t/x', 'x');
    context.broker.publish('paradox/command/arm', 'ON');
    await waitFor(() => context.output.error.length === 1, { message: 'the failed command' });

    expect(context.output.log.length).toBeGreaterThan(1);
    expect(inspect(context.output, { depth: 8 })).not.toContain(PASSWORD);
  });

  it('never logs the MQTT password when the broker refuses the login', async () => {
    const { output, createMqttLink } = await arrange({
      broker: { credentials: { username: 'admin', password: 'secret' } }, env: { MQTT_PASSWORD: PASSWORD },
    });

    const link = track(createMqttLink());
    await settled(link);

    expect(output.error).toHaveLength(1);
    expect(inspect([output, link.error], { depth: 8 })).not.toContain(PASSWORD);
  });
});

describe('createMqttLink(): connection failures', () => {
  it('rejects with the broker refusal and logs the same error when the credentials are wrong', async () => {
    const { broker, exit, output, createMqttLink } = await arrange({ broker: { credentials: { username: 'admin', password: 'secret' } } });

    const link = track(createMqttLink());
    await settled(link);

    expect(link.state).toBe('rejected');
    expect(link.error).toMatchObject({ message: 'Connection refused: Bad username or password', code: 4 });
    expect(output.error).toHaveLength(1);
    expect(output.error[0][0]).toBe(link.error);
    expect(exit).not.toHaveBeenCalled();
    await settle();
    expect(broker.subscriptions).toEqual([]);
  });

  it.each(spec.connack_refusals)('rejects when the broker answers CONNECT with $name', async ({
    return_code: returnCode, expected_error_code: code, expected_error_message: message,
  }) => {
    const { broker, output, createMqttLink } = await arrange({ broker: { silent: true } });

    const link = track(createMqttLink());
    await waitFor(() => broker.connects.length === 1, { message: 'CONNECT' });
    injectBytes(broker, [0x20, 0x02, 0x00, returnCode]);
    await settled(link);

    expect(link.state).toBe('rejected');
    expect(link.error).toMatchObject({ message, code });
    expect(output.error).toHaveLength(1);
    expect(output.error[0][0]).toBe(link.error);
  });

  it('rejects with "MQTT connect timeout" exactly 5 s after starting when the broker never answers, without logging', async () => {
    const { broker, clock, exit, output, createMqttLink } = await arrange({ broker: { silent: true } });

    const link = track(createMqttLink());
    await waitFor(() => broker.connects.length === 1, { message: 'CONNECT' });
    await clock.advance(4999);
    expect(link.state).toBe('pending');
    await clock.advance(1);
    await settled(link);

    expect(link.state).toBe('rejected');
    expect(link.error).toBeInstanceOf(Error);
    expect(link.error.message).toBe('MQTT connect timeout');
    expect(output.error).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('KNOWN BUG KB-34: an unreachable broker is reported only as the connect timeout, never as a connection error', async () => {
    const { clock, output, createMqttLink } = await arrange({ broker: false });

    const link = track(createMqttLink());
    await clock.advance(4999);
    expect(link.state).toBe('pending');
    await clock.advance(1);
    await settled(link);

    expect(link.state).toBe('rejected');
    expect(link.error.message).toBe('MQTT connect timeout');
    expect(output.error).toEqual([]);
  });

  it('KNOWN BUG KB-17: keeps reconnecting after the connect timeout; a new CONNECT reaches the silent broker', async () => {
    const { broker, clock, createMqttLink } = await arrange({ broker: { silent: true } });
    const link = track(createMqttLink());
    await waitFor(() => broker.connects.length === 1, { message: 'first CONNECT' });
    await clock.advance(5000);
    await settled(link);
    expect(link.error.message).toBe('MQTT connect timeout');

    // The mqtt client gives up on the silent connection after its own 30 s CONNACK timeout and redials.
    await clock.advance(25000);
    await advanceUntil(clock, () => broker.connects.length >= 2, 'a second CONNECT');

    expect(broker.connects).toHaveLength(2);
  });

  it('KNOWN BUG KB-17: connects late after the timeout, logs "MQTT client connected" and exits when that connection drops', async () => {
    const { port, clock, exit, output, createMqttLink } = await arrange({ broker: false });
    const link = track(createMqttLink());
    await clock.advance(5000);
    await settled(link);
    expect(link.error.message).toBe('MQTT connect timeout');

    const broker = await new FakeBroker().start(port);
    await advanceUntil(clock, () => broker.connects.length >= 1, 'a late CONNECT');
    await waitFor(() => output.log.length === 1, { message: 'the connected log line' });

    expect(output.log).toEqual([['MQTT client connected']]);
    await settle();
    expect(broker.subscriptions).toEqual([]);
    expect(exit).not.toHaveBeenCalled();

    broker.dropClients();
    await waitFor(() => exit.mock.calls.length > 0, { message: 'process.exit' });
    expect(exit.mock.calls).toEqual([[1]]);
  });

  it('KNOWN BUG KB-17: a refused login leaves the client redialing, and the old error handler logs every refusal (KB-7)', async () => {
    const { broker, clock, exit, output, createMqttLink } = await arrange({ broker: { credentials: { username: 'admin', password: 'secret' } } });
    const link = track(createMqttLink());
    await settled(link);
    expect(output.error).toHaveLength(1);

    broker.dropClients(); // a real broker closes the connection after refusing the login; the fake leaves it open
    await advanceUntil(clock, () => broker.connects.length >= 2, 'a second CONNECT');
    await waitFor(() => output.error.length === 2, { message: 'the second refusal to be logged' });

    expect(output.error[1][0]).toMatchObject({ message: 'Connection refused: Bad username or password', code: 4 });
    expect(output.error[1][0]).not.toBe(output.error[0][0]);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('createMqttLink(): losing the connection after it was established', () => {
  it('KNOWN BUG KB-29: exits with code 1 when the broker drops the connection', async () => {
    const { broker, exit, output, createMqttLink } = await arrange();
    await startLink({ broker, createMqttLink });

    broker.dropClients();
    await waitFor(() => exit.mock.calls.length > 0, { message: 'process.exit' });
    await settle();

    expect(exit.mock.calls).toEqual([[1]]);
    expect(output.error).toEqual([]);
  });

  it('KNOWN BUG KB-29: exits with code 1 when the broker shuts down', async () => {
    const { broker, exit, createMqttLink } = await arrange();
    await startLink({ broker, createMqttLink });

    await broker.stop();
    await waitFor(() => exit.mock.calls.length > 0, { message: 'process.exit' });

    expect(exit.mock.calls).toEqual([[1]]);
  });

  it('KNOWN BUG KB-7: a protocol error exits with code 1 and is ALSO logged, because the pre-connect error handler is still attached', async () => {
    const { broker, exit, output, createMqttLink } = await arrange();
    await startLink({ broker, createMqttLink });

    injectBytes(broker, [0x20, 0x02, 0x00, 0x04]); // a second CONNACK, refusing the login
    await waitFor(() => exit.mock.calls.length > 0, { message: 'process.exit' });
    await settle();

    expect(exit.mock.calls).toEqual([[1]]);
    expect(output.error).toHaveLength(1);
    expect(output.error[0][0]).toMatchObject({ message: 'Connection refused: Bad username or password', code: 4 });
  });

  it('KNOWN BUG KB-7: a malformed packet exits with code 1 and is also logged', async () => {
    const { broker, exit, output, createMqttLink } = await arrange();
    await startLink({ broker, createMqttLink });

    injectBytes(broker, [0x00, 0x00]); // packet type 0 does not exist
    await waitFor(() => exit.mock.calls.length > 0, { message: 'process.exit' });
    await settle();

    expect(exit.mock.calls).toEqual([[1]]);
    expect(output.error).toHaveLength(1);
    expect(output.error[0][0]).toBeInstanceOf(Error);
  });
});

describe('publish()', () => {
  it('forwards topic and payload with retain false and QoS 0 when no options are given, and logs it', async () => {
    const { broker, output, createMqttLink } = await arrange();
    const link = await startLink({ broker, createMqttLink });

    link.publish('paradox/status/armed', 'ON');
    await waitFor(() => broker.published.length === 1, { message: 'the published message' });

    expect(broker.published).toEqual([{ topic: 'paradox/status/armed', payload: 'ON', retain: false, qos: 0 }]);
    expect(output.log).toEqual([['MQTT client connected'], ['publish', 'paradox/status/armed', 'ON']]);
  });

  it('passes retain: true through', async () => {
    const { broker, createMqttLink } = await arrange();
    const link = await startLink({ broker, createMqttLink });

    link.publish('paradox/sensor/3', 'OFF', { retain: true });
    await waitFor(() => broker.published.length === 1, { message: 'the published message' });

    expect(broker.published).toEqual([{ topic: 'paradox/sensor/3', payload: 'OFF', retain: true, qos: 0 }]);
  });

  it('passes an explicit retain: false through', async () => {
    const { broker, createMqttLink } = await arrange();
    const link = await startLink({ broker, createMqttLink });

    link.publish('paradox/sensor/3', 'ON', { retain: false });
    await waitFor(() => broker.published.length === 1, { message: 'the published message' });

    expect(broker.published).toEqual([{ topic: 'paradox/sensor/3', payload: 'ON', retain: false, qos: 0 }]);
  });

  it('forwards other publish options unchanged (qos)', async () => {
    const { broker, createMqttLink } = await arrange();
    const link = await startLink({ broker, createMqttLink });

    link.publish('t/qos', 'x', { qos: 1, retain: true });
    await waitFor(() => broker.published.length === 1, { message: 'the published message' });

    expect(broker.published).toEqual([{ topic: 't/qos', payload: 'x', retain: true, qos: 1 }]);
  });

  it('sends an empty payload and non-ASCII text as UTF-8', async () => {
    const { broker, createMqttLink } = await arrange();
    const link = await startLink({ broker, createMqttLink });

    link.publish('t/empty', '');
    link.publish('t/unicode', 'Obývačka €');
    await waitFor(() => broker.published.length === 2, { message: 'both messages' });

    expect(broker.published.map(({ topic, payload }) => [topic, payload])).toEqual([['t/empty', ''], ['t/unicode', 'Obývačka €']]);
  });

  it('delivers consecutive publishes in call order', async () => {
    const { broker, createMqttLink } = await arrange();
    const link = await startLink({ broker, createMqttLink });

    ['a', 'b', 'c', 'd'].forEach((suffix) => link.publish(`t/${suffix}`, suffix));
    await waitFor(() => broker.published.length === 4, { message: 'all messages' });

    expect(broker.published.map(({ topic }) => topic)).toEqual(['t/a', 't/b', 't/c', 't/d']);
  });
});

describe('commands received from the broker', () => {
  it.each(withTitle(spec.commands))('$title', async ({ messages, expected_panel_requests: expected }) => {
    const { broker, panel } = await arrangeWithPanel();

    messages.forEach(({ topic, payload }) => deliverToBridge(broker, topic, payload));
    // Messages are handled in order, so once this sentinel's request has arrived everything before it was handled too.
    broker.publish('paradox/command/disarm', 'sentinel');
    const all = [...expected, DISARM_REQUEST].sort();
    await waitFor(() => panel.requestLines.length >= all.length, { message: 'the panel requests' });
    await settle(); // requests are separate connections: a stray one may still be on its way

    expect([...panel.requestLines].sort()).toEqual(all);
  });

  it('arms through a subscribed topic published by another client', async () => {
    const { broker, panel } = await arrangeWithPanel();

    broker.publish('paradox/command/arm', 'ON');
    await waitFor(() => panel.requestLines.length === 1, { message: 'the arm request' });
    await settle();

    expect(panel.requestLines).toEqual([ARM_REQUEST]);
  });

  it('disarms through a subscribed topic published by another client', async () => {
    const { broker, panel } = await arrangeWithPanel();

    broker.publish('paradox/command/disarm', 'OFF');
    await waitFor(() => panel.requestLines.length === 1, { message: 'the disarm request' });
    await settle();

    expect(panel.requestLines).toEqual([DISARM_REQUEST]);
  });

  it.each([
    ['paradox/command/arm', ARM_REQUEST],
    ['paradox/command/disarm', DISARM_REQUEST],
  ])('KNOWN BUG KB-31: a retained %s message is executed again on every start', async (topic, request) => {
    const panel = await new FakePanel().start();
    const context = await arrange({ env: { HOSTNAME: panel.hostname } });
    context.broker.publish(topic, 'ON', { retain: true });

    await startLink(context);
    await waitFor(() => panel.requestLines.length === 1, { message: 'the replayed command' });
    await settle();

    expect(panel.requestLines).toEqual([request]);
  });

  it('keeps working after a command failed with an HTTP error, and logs the error', async () => {
    const { broker, panel, exit, output } = await arrangeWithPanel();
    panel.respondWith('/statuslive.html', { status: 500, headers: {}, body: 'boom' }, { times: 1 });

    broker.publish('paradox/command/arm', 'ON');
    await waitFor(() => output.error.length === 1, { message: 'the logged error' });
    broker.publish('paradox/command/arm', 'ON');
    await waitFor(() => panel.requestLines.length === 2, { message: 'the second request' });

    expect(output.error[0][0]).toBeInstanceOf(Error);
    expect(output.error[0][0].message).toBe('Request failed with status code 500');
    expect(exit).not.toHaveBeenCalled();
    expect(panel.requestLines).toEqual([ARM_REQUEST, ARM_REQUEST]);
    await settle();
    expect(output.error).toHaveLength(1);
  });

  it('KNOWN BUG KB-14: a command that the panel answers with its login page (expired session) counts as done and nothing is logged', async () => {
    const { broker, panel, exit, output } = await arrangeWithPanel({ panel: { requireLogin: true } });

    broker.publish('paradox/command/arm', 'ON');
    await waitFor(() => panel.requestLines.length === 1, { message: 'the arm request' });
    await settle();

    expect(panel.requestLines).toEqual([ARM_REQUEST]);
    expect(output.error).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('logs the error and keeps running when the panel is down', async () => {
    const { broker, panel, exit, output } = await arrangeWithPanel();
    await panel.stop();

    broker.publish('paradox/command/disarm', 'OFF');
    await waitFor(() => output.error.length === 1, { message: 'the logged error' });

    expect(output.error[0][0]).toMatchObject({ code: 'ECONNREFUSED' });
    expect(exit).not.toHaveBeenCalled();
  });

  it('logs the error and keeps running when the panel resets the connection', async () => {
    const { broker, panel, exit, output } = await arrangeWithPanel();
    panel.respondWith('/statuslive.html', { destroy: true }, { times: 1 });

    broker.publish('paradox/command/arm', 'ON');
    await waitFor(() => output.error.length === 1, { message: 'the logged error' });

    expect(output.error[0][0]).toMatchObject({ code: 'ECONNRESET' });
    expect(exit).not.toHaveBeenCalled();
  });

  it('KNOWN BUG KB-13: a command to a hung panel neither fails nor blocks the next command, and fails only when the connection dies', async () => {
    const { broker, panel, output } = await arrangeWithPanel();
    panel.respondWith('/statuslive.html', { hang: true }, { times: 1 });

    broker.publish('paradox/command/arm', 'ON');
    await waitFor(() => panel.requestLines.length === 1, { message: 'the hung request' });
    broker.publish('paradox/command/disarm', 'OFF');
    await waitFor(() => panel.requestLines.length === 2, { message: 'the second request' });
    await settle();

    expect(panel.requestLines).toEqual([ARM_REQUEST, DISARM_REQUEST]);
    expect(output.error).toEqual([]);

    await panel.stop();
    await waitFor(() => output.error.length === 1, { message: 'the hung request to fail' });
    expect(output.error[0][0]).toMatchObject({ code: 'ECONNRESET' });
  });
});
