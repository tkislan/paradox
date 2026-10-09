import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import mqtt, { type MqttClient } from 'mqtt5';
import mqttPacket, { type IPublishPacket, type QoS } from 'mqtt-packet';
import { onCleanup, reservePort, settle, waitFor } from './support.ts';

/*
 * Real Mosquitto brokers from tests/docker-compose.yml, as test fixtures.
 *
 * The bridge hard-codes its topics, so tests running in parallel cannot share a broker: `leaseBroker()`
 * hands the current test exclusive use of one of the compose replicas (claimed across processes with an
 * atomic mkdir) and gives it back, reset, after the test.
 *
 * What a test can see:
 *   - `published`: messages on paradox/# that anyone but the harness published (topic, payload, qos, and the
 *     retain flag as the publisher set it). Delivered through an MQTT 5 observer with retain-as-published.
 *   - `connects`, `subscriptions`, `connacks`, `disconnects`: parsed from Mosquitto's own log, which is the
 *     only place the broker reports protocol level, clean session, keepalive, will and subscription QoS.
 * What a test can do: publish as another client, add users, kick a user's sessions, and route the bridge
 * through a `proxy()` to inject transport faults Mosquitto cannot produce itself (refused or black-holed
 * connections, malformed bytes, dropped sockets).
 *
 * The harness's own MQTT client has no keepalive and no reconnect, so it creates no timers that the fake
 * clock could freeze.
 */

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = path.join(TESTS_DIR, 'docker-compose.yml');
const LEASES_DIR = path.join(os.tmpdir(), 'paradox-bridge-test-brokers');
const run = promisify(execFile);

const ADMIN = { username: 'admin', password: 'admin-secret' };
/** A user with full access that exists on every leased broker. */
export const BRIDGE_USER = { username: 'bridge', password: 'secret' };

const DYNSEC_TOPIC = '$CONTROL/dynamic-security/v1';
const OBSERVED = 'paradox/#';
// Marks messages the harness publishes itself, so `published` only shows what the code under test sent.
const FROM_HARNESS = { userProperties: { harness: 'true' } };
const BASELINE_USERS = [ADMIN.username, BRIDGE_USER.username];
const LOG_CLIENT_PREFIX = 'lease-';

type Instance = { name: string; port: number };
type Credentials = { username: string; password: string };
type DynsecCommand = { command: string; [field: string]: unknown };
type DynsecResponse = { command: string; error?: string; data?: any };

type BrokerEvent =
  | { type: 'connect'; clientId: string; protocolLevel: number; clean: boolean; keepalive: number; username: string | undefined; will: boolean | null }
  | { type: 'connack'; clientId: string; returnCode: number }
  | { type: 'subscribe'; clientId: string; topics: Array<{ topic: string; qos: number }> }
  | { type: 'publish'; clientId: string; qos: number; retain: boolean; topic: string; bytes: number }
  | { type: 'disconnect'; clientId: string; reason: string };

let instances: Instance[] | undefined;

async function listInstances(): Promise<Instance[]> {
  if (instances) return instances;
  let stdout;
  try {
    ({ stdout } = await run('docker', ['compose', '-f', COMPOSE_FILE, 'ps', '--format', 'json']));
  } catch (error) {
    throw new Error(`docker compose is required to run the MQTT tests: ${(error as Error).message}`);
  }
  const text = stdout.trim();
  const containers = text.startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const running: Instance[] = containers
    .filter((c) => c.State === 'running')
    .map((c) => ({ name: c.Name, port: c.Publishers.find((p) => p.TargetPort === 1883).PublishedPort }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (running.length === 0) throw new Error('No Mosquitto containers running: start them with `docker compose -f tests/docker-compose.yml up --detach --wait`.');
  instances = running;
  return instances;
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function claim(instance: Instance): boolean {
  const dir = path.join(LEASES_DIR, instance.name);
  fs.mkdirSync(LEASES_DIR, { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let owner;
    try {
      owner = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
    } catch {
      return false;
    }
    if (isAlive(owner)) return false;
    // A lease whose owner died. Moving it aside is atomic, so only one claimant gets to remove it; if what
    // was moved turns out to be someone's fresh lease (they won the race to re-create it), put it back.
    const stale = `${dir}.stale-${process.pid}`;
    try {
      fs.renameSync(dir, stale);
    } catch {
      return false;
    }
    if (Number(fs.readFileSync(path.join(stale, 'pid'), 'utf8')) !== owner) {
      fs.renameSync(stale, dir);
      return false;
    }
    fs.rmSync(stale, { recursive: true, force: true });
    return claim(instance);
  }
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
  return true;
}

const release = (instance: Instance) => fs.rmSync(path.join(LEASES_DIR, instance.name), { recursive: true, force: true });

// `docker logs --follow` is a freshly spawned CLI process; on a loaded machine it can take seconds to attach.
const LOG_TIMEOUT = 30000;

const withTimeout = <T>(promise: Promise<T>, message: string, ms = LOG_TIMEOUT): Promise<T> => Promise.race([
  promise,
  settle(ms).then(() => { throw new Error(`Timed out: ${message}`); }),
]);

/**
 * Exclusive use of one Mosquitto instance for the rest of the current test; released, with users and
 * retained messages removed, by the test's cleanup.
 */
export async function leaseBroker() {
  const all = await listInstances();
  let instance: Instance | undefined;
  await waitFor(() => {
    instance = all.find((candidate) => claim(candidate));
    return instance;
  }, { timeout: 60000, interval: 20, message: 'a free Mosquitto instance' });
  // waitFor() throws unless a claim succeeded.
  onCleanup(() => release(instance!));

  const broker = new Broker(instance!);
  onCleanup(() => broker.close());
  await broker.open();
  return broker;
}

class Broker {
  name: string;
  port: number;
  hostname: string;
  credentials: Credentials;
  published: Array<{ topic: string; payload: string; qos: number; retain: boolean }>;
  log: string[];
  users: Set<string>;
  retainedTopics: Set<string>;
  proxies: BrokerProxy[];
  pendingDynsec: ((responses: DynsecResponse[]) => void) | null;
  // Set by open(), which leaseBroker() awaits before handing the broker out.
  follower!: ChildProcessByStdio<null, Readable, Readable>;
  clientId!: string;
  admin!: MqttClient;

  constructor(instance: Instance) {
    this.name = instance.name;
    this.port = instance.port;
    this.hostname = '127.0.0.1';
    this.credentials = BRIDGE_USER;
    this.published = [];
    this.log = [];
    this.users = new Set();
    this.retainedTopics = new Set();
    this.proxies = [];
    this.pendingDynsec = null;
  }

  async open() {
    const since = new Date(Date.now() - 100).toISOString();
    this.follower = spawn('docker', ['logs', '--follow', '--since', since, this.name], { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [this.follower.stdout, this.follower.stderr]) {
      let partial = '';
      stream.on('data', (chunk) => {
        const lines = (partial + chunk.toString()).split('\n');
        partial = lines.pop()!;
        this.log.push(...lines.filter(Boolean));
      });
    }

    // The log follower attaches in the background (a CLI process: it can take a second); readers wait for
    // what they expect, and `events` ignores everything before this client's own connect line.
    this.clientId = `${LOG_CLIENT_PREFIX}${randomUUID()}`;
    this.admin = await mqtt.connectAsync(`mqtt://${this.hostname}:${this.port}`, {
      protocolVersion: 5, clientId: this.clientId, ...ADMIN, keepalive: 0, reconnectPeriod: 0, clean: true,
    });
    this.admin.on('message', (topic, payload, packet) => this.onMessage(topic, payload, packet));
    await this.admin.subscribeAsync('$CONTROL/dynamic-security/v1/response', { qos: 1 });

    await this.reset();
    await this.admin.subscribeAsync(OBSERVED, { qos: 2, rap: true });
    await this.barrier();
    this.published.length = 0;
  }

  onMessage(topic: string, payload: Buffer, packet: IPublishPacket) {
    if (topic === `${DYNSEC_TOPIC}/response`) {
      this.pendingDynsec?.(JSON.parse(payload.toString()).responses);
      return;
    }
    if (packet.retain && payload.length > 0) this.retainedTopics.add(topic);
    if (packet.properties?.userProperties?.harness) return;
    this.published.push({ topic, payload: payload.toString(), qos: packet.qos, retain: packet.retain });
  }

  /** Returns once everything the broker queued for this client before now has arrived (same TCP stream, in order). */
  async barrier() {
    await this.admin.publishAsync('paradox-harness/barrier', '', { qos: 1, properties: FROM_HARNESS });
  }

  async dynsec(commands: DynsecCommand[]) {
    const response = new Promise<DynsecResponse[]>((resolve) => { this.pendingDynsec = resolve; });
    await this.admin.publishAsync(DYNSEC_TOPIC, JSON.stringify({ commands }), { qos: 1 });
    const responses = await withTimeout(response, `dynamic security ${commands.map((c) => c.command).join(', ')}`);
    const failed = responses.find((r) => r.error);
    if (failed) throw new Error(`dynamic security ${failed.command}: ${failed.error}`);
    return responses;
  }

  /** Leaves exactly the users, default ACLs and (empty) retained store every test starts from. */
  async reset() {
    const [{ data: { clients } }, { data: { roles } }] = await this.dynsec([{ command: 'listClients' }, { command: 'listRoles' }]);
    const stale = clients.filter((name) => !BASELINE_USERS.includes(name));
    const staleRoles = roles.filter((name) => name !== 'admin');
    await this.dynsec([
      ...stale.map((username) => ({ command: 'deleteClient', username })),
      ...staleRoles.map((rolename) => ({ command: 'deleteRole', rolename })),
      ...(clients.includes(BRIDGE_USER.username) ? [] : [{ command: 'createClient', ...BRIDGE_USER }]),
      // A test may have disabled the bridge's own user; a disabled user stays disabled.
      { command: 'enableClient', username: BRIDGE_USER.username },
      ...['publishClientSend', 'publishClientReceive', 'subscribe', 'unsubscribe'].map((acltype) => ({ command: 'setDefaultACLAccess', acls: [{ acltype, allow: true }] })),
    ]);
    await this.clearRetained();
  }

  async clearRetained() {
    await this.admin.subscribeAsync(OBSERVED, { qos: 1 });
    await this.barrier();
    await this.admin.unsubscribeAsync(OBSERVED);
    for (const topic of this.retainedTopics) await this.admin.publishAsync(topic, '', { qos: 1, retain: true, properties: FROM_HARNESS });
    this.retainedTopics.clear();
  }

  /**
   * Returns once the broker log (read through a separate stream, so it lags the MQTT connection) contains
   * everything that happened before now. Call it before asserting that something did NOT happen.
   */
  async syncLog() {
    const topic = `paradox-harness/sync-${randomUUID()}`;
    await this.admin.publishAsync(topic, '', { qos: 1, properties: FROM_HARNESS });
    await waitFor(() => this.log.some((line) => line.includes(topic)), { timeout: LOG_TIMEOUT, message: 'the broker log to catch up' });
  }

  /** Publishes as a client other than the code under test; invisible in `published`. */
  async publish(topic: string, payload: string, { retain = false, qos = 0 as QoS } = {}) {
    await this.admin.publishAsync(topic, payload, { retain, qos, properties: FROM_HARNESS });
    await this.barrier();
  }

  /** The retained payload of `topic`, or null: asks the way a new subscriber would. */
  async retained(topic: string) {
    const client = await mqtt.connectAsync(`mqtt://${this.hostname}:${this.port}`, {
      protocolVersion: 5, clientId: `${LOG_CLIENT_PREFIX}${randomUUID()}`, ...ADMIN, keepalive: 0, reconnectPeriod: 0,
    });
    let payload: string | null = null;
    client.on('message', (received, body) => { if (received === topic) payload = body.toString(); });
    await client.subscribeAsync(topic, { qos: 1 });
    await client.publishAsync('paradox-harness/barrier', '', { qos: 1 });
    await client.endAsync();
    return payload;
  }

  /** Creates a user for this test. */
  async addUser({ username, password }: Credentials) {
    this.users.add(username);
    await this.dynsec([{ command: 'createClient', username, password }]);
    return { username, password };
  }

  /** Disconnects every live session of `username`; the user stays valid and can reconnect. */
  async kick(username: string) {
    await this.dynsec([{ command: 'disableClient', username }, { command: 'enableClient', username }]);
  }

  /** A TCP relay in front of this broker that the test can break on purpose. Closed after the test. */
  async proxy() {
    const proxy = await new BrokerProxy(this).start();
    this.proxies.push(proxy);
    return proxy;
  }

  /** Log events of the code under test since the lease began, parsed. The harness's own clients are left out. */
  get events() {
    const marker = this.log.findIndex((line) => line.includes(`as ${this.clientId} `));
    if (marker === -1) return [];
    const events: BrokerEvent[] = [];
    let last: BrokerEvent | undefined;
    for (const line of this.log.slice(marker + 1)) {
      const text = line.replace(/^\d+: /, '');
      let match;
      if ((match = /^New client connected from \S+ as (\S+) \(p(\d+), c(\d), k(\d+)(?:, u'(.*)')?\)\.$/.exec(text))) {
        last = { type: 'connect', clientId: match[1], protocolLevel: Number(match[2]), clean: match[3] === '1', keepalive: Number(match[4]), username: match[5], will: null };
        events.push(last);
      } else if (last && last.type === 'connect' && text === 'No will message specified.') {
        last.will = false;
      } else if (last && last.type === 'connect' && text.startsWith('Will message specified')) {
        last.will = true;
      } else if ((match = /^Sending CONNACK to (\S+) \((\d), (\d+)\)$/.exec(text))) {
        events.push({ type: 'connack', clientId: match[1], returnCode: Number(match[3]) });
      } else if ((match = /^Received SUBSCRIBE from (\S+)$/.exec(text))) {
        last = { type: 'subscribe', clientId: match[1], topics: [] };
        events.push(last);
      } else if (last && last.type === 'subscribe' && (match = /^\t(.+) \(QoS (\d)\)$/.exec(text))) {
        last.topics.push({ topic: match[1], qos: Number(match[2]) });
      } else if ((match = /^Received PUBLISH from (\S+) \(d(\d), q(\d), r(\d), m\d+, '(.*)', \.\.\. \((\d+) bytes\)\)$/.exec(text))) {
        events.push({ type: 'publish', clientId: match[1], qos: Number(match[3]), retain: match[4] === '1', topic: match[5], bytes: Number(match[6]) });
      } else if ((match = /^Client (\S+) \[\S+\] disconnected(?:: (.*))?\.$/.exec(text))) {
        events.push({ type: 'disconnect', clientId: match[1], reason: match[2] ?? 'client disconnected' });
      } else if ((match = /^Socket error on client (\S+), disconnecting\.$/.exec(text))) {
        events.push({ type: 'disconnect', clientId: match[1], reason: 'socket error' });
      }
    }
    // The harness's own clients and the compose healthcheck are not the code under test. The healthcheck
    // (mosquitto_sub as admin, `auto-` client id) can straddle the start of a lease, leaving a CONNACK or
    // disconnect whose connect line is outside the window, so it is recognised by its id as well.
    const ignored = new Set(events.filter((e) => e.type === 'connect' && e.username === ADMIN.username).map((e) => e.clientId));
    return events.filter((event) => !event.clientId.startsWith(LOG_CLIENT_PREFIX) && !event.clientId.startsWith('auto-') && !ignored.has(event.clientId));
  }

  /**
   * CONNECT packets of the code under test the broker ACCEPTED: { clientId, protocolLevel (4 = MQTT 3.1.1),
   * clean, keepalive, username, will }. Mosquitto logs a refused login only as a CONNACK (see `connacks`), and
   * never a password: use `proxy().connects` to see what was sent.
   */
  get connects() {
    return this.events.filter((e) => e.type === 'connect').map(({ type, ...connect }) => connect);
  }

  /** Every subscribed topic with the QoS the client asked for, in order. */
  get subscriptions() {
    return this.events.filter((e) => e.type === 'subscribe').flatMap((e) => e.topics);
  }

  /** CONNACK return codes (0 accepted, 5 not authorised: Mosquitto uses it for failed logins too) sent to the code under test. */
  get connacks() {
    return this.events.filter((e) => e.type === 'connack').map((e) => e.returnCode);
  }

  /** Why the broker saw the code under test go away: { clientId, reason }. */
  get disconnects() {
    return this.events.filter((e) => e.type === 'disconnect').map(({ type, ...disconnect }) => disconnect);
  }

  /** PUBLISH packets the code under test sent: { topic, qos, retain, bytes }; the payload is in `published`. */
  get clientPublishes() {
    return this.events.filter((e) => e.type === 'publish').map(({ type, clientId, ...publish }) => publish);
  }

  async close() {
    for (const proxy of this.proxies) await proxy.stop();
    this.follower?.kill();
    if (!this.admin?.connected) return;
    // A test may have deleted users itself; cleanup must not stop at the first command that no longer applies.
    await this.dynsec([
      ...[...this.users].map((username) => ({ command: 'deleteClient', username })),
      { command: 'enableClient', username: BRIDGE_USER.username },
    ]).catch(() => this.reset());
    await this.clearRetained();
    await this.admin.endAsync();
  }
}

/**
 * TCP relay between the code under test and a leased broker. Besides forwarding bytes it can behave like the
 * network or a broken broker would: refuse connections, accept them and say nothing, write garbage to connected
 * clients, or cut every connection.
 */
type ProxyConnect = { clientId: string; username: string | null; password: string | null; keepalive: number | undefined; clean: boolean | undefined };

class BrokerProxy {
  broker: Broker;
  hostname: string;
  sockets: Set<net.Socket>;
  mode: { kind: 'forward' | 'blackhole' };
  accepted: number;
  connects: ProxyConnect[];
  port!: number;
  server?: net.Server | null;

  constructor(broker: Broker) {
    this.broker = broker;
    this.hostname = '127.0.0.1';
    this.sockets = new Set();
    this.mode = { kind: 'forward' };
    /** TCP connections accepted so far (also while black-holed), to tell redials. */
    this.accepted = 0;
    /**
     * CONNECT packets the clients sent through this proxy, in any mode: { clientId, username, password, keepalive,
     * clean }, null for a field the packet does not carry. Mosquitto's log never shows a password, nor the
     * credentials of a login it refuses; this is the only place they are visible.
     */
    this.connects = [];
  }

  async start(port?: number) {
    this.port = port ?? await reservePort();
    this.server = net.createServer((client) => this.accept(client));
    await new Promise<void>((resolve) => this.server!.listen(this.port, this.hostname, resolve));
    return this;
  }

  accept(client: net.Socket) {
    this.accepted += 1;
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => {});
    const parser = mqttPacket.parser({ protocolVersion: 4 });
    parser.on('packet', (packet) => {
      if (packet.cmd !== 'connect') return;
      this.connects.push({
        clientId: packet.clientId,
        username: packet.username ?? null,
        password: packet.password === undefined ? null : packet.password.toString(),
        keepalive: packet.keepalive,
        clean: packet.clean,
      });
    });
    parser.on('error', () => {});
    client.on('data', (chunk) => parser.parse(chunk));
    if (this.mode.kind === 'blackhole') return;
    const upstream = net.connect(this.broker.port, this.broker.hostname);
    this.sockets.add(upstream);
    upstream.on('close', () => { this.sockets.delete(upstream); client.destroy(); });
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  }

  /** New connections are accepted and then ignored: the client's CONNECT is never answered. */
  blackhole() {
    this.mode = { kind: 'blackhole' };
  }

  forward() {
    this.mode = { kind: 'forward' };
  }

  /** Writes raw bytes to every connected client, as if the broker had sent them. */
  inject(bytes: number[] | Buffer) {
    for (const socket of this.sockets) if (socket.remotePort !== this.broker.port) socket.write(Buffer.from(bytes));
  }

  /** Cuts every live connection (the listener stays, so clients can redial). */
  dropConnections() {
    for (const socket of [...this.sockets]) socket.destroy();
  }

  /** Stops listening and cuts every connection: later dials get ECONNREFUSED. `start(this.port)` brings it back. */
  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.dropConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
