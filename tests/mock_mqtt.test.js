import { createRequire } from 'node:module';
import net from 'node:net';
import mqttPacket from 'mqtt-packet';
import { describe, expect, it } from 'vitest';
import { FakeBroker } from './mock_mqtt.js';
import { onCleanup, settle, waitFor } from './support.js';

// An independent client: the repo's own mqtt library, not the bridge's code.
const mqtt = createRequire(import.meta.url)('mqtt');

function connectClient(broker, options = {}) {
  const client = mqtt.connect(`mqtt://${broker.hostname}:${broker.port}`, { reconnectPeriod: 0, ...options });
  onCleanup(() => new Promise((resolve) => client.end(true, resolve)));
  return client;
}

const once = (emitter, event) => new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));

async function connectedClient(broker, options) {
  const client = connectClient(broker, options);
  await once(client, 'connect');
  return client;
}

function collectMessages(client) {
  const messages = [];
  client.on('message', (topic, payload, packet) => messages.push({ topic, payload: payload.toString(), retain: packet.retain, qos: packet.qos }));
  return messages;
}

const subscribe = (client, topics) => new Promise((resolve, reject) => {
  client.subscribe(topics, (error, granted) => (error ? reject(error) : resolve(granted)));
});

/** Speaks MQTT bytes directly, for packets the mqtt library never sends or hides. */
function rawClient(broker) {
  const socket = net.connect(broker.port, broker.hostname);
  const parser = mqttPacket.parser({ protocolVersion: 4 });
  const packets = [];
  parser.on('packet', (packet) => packets.push(packet));
  socket.on('data', (chunk) => parser.parse(chunk));
  socket.on('error', () => {});
  onCleanup(() => socket.destroy());
  return {
    socket,
    packets,
    send: (packet) => socket.write(mqttPacket.generate(packet)),
    closed: () => new Promise((resolve) => socket.once('close', resolve)),
  };
}

const CONNECT = { cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clean: true, clientId: 'raw', keepalive: 0 };

describe('FakeBroker lifecycle', () => {
  it('listens on a free loopback port and accepts a client with CONNACK 0 and no session present', async () => {
    const broker = await new FakeBroker().start();
    const client = connectClient(broker);

    const [connack] = await once(client, 'connect');

    expect(broker.hostname).toBe('127.0.0.1');
    expect(broker.port).toBeGreaterThan(0);
    expect(connack).toMatchObject({ returnCode: 0, sessionPresent: false });
  });

  it('can listen on a requested port, e.g. to come back after a stop', async () => {
    const first = await new FakeBroker().start();
    const { port } = first;
    await first.stop();

    const second = await new FakeBroker().start(port);

    expect(second.port).toBe(port);
    await connectedClient(second);
  });

  it('refuses new connections after stop(); stop() is idempotent and safe before start()', async () => {
    const broker = await new FakeBroker().start();
    await broker.stop();
    await broker.stop();
    await new FakeBroker().stop();

    const error = await new Promise((resolve) => {
      net.connect(broker.port, broker.hostname).once('error', resolve);
    });

    expect(error.code).toBe('ECONNREFUSED');
  });

  it('stop() closes connected clients', async () => {
    const broker = await new FakeBroker().start();
    const client = await connectedClient(broker);
    const closed = once(client, 'close');

    await broker.stop();

    await closed;
    expect(client.connected).toBe(false);
  });

  it('dropClients() closes every client without stopping the broker, which keeps accepting', async () => {
    const broker = await new FakeBroker().start();
    const first = await connectedClient(broker);
    const second = await connectedClient(broker);

    broker.dropClients();
    await Promise.all([once(first, 'close'), once(second, 'close')]);
    await waitFor(() => broker.clients.size === 0, { message: 'clients to be forgotten' });

    await connectedClient(broker);
    expect(broker.clients.size).toBe(1);
  });

  it('survives a client connection that is reset', async () => {
    const broker = await new FakeBroker().start();
    const raw = rawClient(broker);
    await once(raw.socket, 'connect');
    raw.send(CONNECT);
    await waitFor(() => raw.packets.length === 1, { message: 'CONNACK' });

    raw.socket.resetAndDestroy();
    await waitFor(() => broker.clients.size === 0, { message: 'the reset client to be forgotten' });

    await connectedClient(broker);
  });
});

describe('FakeBroker CONNECT handling', () => {
  it('records the CONNECT packet with the password as a string', async () => {
    const broker = await new FakeBroker().start();

    await connectedClient(broker, { username: 'alice', password: 'wonderland', clientId: 'probe', keepalive: 30, clean: true });

    expect(broker.connects).toHaveLength(1);
    expect(broker.connects[0]).toMatchObject({
      username: 'alice', password: 'wonderland', clientId: 'probe', keepalive: 30, clean: true, protocolVersion: 4,
    });
  });

  it('reports a missing password as undefined', async () => {
    const broker = await new FakeBroker().start();

    await connectedClient(broker, { username: 'alice' });

    expect(broker.connects[0].username).toBe('alice');
    expect(broker.connects[0].password).toBeUndefined();
  });

  it('accepts any login, including none, when no credentials are configured', async () => {
    const broker = await new FakeBroker().start();

    await connectedClient(broker);
    await connectedClient(broker, { username: 'anyone', password: 'anything' });

    expect(broker.connects).toHaveLength(2);
  });

  it('answers CONNACK 0 to the configured credentials', async () => {
    const broker = await new FakeBroker({ credentials: { username: 'alice', password: 'wonderland' } }).start();

    await connectedClient(broker, { username: 'alice', password: 'wonderland' });
  });

  it.each([
    ['wrong password', { username: 'alice', password: 'nope' }],
    ['wrong username', { username: 'mallory', password: 'wonderland' }],
    ['no password', { username: 'alice' }],
    ['no login at all', {}],
  ])('answers CONNACK 4 (bad credentials) to %s', async (_name, login) => {
    const broker = await new FakeBroker({ credentials: { username: 'alice', password: 'wonderland' } }).start();
    const client = connectClient(broker, login);

    const [error] = await once(client, 'error');

    expect(error).toMatchObject({ message: 'Connection refused: Bad username or password', code: 4 });
    expect(client.connected).toBe(false);
  });

  it('records CONNECT but never answers it in silent mode', async () => {
    const broker = await new FakeBroker({ silent: true }).start();
    const client = connectClient(broker);

    await waitFor(() => broker.connects.length === 1, { message: 'CONNECT' });
    await settle(50);

    expect(client.connected).toBe(false);
    expect(broker.clients.size).toBe(1); // still holding the connection open, not refusing it
  });
});

describe('FakeBroker subscriptions', () => {
  it('answers SUBACK granting QoS 0 whatever was requested', async () => {
    const broker = await new FakeBroker().start();
    const client = await connectedClient(broker);

    const granted = await subscribe(client, { 'a/one': 1, 'a/two': 0 });

    expect(granted).toEqual([{ topic: 'a/one', qos: 0 }, { topic: 'a/two', qos: 0 }]);
  });

  it('lists the subscribed topics of all clients in order', async () => {
    const broker = await new FakeBroker().start();
    const first = await connectedClient(broker);
    const second = await connectedClient(broker);

    await subscribe(first, ['x/1', 'x/2']);
    await subscribe(second, 'y/1');

    expect(broker.subscriptions).toEqual(['x/1', 'x/2', 'y/1']);
  });

  it('ignores packet types it does not implement without answering them or closing the connection', async () => {
    const broker = await new FakeBroker().start();
    const raw = rawClient(broker);
    await once(raw.socket, 'connect');
    raw.send(CONNECT);
    await waitFor(() => raw.packets.length === 1, { message: 'CONNACK' });

    raw.send({ cmd: 'unsubscribe', messageId: 7, unsubscriptions: ['a/b'] });
    raw.send({ cmd: 'pingreq' });
    await waitFor(() => raw.packets.length === 2, { message: 'PINGRESP' });

    expect(raw.packets.map((packet) => packet.cmd)).toEqual(['connack', 'pingresp']);
  });

  it('answers PINGREQ with PINGRESP', async () => {
    const broker = await new FakeBroker().start();
    const raw = rawClient(broker);
    await once(raw.socket, 'connect');
    raw.send(CONNECT);
    raw.send({ cmd: 'pingreq' });

    await waitFor(() => raw.packets.length === 2, { message: 'CONNACK and PINGRESP' });

    expect(raw.packets.map((packet) => packet.cmd)).toEqual(['connack', 'pingresp']);
  });

  it('records every packet it receives, whatever its type, in arrival order', async () => {
    const broker = await new FakeBroker().start();
    const raw = rawClient(broker);
    await once(raw.socket, 'connect');

    raw.send(CONNECT);
    raw.send({ cmd: 'pingreq' });
    raw.send({ cmd: 'subscribe', messageId: 1, subscriptions: [{ topic: 'a/b', qos: 0 }] });
    raw.send({ cmd: 'publish', topic: 'a/b', payload: Buffer.from('x'), qos: 0, retain: false, dup: false });
    await waitFor(() => broker.packets.length === 4, { message: 'four packets' });

    expect(broker.packets.map((packet) => packet.cmd)).toEqual(['connect', 'pingreq', 'subscribe', 'publish']);
  });

  it('closes the connection of a client that sends garbage', async () => {
    const broker = await new FakeBroker().start();
    const raw = rawClient(broker);
    await once(raw.socket, 'connect');

    raw.socket.write(Buffer.from([0x00, 0x00]));

    await raw.closed();
    await waitFor(() => broker.clients.size === 0, { message: 'the client to be forgotten' });
  });
});

describe('FakeBroker publish routing', () => {
  it('delivers a message to every client subscribed to the exact topic, as non-retained QoS 0', async () => {
    const broker = await new FakeBroker().start();
    const first = await connectedClient(broker);
    const second = await connectedClient(broker);
    const bystander = await connectedClient(broker);
    const [onFirst, onSecond, onBystander] = [first, second, bystander].map(collectMessages);
    await subscribe(first, 'room/light');
    await subscribe(second, 'room/light');
    await subscribe(bystander, 'room/other');

    // Each client has its own socket, so delivery order across clients is not defined: wait for every expected message.
    // The bystander is on a single socket, where 'room/light' would arrive before the sentinel if it were wrongly routed.
    broker.publish('room/light', 'ON');
    broker.publish('room/other', 'sentinel');
    await waitFor(() => onFirst.length === 1 && onSecond.length === 1 && onBystander.length === 1, { message: 'all deliveries' });

    expect(onFirst).toEqual([{ topic: 'room/light', payload: 'ON', retain: false, qos: 0 }]);
    expect(onSecond).toEqual([{ topic: 'room/light', payload: 'ON', retain: false, qos: 0 }]);
    expect(onBystander).toEqual([{ topic: 'room/other', payload: 'sentinel', retain: false, qos: 0 }]);
  });

  it('matches topics exactly: MQTT wildcards are not expanded', async () => {
    const broker = await new FakeBroker().start();
    const client = await connectedClient(broker);
    const received = collectMessages(client);
    await subscribe(client, ['room/#', 'room/+', 'room/exact']);

    broker.publish('room/light', 'ON');
    broker.publish('room/exact', 'sentinel');
    await waitFor(() => received.length === 1, { message: 'the sentinel' });

    expect(received.map(({ topic }) => topic)).toEqual(['room/exact']);
  });

  it('does not deliver messages published before a client subscribed unless they were retained', async () => {
    const broker = await new FakeBroker().start();
    broker.publish('room/light', 'ON');
    const client = await connectedClient(broker);
    const received = collectMessages(client);

    await subscribe(client, 'room/light');
    await settle(50);

    expect(received).toEqual([]);
  });

  it('can deliver to a client whose connection was just dropped without throwing', async () => {
    const broker = await new FakeBroker().start();
    const client = await connectedClient(broker);
    await subscribe(client, 'room/light');

    broker.dropClients();

    expect(() => broker.publish('room/light', 'ON')).not.toThrow();
  });
});

describe('FakeBroker retained messages', () => {
  it('replays a retained message to a later subscriber with the retain flag set', async () => {
    const broker = await new FakeBroker().start();
    broker.publish('room/light', 'ON', { retain: true });
    const client = await connectedClient(broker);
    const received = collectMessages(client);

    await subscribe(client, 'room/light');
    await waitFor(() => received.length === 1, { message: 'the retained message' });

    expect(received).toEqual([{ topic: 'room/light', payload: 'ON', retain: true, qos: 0 }]);
  });

  it('keeps only the latest retained message per topic', async () => {
    const broker = await new FakeBroker().start();
    broker.publish('room/light', 'ON', { retain: true });
    broker.publish('room/light', 'OFF', { retain: true });
    broker.publish('room/light', 'ignored: not retained');
    const client = await connectedClient(broker);
    const received = collectMessages(client);

    await subscribe(client, 'room/light');
    await waitFor(() => received.length === 1, { message: 'the retained message' });
    await settle(50);

    expect(received.map(({ payload }) => payload)).toEqual(['OFF']);
  });

  it('replays retained messages only for the topics subscribed to', async () => {
    const broker = await new FakeBroker().start();
    broker.publish('room/light', 'ON', { retain: true });
    broker.publish('room/fan', 'OFF', { retain: true });
    const client = await connectedClient(broker);
    const received = collectMessages(client);

    await subscribe(client, ['room/fan', 'room/none']);
    await waitFor(() => received.length === 1, { message: 'the retained message' });
    await settle(50);

    expect(received.map(({ topic }) => topic)).toEqual(['room/fan']);
  });

  it('retains a message that a client published with the retain flag, and only those', async () => {
    const broker = await new FakeBroker().start();
    const publisher = await connectedClient(broker);
    publisher.publish('state/a', 'kept', { retain: true });
    publisher.publish('state/b', 'dropped');
    await waitFor(() => broker.published.length === 2, { message: 'both publishes' });
    const subscriber = await connectedClient(broker);
    const received = collectMessages(subscriber);

    await subscribe(subscriber, ['state/a', 'state/b']);
    await waitFor(() => received.length === 1, { message: 'the retained message' });
    await settle(50);

    expect(received).toEqual([{ topic: 'state/a', payload: 'kept', retain: true, qos: 0 }]);
  });
});

describe('FakeBroker recorded client publishes', () => {
  it('records topic, payload as a string, retain and qos in order', async () => {
    const broker = await new FakeBroker().start();
    const client = await connectedClient(broker);

    client.publish('t/plain', 'one');
    client.publish('t/retained', 'two', { retain: true });
    client.publish('t/qos1', 'three', { qos: 1 });
    await waitFor(() => broker.published.length === 3, { message: 'three publishes' });

    expect(broker.published).toEqual([
      { topic: 't/plain', payload: 'one', retain: false, qos: 0 },
      { topic: 't/retained', payload: 'two', retain: true, qos: 0 },
      { topic: 't/qos1', payload: 'three', retain: false, qos: 1 },
    ]);
  });

  it('is empty while nothing was published', async () => {
    const broker = await new FakeBroker().start();
    await connectedClient(broker);

    expect(broker.published).toEqual([]);
    expect(broker.subscriptions).toEqual([]);
  });
});
