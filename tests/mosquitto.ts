import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { onCleanup } from './support.ts';

/*
 * The Mosquitto broker from tests/docker-compose.yml, shared by every test. The bridge's topics are fixed, so each
 * test works under a topic prefix of its own: the harness publishes and subscribes under it, and helpers/app.ts makes
 * the bridge's client do the same. Tests running in parallel therefore never see each other's messages or retained
 * state, and nothing needs resetting between tests.
 *
 * The harness's clients have no keepalive and no reconnect, so they create no timers that the fake clock could freeze.
 */

const COMPOSE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docker-compose.yml');
const START_COMMAND = 'docker compose -f tests/docker-compose.yml up --detach --wait';
const BARRIER = 'harness/barrier';

// Taken before helpers/app.ts replaces mqtt.connect for the bridge, so the harness's own clients get no second prefix.
const { connect } = mqtt;

let address: Promise<{ hostname: string; port: number }> | undefined;

/** Where the compose broker listens: a random host port. */
function brokerAddress() {
  address ??= promisify(execFile)('docker', ['compose', '-f', COMPOSE_FILE, 'port', 'mosquitto', '1883']).then(
    ({ stdout }) => ({ hostname: '127.0.0.1', port: Number(stdout.trim().split(':').pop()) }),
    (error) => { throw new Error(`No Mosquitto broker running: start it with \`${START_COMMAND}\`.\n${error.stderr || error.message}`); },
  );
  return address;
}

function open(url: string): Promise<MqttClient> {
  const options: IClientOptions = { keepalive: 0, reconnectPeriod: 0 };
  return new Promise((resolve, reject) => {
    const client = connect(url, options);
    client.once('connect', () => resolve(client));
    client.once('close', () => reject(new Error(`Could not connect to the MQTT broker at ${url}`)));
  });
}

const subscribe = (client: MqttClient, topic: string) => new Promise<void>((resolve, reject) => {
  client.subscribe(topic, { qos: 0 }, (error) => (error ? reject(error) : resolve()));
});

const publish = (client: MqttClient, topic: string, payload: string, retain = false) => new Promise<void>((resolve, reject) => {
  client.publish(topic, payload, { qos: 1, retain }, (error) => (error ? reject(error) : resolve()));
});

const end = (client: MqttClient) => new Promise<void>((resolve) => { client.end(true, () => resolve()); });

export type Broker = Awaited<ReturnType<typeof watchBroker>>;

/**
 * A connection to the broker under a fresh topic prefix, closed after the test. `published` collects, without the
 * prefix, what other clients publish under it, except on the command topics, where the harness itself publishes.
 */
export async function watchBroker() {
  const { hostname, port } = await brokerAddress();
  const url = `mqtt://${hostname}:${port}`;
  const prefix = `test-${randomUUID()}/`;
  const published: Array<{ topic: string; payload: string }> = [];
  let barrierReached: (() => void) | undefined;

  const client = await open(url);
  onCleanup(() => end(client));
  client.on('message', (topic, payload) => {
    const name = topic.slice(prefix.length);
    if (name === BARRIER) barrierReached?.();
    else if (!name.startsWith('paradox/command/')) published.push({ topic: name, payload: payload.toString() });
  });
  await subscribe(client, `${prefix}#`);

  return {
    hostname,
    port,
    prefix,
    published,

    /** Publishes as a client other than the bridge. */
    publish: (topic: string, payload: string, { retain = false } = {}) => publish(client, prefix + topic, payload, retain),

    /** Returns once everything the broker forwarded to this client before now has arrived (same TCP stream, in order). */
    barrier: () => new Promise<void>((resolve) => {
      barrierReached = resolve;
      client.publish(prefix + BARRIER, '');
    }),

    /** The retained payload of `topic`, or null: asks the way a new subscriber would. */
    async retained(topic: string) {
      const reader = await open(url);
      let payload: string | null = null;
      reader.on('message', (_topic, body) => { payload = body.toString(); });
      await subscribe(reader, prefix + topic);
      // The broker sends retained messages right after the SUBACK, so they arrive before this PUBACK.
      await publish(reader, prefix + BARRIER, '');
      await end(reader);
      return payload;
    },
  };
}
