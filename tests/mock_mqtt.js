import net from 'node:net';
import mqttPacket from 'mqtt-packet';
import { onCleanup } from './support.js';

/*
 * Wire-level fake MQTT 3.1.1 broker (QoS 0 only, exact-topic matching, retained messages), so the
 * real `mqtt` client of the bridge talks to it over a real socket.
 */

const CONNACK_BAD_CREDENTIALS = 4;

export class FakeBroker {
  /**
   * @param {object} [options]
   * @param {{username: string, password: string}} [options.credentials] when set, other logins get CONNACK 4
   * @param {boolean} [options.silent] accept the TCP connection but never answer CONNECT
   */
  constructor({ credentials, silent = false } = {}) {
    this.credentials = credentials;
    this.silent = silent;
    this.port = 0;
    this.clients = new Set();
    this.packets = [];
    this.retained = new Map();
    this.server = null;
  }

  get hostname() {
    return '127.0.0.1';
  }

  /** CONNECT packets received (username/password as strings, clientId, keepalive, ...). */
  get connects() {
    return this.packets
      .filter((p) => p.cmd === 'connect')
      .map((p) => ({ ...p, password: p.password === undefined ? undefined : p.password.toString() }));
  }

  /** Topics subscribed to by clients, in order. */
  get subscriptions() {
    return this.packets.filter((p) => p.cmd === 'subscribe').flatMap((p) => p.subscriptions.map((s) => s.topic));
  }

  /** Messages published by clients to the broker: { topic, payload (string), retain, qos }. */
  get published() {
    return this.packets
      .filter((p) => p.cmd === 'publish')
      .map(({ topic, payload, retain, qos }) => ({ topic, payload: payload.toString(), retain, qos }));
  }

  /** Delivers a message to every client subscribed to `topic`; retained ones are also replayed to future subscribers. */
  publish(topic, payload, { retain = false } = {}) {
    if (retain) this.retained.set(topic, payload);
    for (const client of this.clients) {
      if (client.subscriptions.has(topic)) client.send({ cmd: 'publish', topic, payload: Buffer.from(payload), qos: 0, retain: false, dup: false });
    }
  }

  /** Abruptly closes every client connection, as a broker crash or network drop would. */
  dropClients() {
    this.clients.forEach((client) => client.socket.destroy());
  }

  /** Starts listening on loopback (on `port` if given). Auto-stops after the test. */
  async start(port = 0) {
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve) => this.server.listen(port, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    onCleanup(() => this.stop());
    return this;
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.dropClients();
    await new Promise((resolve) => server.close(resolve));
  }

  accept(socket) {
    const parser = mqttPacket.parser({ protocolVersion: 4 });
    const client = {
      socket,
      subscriptions: new Set(),
      send: (packet) => { if (!socket.destroyed) socket.write(mqttPacket.generate(packet)); },
    };
    this.clients.add(client);

    parser.on('packet', (packet) => {
      this.packets.push(packet);
      this.respond(client, packet);
    });
    parser.on('error', () => socket.destroy());
    socket.on('data', (chunk) => parser.parse(chunk));
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => {});
  }

  respond(client, packet) {
    switch (packet.cmd) {
      case 'connect': {
        if (this.silent) return;
        const ok = !this.credentials
          || (packet.username === this.credentials.username && String(packet.password) === this.credentials.password);
        client.send({ cmd: 'connack', returnCode: ok ? 0 : CONNACK_BAD_CREDENTIALS, sessionPresent: false });
        return;
      }
      case 'subscribe':
        packet.subscriptions.forEach(({ topic }) => client.subscriptions.add(topic));
        client.send({ cmd: 'suback', messageId: packet.messageId, granted: packet.subscriptions.map(() => 0) });
        packet.subscriptions.forEach(({ topic }) => {
          if (this.retained.has(topic)) client.send({ cmd: 'publish', topic, payload: Buffer.from(this.retained.get(topic)), qos: 0, retain: true, dup: false });
        });
        return;
      case 'publish':
        if (packet.retain) this.retained.set(packet.topic, packet.payload);
        return;
      case 'pingreq':
        client.send({ cmd: 'pingresp' });
        return;
      default:
    }
  }
}
