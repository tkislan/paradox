import mqtt from 'mqtt5';
import { describe, expect, it } from 'vitest';
import { BRIDGE_USER, leaseBroker } from './mosquitto.js';
import { onCleanup, settle, useFakeClock, waitFor } from './support.js';

const url = (broker, port = broker.port) => `mqtt://${broker.hostname}:${port}`;

/** An independent MQTT 3.1.1 client, ended after the test. */
async function connect(broker, options = {}, port) {
  const client = await mqtt.connectAsync(url(broker, port), { protocolVersion: 4, ...BRIDGE_USER, reconnectPeriod: 0, ...options });
  onCleanup(() => client.endAsync(true));
  return client;
}

describe('leaseBroker()', () => {
  it('hands out distinct instances to concurrent leases', async () => {
    const brokers = await Promise.all(Array.from({ length: 5 }, () => leaseBroker()));

    expect(new Set(brokers.map((b) => b.name)).size).toBe(5);
  });

  it('starts every lease with nothing retained, no published messages and no events', async () => {
    const broker = await leaseBroker();

    expect(await broker.retained('paradox/status/armed')).toBeNull();
    expect(broker.published).toEqual([]);
    expect(broker.events).toEqual([]);
  });

  it('works while the fake clock is installed', async () => {
    const clock = useFakeClock();
    const broker = await leaseBroker();
    const client = await connect(broker);

    await client.publishAsync('paradox/status/armed', 'ON', { retain: true });
    await clock.advance(5000);

    await waitFor(() => broker.published.length === 1);
    expect(await broker.retained('paradox/status/armed')).toBe('ON');
  });
});

describe('observing what a client does', () => {
  it('reports published messages with payload, QoS and the publisher retain flag, but not the harness own', async () => {
    const broker = await leaseBroker();
    const client = await connect(broker);

    await client.publishAsync('paradox/status/armed', 'ON', { retain: true, qos: 0 });
    await client.publishAsync('paradox/sensor/0', 'OFF', { retain: false, qos: 1 });
    await broker.publish('paradox/command/arm', 'x');

    await waitFor(() => broker.published.length === 2);
    expect(broker.published).toEqual([
      { topic: 'paradox/status/armed', payload: 'ON', qos: 0, retain: true },
      { topic: 'paradox/sensor/0', payload: 'OFF', qos: 1, retain: false },
    ]);
  });

  it('parses connect, subscribe, publish and disconnect from the broker log', async () => {
    const broker = await leaseBroker();
    const client = await connect(broker, { clientId: 'probe', keepalive: 30, clean: true });

    await client.subscribeAsync([ 'paradox/command/arm' ], { qos: 1 });
    await client.publishAsync('paradox/status/armed', 'ON', { retain: true });
    await client.endAsync();

    await waitFor(() => broker.disconnects.length === 1);
    expect(broker.connects).toEqual([{ clientId: 'probe', protocolLevel: 4, clean: true, keepalive: 30, username: 'bridge', will: false }]);
    expect(broker.connacks).toEqual([0]);
    expect(broker.subscriptions).toEqual([{ topic: 'paradox/command/arm', qos: 1 }]);
    expect(broker.clientPublishes).toEqual([{ topic: 'paradox/status/armed', qos: 0, retain: true, bytes: 2 }]);
    expect(broker.disconnects).toEqual([{ clientId: 'probe', reason: 'client disconnected' }]);
  });

  it('shows whether a client set a will', async () => {
    const broker = await leaseBroker();

    await connect(broker, { clientId: 'with-will', will: { topic: 'paradox/status/armed', payload: 'OFF' } });

    await waitFor(() => broker.connects.length === 1);
    expect(broker.connects[0].will).toBe(true);
  });

  it('delivers messages published by the harness to subscribed clients', async () => {
    const broker = await leaseBroker();
    const client = await connect(broker);
    const received = [];
    client.on('message', (topic, payload) => received.push([topic, payload.toString()]));
    await client.subscribeAsync('paradox/command/arm');

    await broker.publish('paradox/command/arm', 'go');

    await waitFor(() => received.length === 1);
    expect(received).toEqual([['paradox/command/arm', 'go']]);
  });

  it('replays retained messages to new subscribers and forgets them when the lease ends', async () => {
    const broker = await leaseBroker();

    await broker.publish('paradox/command/arm', 'x', { retain: true });

    expect(await broker.retained('paradox/command/arm')).toBe('x');
  });
});

describe('syncLog()', () => {
  it('waits until the log shows what the broker did before the call', async () => {
    const broker = await leaseBroker();
    const client = await connect(broker, { clientId: 'early' });
    await client.subscribeAsync('paradox/command/arm');

    await broker.syncLog();

    expect(broker.connects.map((c) => c.clientId)).toEqual(['early']);
    expect(broker.subscriptions).toEqual([{ topic: 'paradox/command/arm', qos: 0 }]);
  });
});

describe('users', () => {
  it('rejects wrong credentials with CONNACK 5 (not authorised)', async () => {
    const broker = await leaseBroker();

    await expect(mqtt.connectAsync(url(broker), { protocolVersion: 4, username: 'bridge', password: 'nope', reconnectPeriod: 0 })).rejects.toThrow(/Not authorized/);
    await waitFor(() => broker.connacks.length === 1);
    expect(broker.connacks).toEqual([5]);
  });

  it('creates users with arbitrary usernames and passwords for the length of the test', async () => {
    const broker = await leaseBroker();
    await broker.addUser({ username: 'user:pa', password: 'ss' });

    const client = await connect(broker, { username: 'user:pa', password: 'ss' });

    expect(client.connected).toBe(true);
  });

  it('answers SUBSCRIBE with failure code 128 for a user that may not subscribe', async () => {
    const broker = await leaseBroker();
    await broker.addUser({ username: 'mute', password: 'x', subscribe: false });
    const client = await connect(broker, { username: 'mute', password: 'x' });

    await expect(client.subscribeAsync('paradox/command/arm', { qos: 0 })).rejects.toMatchObject({ packet: { granted: [128] } });
  });

  it('kicks the sessions of a user, who can reconnect afterwards', async () => {
    const broker = await leaseBroker();
    const client = await connect(broker);
    const closed = new Promise((resolve) => client.on('close', resolve));

    await broker.kick('bridge');
    await closed;

    expect((await connect(broker)).connected).toBe(true);
  });
});

describe('proxy()', () => {
  it('forwards traffic to the broker', async () => {
    const broker = await leaseBroker();
    const proxy = await broker.proxy();
    const client = await connect(broker, {}, proxy.port);

    await client.publishAsync('paradox/status/armed', 'ON');

    await waitFor(() => broker.published.length === 1);
    expect(proxy.accepted).toBe(1);
  });

  it('refuses connections after stop() and accepts them again after start(port)', async () => {
    const broker = await leaseBroker();
    const proxy = await broker.proxy();
    await proxy.stop();

    await expect(connect(broker, {}, proxy.port)).rejects.toThrow(/ECONNREFUSED/);

    await proxy.start(proxy.port);
    expect((await connect(broker, {}, proxy.port)).connected).toBe(true);
  });

  it('can accept a connection and never answer', async () => {
    const broker = await leaseBroker();
    const proxy = await broker.proxy();
    proxy.blackhole();
    const client = mqtt.connect(url(broker, proxy.port), { protocolVersion: 4, ...BRIDGE_USER, reconnectPeriod: 0 });
    onCleanup(() => client.endAsync(true));

    await waitFor(() => proxy.accepted === 1);
    await settle(100);

    expect(client.connected).toBe(false);
    expect(broker.connects).toEqual([]);
  });

  it('can answer the first packet with forged bytes and close', async () => {
    const broker = await leaseBroker();
    const proxy = await broker.proxy();
    proxy.replyWith([0x20, 0x02, 0x00, 0x03]);

    await expect(mqtt.connectAsync(url(broker, proxy.port), { protocolVersion: 4, reconnectPeriod: 0 })).rejects.toThrow(/Connection refused: Server unavailable/);
  });

  it('can write malformed bytes to a connected client and cut connections', async () => {
    const broker = await leaseBroker();
    const proxy = await broker.proxy();
    const client = await connect(broker, {}, proxy.port);
    const errors = [];
    client.on('error', (error) => errors.push(error));
    const closed = new Promise((resolve) => client.on('close', resolve));

    proxy.inject([0xf0, 0x00]);
    await waitFor(() => errors.length > 0);
    proxy.dropConnections();
    await closed;

    expect(errors[0].message).toMatch(/Invalid|Malformed|packet/i);
  });
});
