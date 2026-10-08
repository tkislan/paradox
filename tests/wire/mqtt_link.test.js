import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { FakePanel } from '../mock_paradox.js';
import { track } from '../helpers/outcomes.js';
import { settle, withTitle } from '../support.js';
import {
  ARM_REQUEST, ARM_TOPIC, DISARM_REQUEST, DISARM_TOPIC, NOTHING, SECRET_PASSWORD, arrange, arrangeWithPanel, endAll,
  eventually, expectCommandsExecuted, expectCredentialsReachBroker, expectHostDialed, expectPortDialed, publishPacket,
  redirectDials, seenByBroker, settled, spec, startLink,
} from '../helpers/mqtt_link.js';

describe('createMqttLink(): connecting', () => {
  it('connects to MQTT_HOSTNAME:MQTT_PORT with a clean MQTT 3.1.1 session and the configured credentials', async () => {
    const { broker, createMqttLink } = await arrange({ env: { MQTT_USERNAME: 'panel', MQTT_PASSWORD: 's3cret' } });
    await broker.addUser({ username: 'panel', password: 's3cret' });

    await createMqttLink();
    await broker.syncLog();

    expect(broker.connects).toEqual([
      { clientId: expect.any(String), protocolLevel: 4, clean: true, keepalive: 60, username: 'panel', will: false },
    ]);
    expect(broker.connacks).toEqual([0]);
  });

  it('lets the mqtt library pick a random client id', async () => {
    const { broker, createMqttLink } = await arrange();

    await createMqttLink();
    await broker.syncLog();

    expect(broker.connects[0].clientId).toMatch(/^mqttjs_[0-9a-f]{8}$/);
  });

  it('logs "MQTT client connected", stays quiet afterwards and returns an object with only publish()', async () => {
    const { broker, exit, output, createMqttLink } = await arrange();

    const link = await startLink({ broker, createMqttLink });
    await broker.syncLog();
    await settle();

    expect(Object.keys(link)).toEqual(['publish']);
    expect(broker.clientPublishes).toEqual([]);
    expect(output.log).toEqual([['MQTT client connected']]);
    expect(output.error).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('subscribes to the arm and disarm command topics only, at QoS 0', async () => {
    const { broker, createMqttLink } = await arrange();

    await startLink({ broker, createMqttLink });
    await broker.syncLog();
    await settle();

    expect([...broker.subscriptions].sort((a, b) => a.topic.localeCompare(b.topic))).toEqual([
      { topic: ARM_TOPIC, qos: 0 },
      { topic: DISARM_TOPIC, qos: 0 },
    ]);
  });

  it('leaves no connect-timeout timer behind once connected', async () => {
    const { broker, clients, createMqttLink } = await arrange();

    await startLink({ broker, createMqttLink });
    await endAll(clients); // the client's own keep-alive timer goes with it

    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no connect-timeout timer behind after a refused login', async () => {
    const { broker, clients, createMqttLink } = await arrange({ env: { MQTT_PASSWORD: 'wrong' } });

    await settled(track(createMqttLink()));
    await broker.syncLog();
    await endAll(clients);

    expect(broker.connacks).toEqual([5]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('connects when the broker has an account for exactly the configured credentials', async () => {
    const { broker, createMqttLink } = await arrange({ env: { MQTT_USERNAME: 'mqttuser', MQTT_PASSWORD: 'mqttpass' } });
    await broker.addUser({ username: 'mqttuser', password: 'mqttpass' });

    await startLink({ broker, createMqttLink });
    await broker.syncLog();

    expect(broker.connects).toHaveLength(1);
    expect(broker.connects[0].username).toBe('mqttuser');
    expect(broker.connacks).toEqual([0]);
  });

  it('dials MQTT_HOSTNAME and MQTT_PORT, both from the environment', async () => {
    const { broker, createMqttLink } = await arrange({ env: { MQTT_HOSTNAME: 'broker.example' } });
    const dialed = redirectDials(broker);

    await createMqttLink();

    expect(dialed).toEqual([{ host: 'broker.example', port: broker.port }]);
  });
});

describe('createMqttLink(): credentials in the connection URL', () => {
  it.each(withTitle(spec.credentials.filter((row) => !row.expected_connect_error)))('$title', expectCredentialsReachBroker);
});

describe('createMqttLink(): MQTT_PORT', () => {
  it.each(withTitle(spec.broker_ports.filter((row) => row.expected_dialed_port)))('$title', expectPortDialed);

  it.each(withTitle(spec.broker_ports.filter((row) => row.expected_connect_error)))('$title', async ({ mqtt_port: mqttPort, expected_connect_error: expectedError }) => {
    const { broker, output, createMqttLink } = await arrange({ env: { MQTT_PORT: mqttPort } });

    const link = track(createMqttLink());
    await settled(link);
    await broker.syncLog();

    expect(link.state).toBe('rejected');
    expect(link.error.message.startsWith(expectedError.message_prefix)).toBe(true);
    expect(seenByBroker(broker)).toEqual(NOTHING);
    expect(output.error).toEqual([]);
  });
});

describe('createMqttLink(): MQTT_HOSTNAME', () => {
  it.each(withTitle(spec.broker_hosts))('$title', expectHostDialed);
});

describe('createMqttLink(): secrets', () => {
  it('never logs the MQTT password while connecting, publishing or failing a command', async () => {
    const panel = await new FakePanel().start();
    const context = await arrange({ env: { HOSTNAME: panel.hostname, MQTT_USERNAME: 'secretive', MQTT_PASSWORD: SECRET_PASSWORD } });
    await context.broker.addUser({ username: 'secretive', password: SECRET_PASSWORD });
    panel.respondWith('/statuslive.html', { status: 500, headers: {}, body: 'boom' });
    const link = await startLink(context);

    link.publish('paradox/test/x', 'x');
    await context.broker.publish(ARM_TOPIC, 'ON');
    await eventually(() => context.output.error.length === 1, 'the failed command');

    expect(context.output.log.length).toBeGreaterThan(1);
    expect(inspect(context.output, { depth: 8 })).not.toContain(SECRET_PASSWORD);
  });

  it('never logs the MQTT password when the broker refuses the login', async () => {
    const { output, createMqttLink } = await arrange({ env: { MQTT_PASSWORD: SECRET_PASSWORD } });

    const link = track(createMqttLink());
    await settled(link);

    expect(output.error).toHaveLength(1);
    expect(inspect([output, link.error], { depth: 8 })).not.toContain(SECRET_PASSWORD);
  });
});

describe('createMqttLink(): connection failures', () => {
  it('rejects with the broker refusal and logs the same error when the credentials are wrong', async () => {
    const { broker, exit, output, createMqttLink } = await arrange({ env: { MQTT_PASSWORD: 'wrong' } });

    const link = track(createMqttLink());
    await settled(link);

    expect(link.state).toBe('rejected');
    expect(link.error).toMatchObject({ message: 'Connection refused: Not authorized', code: 5 });
    expect(output.error).toHaveLength(1);
    expect(output.error[0][0]).toBe(link.error);
    await broker.syncLog();
    await settle();
    expect(broker.connacks).toEqual([5]);
    expect(broker.subscriptions).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('rejects when the account is unknown to the broker, with the same refusal', async () => {
    const { broker, createMqttLink } = await arrange({ env: { MQTT_USERNAME: 'nobody' } });

    const link = track(createMqttLink());
    await settled(link);
    await broker.syncLog();

    expect(link.error).toMatchObject({ message: 'Connection refused: Not authorized', code: 5 });
    expect(broker.connacks).toEqual([5]);
  });

  it.each(spec.connack_refusals)('rejects when the broker answers CONNECT with $name', async ({
    return_code: returnCode, expected_error_code: code, expected_error_message: message,
  }) => {
    const { proxy, output, createMqttLink } = await arrange({ route: 'proxy' });
    proxy.replyWith([0x20, 0x02, 0x00, returnCode]);

    const link = track(createMqttLink());
    await settled(link);

    expect(link.state).toBe('rejected');
    expect(link.error).toMatchObject({ message, code });
    expect(output.error).toHaveLength(1);
    expect(output.error[0][0]).toBe(link.error);
  });

  it('rejects with "MQTT connect timeout" exactly 5 s after starting when the broker never answers, without logging', async () => {
    const { proxy, clock, exit, output, createMqttLink } = await arrange({ route: 'silent' });

    const link = track(createMqttLink());
    await eventually(() => proxy.connects.length === 1, 'the CONNECT');
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
});

describe('publish()', () => {
  it('forwards topic and payload with retain false and QoS 0 when no options are given, and logs it', async () => {
    const { broker, output, createMqttLink } = await arrange();
    const link = await startLink({ broker, createMqttLink });

    link.publish('paradox/status/armed', 'ON');
    await eventually(() => broker.published.length === 1, 'the published message');
    await broker.syncLog();

    expect(broker.published).toEqual([{ topic: 'paradox/status/armed', payload: 'ON', retain: false, qos: 0 }]);
    expect(broker.clientPublishes).toEqual([{ topic: 'paradox/status/armed', qos: 0, retain: false, bytes: 2 }]);
    expect(await broker.retained('paradox/status/armed')).toBeNull();
    expect(output.log).toEqual([['MQTT client connected'], ['publish', 'paradox/status/armed', 'ON']]);
  });

  it('passes retain: true through, so the broker keeps the message for new subscribers', async () => {
    const { broker, createMqttLink } = await arrange();
    const link = await startLink({ broker, createMqttLink });

    link.publish('paradox/sensor/3', 'OFF', { retain: true });
    await eventually(() => broker.published.length === 1, 'the published message');
    await broker.syncLog();

    expect(broker.published).toEqual([{ topic: 'paradox/sensor/3', payload: 'OFF', retain: true, qos: 0 }]);
    expect(broker.clientPublishes).toEqual([{ topic: 'paradox/sensor/3', qos: 0, retain: true, bytes: 3 }]);
    expect(await broker.retained('paradox/sensor/3')).toBe('OFF');
  });

  it('passes an explicit retain: false through', async () => {
    const { broker, createMqttLink } = await arrange();
    const link = await startLink({ broker, createMqttLink });

    link.publish('paradox/sensor/3', 'ON', { retain: false });
    await eventually(() => broker.published.length === 1, 'the published message');
    await broker.syncLog();

    expect(broker.published).toEqual([{ topic: 'paradox/sensor/3', payload: 'ON', retain: false, qos: 0 }]);
    expect(broker.clientPublishes).toEqual([{ topic: 'paradox/sensor/3', qos: 0, retain: false, bytes: 2 }]);
    expect(await broker.retained('paradox/sensor/3')).toBeNull();
  });

  it('forwards other publish options unchanged (qos)', async () => {
    const { broker, createMqttLink } = await arrange();
    const link = await startLink({ broker, createMqttLink });

    link.publish('paradox/test/qos', 'x', { qos: 1, retain: true });
    await eventually(() => broker.published.length === 1, 'the published message');
    await broker.syncLog();

    expect(broker.published).toEqual([{ topic: 'paradox/test/qos', payload: 'x', retain: true, qos: 1 }]);
    expect(broker.clientPublishes).toEqual([{ topic: 'paradox/test/qos', qos: 1, retain: true, bytes: 1 }]);
    expect(await broker.retained('paradox/test/qos')).toBe('x');
  });

  it('sends an empty payload and non-ASCII text as UTF-8', async () => {
    const { broker, createMqttLink } = await arrange();
    const link = await startLink({ broker, createMqttLink });

    link.publish('paradox/test/empty', '');
    link.publish('paradox/test/unicode', 'Obývačka €');
    await eventually(() => broker.published.length === 2, 'both messages');
    await broker.syncLog();

    expect(broker.published.map(({ topic, payload }) => [topic, payload])).toEqual([['paradox/test/empty', ''], ['paradox/test/unicode', 'Obývačka €']]);
    expect(broker.clientPublishes.map(({ topic, bytes }) => [topic, bytes])).toEqual([['paradox/test/empty', 0], ['paradox/test/unicode', 14]]);
  });

  it('delivers consecutive publishes in call order', async () => {
    const { broker, createMqttLink } = await arrange();
    const link = await startLink({ broker, createMqttLink });

    ['a', 'b', 'c', 'd'].forEach((suffix) => link.publish(`paradox/test/${suffix}`, suffix));
    await eventually(() => broker.published.length === 4, 'all messages');

    expect(broker.published.map(({ topic }) => topic)).toEqual(['paradox/test/a', 'paradox/test/b', 'paradox/test/c', 'paradox/test/d']);
  });
});

describe('commands received from the broker', () => {
  it.each(withTitle(spec.commands))('$title', expectCommandsExecuted);

  // A real broker only delivers what the bridge subscribed to; the bridge's own topic matching is reachable by hand only.
  it.each(withTitle(spec.commands.filter((row) => row.delivered_by_broker === false)))('$title, even when delivered although never subscribed', async ({ messages, expected_panel_requests: expected }) => {
    const { proxy, panel } = await arrangeWithPanel({ route: 'proxy' });

    proxy.inject(Buffer.concat([...messages, { topic: DISARM_TOPIC, payload: 'sentinel' }].map(({ topic, payload }) => publishPacket(topic, payload))));
    const all = [...expected, DISARM_REQUEST].sort();
    await eventually(() => panel.requestLines.length >= all.length, 'the panel requests');
    await settle();

    expect([...panel.requestLines].sort()).toEqual(all);
  });

  it('arms through a subscribed topic published by another client', async () => {
    const { broker, panel } = await arrangeWithPanel();

    await broker.publish(ARM_TOPIC, 'ON');
    await eventually(() => panel.requestLines.length === 1, 'the arm request');
    await settle();

    expect(panel.requestLines).toEqual([ARM_REQUEST]);
  });

  it('disarms through a subscribed topic published by another client', async () => {
    const { broker, panel } = await arrangeWithPanel();

    await broker.publish(DISARM_TOPIC, 'OFF');
    await eventually(() => panel.requestLines.length === 1, 'the disarm request');
    await settle();

    expect(panel.requestLines).toEqual([DISARM_REQUEST]);
  });

  it('keeps working after a command failed with an HTTP error, and logs the error', async () => {
    const { broker, panel, exit, output } = await arrangeWithPanel();
    panel.respondWith('/statuslive.html', { status: 500, headers: {}, body: 'boom' }, { times: 1 });

    await broker.publish(ARM_TOPIC, 'ON');
    await eventually(() => output.error.length === 1, 'the logged error');
    await broker.publish(ARM_TOPIC, 'ON');
    await eventually(() => panel.requestLines.length === 2, 'the second request');

    expect(output.error[0][0]).toBeInstanceOf(Error);
    expect(output.error[0][0].message).toBe('Request failed with status code 500');
    expect(exit).not.toHaveBeenCalled();
    expect(panel.requestLines).toEqual([ARM_REQUEST, ARM_REQUEST]);
    await settle();
    expect(output.error).toHaveLength(1);
  });

  it('logs the error and keeps running when the panel is down', async () => {
    const { broker, panel, exit, output } = await arrangeWithPanel();
    await panel.stop();

    await broker.publish(DISARM_TOPIC, 'OFF');
    await eventually(() => output.error.length === 1, 'the logged error');

    expect(output.error[0][0]).toMatchObject({ code: 'ECONNREFUSED' });
    expect(exit).not.toHaveBeenCalled();
  });

  it('logs the error and keeps running when the panel resets the connection', async () => {
    const { broker, panel, exit, output } = await arrangeWithPanel();
    panel.respondWith('/statuslive.html', { destroy: true }, { times: 1 });

    await broker.publish(ARM_TOPIC, 'ON');
    await eventually(() => output.error.length === 1, 'the logged error');

    expect(output.error[0][0]).toMatchObject({ code: 'ECONNRESET' });
    expect(exit).not.toHaveBeenCalled();
  });
});
