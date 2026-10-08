import { describe, expect, it, vi } from 'vitest';
import { FakePanel } from '../mock_paradox.js';
import { track } from '../helpers/outcomes.js';
import { loadKnownBugSpec, reservePort, settle, withTitle } from '../support.js';
import {
  ARM_REQUEST, ARM_TOPIC, DISARM_REQUEST, DISARM_TOPIC, NOTHING, advanceUntil, arrange, arrangeWithPanel, eventually,
  expectCommandsExecuted, expectCredentialsReachBroker, expectHostDialed, expectPortDialed, redirectDials,
  seenByBroker, settled, startLink,
} from '../helpers/mqtt_link.js';

const spec = loadKnownBugSpec('mqtt');

describe('createMqttLink(): connecting', () => {
  it('KNOWN BUG KB-32: sends no will, so retained states outlive a dead bridge', async () => {
    const { broker, createMqttLink } = await arrange();

    await createMqttLink();
    await broker.syncLog();

    expect(broker.connects).toHaveLength(1);
    expect(broker.connects[0].will).toBe(false);
  });

  it('KNOWN BUG KB-30: a refused subscription goes unnoticed, the link resolves and logs nothing more', async () => {
    const mute = { username: 'mute', password: 'quiet' };
    const { broker, exit, output, createMqttLink } = await arrange({ env: { MQTT_USERNAME: mute.username, MQTT_PASSWORD: mute.password } });
    await broker.addUser({ ...mute, subscribe: false });

    await createMqttLink();
    await eventually(() => broker.deniedSubscriptions.length === 2, 'both subscriptions to be denied');
    await broker.syncLog();
    await settle();

    expect(broker.deniedSubscriptions).toEqual([ARM_TOPIC, DISARM_TOPIC]);
    expect(broker.connacks).toEqual([0]);
    expect(output.log).toEqual([['MQTT client connected']]);
    expect(output.error).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('createMqttLink(): credentials in the connection URL', () => {
  it.each(withTitle(spec.credentials.filter((row) => !row.expected_connect_error)))('$title', expectCredentialsReachBroker);

  it.each(withTitle(spec.credentials.filter((row) => row.expected_connect_error)))('$title', async ({
    username, password, expected_connect_error: expectedError, expected_dialed: expectedDialed,
  }) => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const { broker, clock, output, createMqttLink } = await arrange({ env: { MQTT_USERNAME: username, MQTT_PASSWORD: password } });
    // Whatever the bridge dials instead of the broker goes to a closed port: no DNS, no stray connection.
    const dialed = redirectDials({ hostname: '127.0.0.1', port: await reservePort() });

    const link = track(createMqttLink());
    if (expectedError.after_ms > 0) await clock.advance(expectedError.after_ms);
    await settled(link);
    await settle();
    await broker.syncLog();

    expect(link.state).toBe('rejected');
    expect(link.error.message).toBe(expectedError.message);
    expect(seenByBroker(broker)).toEqual(NOTHING);
    expect(output.error).toEqual([]);
    // The mqtt client redials on its own 1 s timer, so the same wrong target may be dialed repeatedly.
    expect([...new Set(dialed.map(({ host, port }) => `${host}:${port}`))]).toEqual(expectedDialed ? [`${expectedDialed.host}:${expectedDialed.port}`] : []);
  });
});

describe('createMqttLink(): MQTT_PORT', () => {
  it.each(withTitle(spec.broker_ports.filter((row) => row.expected_dialed_port)))('$title', expectPortDialed);
});

describe('createMqttLink(): MQTT_HOSTNAME', () => {
  it.each(withTitle(spec.broker_hosts))('$title', expectHostDialed);
});

describe('createMqttLink(): connection failures', () => {
  it('KNOWN BUG KB-34: an unreachable broker is reported only as the connect timeout, never as a connection error', async () => {
    const { proxy, clock, output, createMqttLink } = await arrange({ route: 'proxy' });
    await proxy.stop();

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
    const { proxy, clock, createMqttLink } = await arrange({ route: 'silent' });
    const link = track(createMqttLink());
    await eventually(() => proxy.connects.length === 1, 'the first CONNECT');
    await clock.advance(5000);
    await settled(link);
    expect(link.error.message).toBe('MQTT connect timeout');

    // The mqtt client gives up on the silent connection after its own 30 s CONNACK timeout and redials.
    await clock.advance(25000);
    await advanceUntil(clock, () => proxy.connects.length >= 2, 'a second CONNECT');

    expect(proxy.connects).toHaveLength(2);
  });

  it('KNOWN BUG KB-17: connects late after the timeout, logs "MQTT client connected" and exits when that connection drops', async () => {
    const { broker, proxy, clock, exit, output, createMqttLink } = await arrange({ route: 'proxy' });
    await proxy.stop();
    const link = track(createMqttLink());
    await clock.advance(5000);
    await settled(link);
    expect(link.error.message).toBe('MQTT connect timeout');

    await proxy.start(proxy.port);
    await advanceUntil(clock, () => proxy.accepted >= 1, 'a late connection');
    await eventually(() => output.log.length === 1, 'the connected log line');

    expect(output.log).toEqual([['MQTT client connected']]);
    await broker.syncLog();
    await settle();
    expect(new Set(broker.connacks)).toEqual(new Set([0]));
    expect(broker.subscriptions).toEqual([]);
    expect(exit).not.toHaveBeenCalled();

    await broker.kick(broker.credentials.username);
    await eventually(() => exit.mock.calls.length > 0, 'process.exit');
    expect(exit.mock.calls).toEqual([[1]]);
  });

  it('KNOWN BUG KB-17: a refused login leaves the client redialing, and the old error handler logs every refusal (KB-7)', async () => {
    const { broker, clock, exit, output, createMqttLink } = await arrange({ env: { MQTT_PASSWORD: 'wrong' } });
    const link = track(createMqttLink());
    await settled(link);
    expect(output.error).toHaveLength(1);

    // Mosquitto closes the connection after refusing a login, which is what sends the client into its redial loop.
    await advanceUntil(clock, () => output.error.length >= 2, 'the second refusal to be logged');
    await broker.syncLog();

    expect(output.error[1][0]).toMatchObject({ message: 'Connection refused: Not authorized', code: 5 });
    expect(output.error[1][0]).not.toBe(output.error[0][0]);
    expect(broker.connacks.length).toBeGreaterThanOrEqual(2);
    expect(new Set(broker.connacks)).toEqual(new Set([5]));
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('createMqttLink(): losing the connection after it was established', () => {
  it('KNOWN BUG KB-29: exits with code 1 when the broker drops the connection', async () => {
    const { broker, exit, output, createMqttLink } = await arrange();
    await startLink({ broker, createMqttLink });

    await broker.kick(broker.credentials.username);
    await eventually(() => exit.mock.calls.length > 0, 'process.exit');
    await settle();

    expect(exit.mock.calls).toEqual([[1]]);
    expect(output.error).toEqual([]);
  });

  it('KNOWN BUG KB-29: exits with code 1 when the broker shuts down', async () => {
    const { proxy, broker, exit, createMqttLink } = await arrange({ route: 'proxy' });
    await startLink({ broker, createMqttLink });

    await proxy.stop();
    await eventually(() => exit.mock.calls.length > 0, 'process.exit');
    await settle();

    expect(exit.mock.calls).toEqual([[1]]);
  });

  it('KNOWN BUG KB-7: a protocol error exits with code 1 and is ALSO logged, because the pre-connect error handler is still attached', async () => {
    const { proxy, broker, exit, output, createMqttLink } = await arrange({ route: 'proxy' });
    await startLink({ broker, createMqttLink });

    proxy.inject([0x20, 0x02, 0x00, 0x04]); // a second CONNACK, refusing the login
    await eventually(() => exit.mock.calls.length > 0, 'process.exit');
    await settle();

    expect(exit.mock.calls).toEqual([[1]]);
    expect(output.error).toHaveLength(1);
    expect(output.error[0][0]).toMatchObject({ message: 'Connection refused: Bad username or password', code: 4 });
  });

  it('KNOWN BUG KB-7: a malformed packet exits with code 1 and is also logged', async () => {
    const { proxy, broker, exit, output, createMqttLink } = await arrange({ route: 'proxy' });
    await startLink({ broker, createMqttLink });

    proxy.inject([0x00, 0x00]); // packet type 0 does not exist
    await eventually(() => exit.mock.calls.length > 0, 'process.exit');
    await settle();

    expect(exit.mock.calls).toEqual([[1]]);
    expect(output.error).toHaveLength(1);
    expect(output.error[0][0]).toBeInstanceOf(Error);
  });
});

describe('commands received from the broker', () => {
  it.each(withTitle(spec.commands))('$title', expectCommandsExecuted);

  it.each([
    [ARM_TOPIC, ARM_REQUEST],
    [DISARM_TOPIC, DISARM_REQUEST],
  ])('KNOWN BUG KB-31: a retained %s message is executed again on every start', async (topic, request) => {
    const panel = await new FakePanel().start();
    const context = await arrange({ env: { HOSTNAME: panel.hostname } });
    await context.broker.publish(topic, 'ON', { retain: true });

    await startLink(context);
    await eventually(() => panel.requestLines.length === 1, 'the replayed command');
    await settle();

    expect(panel.requestLines).toEqual([request]);
  });

  it('KNOWN BUG KB-14: a command that the panel answers with its login page (expired session) counts as done and nothing is logged', async () => {
    const { broker, panel, exit, output } = await arrangeWithPanel({ panel: { requireLogin: true } });

    await broker.publish(ARM_TOPIC, 'ON');
    await eventually(() => panel.requestLines.length === 1, 'the arm request');
    await settle();

    expect(panel.requestLines).toEqual([ARM_REQUEST]);
    expect(output.error).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('KNOWN BUG KB-13: a command to a hung panel neither fails nor blocks the next command, and fails only when the connection dies', async () => {
    const { broker, panel, output } = await arrangeWithPanel();
    panel.respondWith('/statuslive.html', { hang: true }, { times: 1 });

    await broker.publish(ARM_TOPIC, 'ON');
    await eventually(() => panel.requestLines.length === 1, 'the hung request');
    await broker.publish(DISARM_TOPIC, 'OFF');
    await eventually(() => panel.requestLines.length === 2, 'the second request');
    await settle();

    expect(panel.requestLines).toEqual([ARM_REQUEST, DISARM_REQUEST]);
    expect(output.error).toEqual([]);

    await panel.stop();
    await eventually(() => output.error.length === 1, 'the hung request to fail');
    expect(output.error[0][0]).toMatchObject({ code: 'ECONNRESET' });
  });
});
