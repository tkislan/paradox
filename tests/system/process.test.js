import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARMED, DISARMED, FakePanel, renderStatusPage } from '../mock_paradox.js';
import { leaseBroker } from '../mosquitto.js';
import { BUILD_DIR, onCleanup, reservePort, settle, waitFor } from '../support.js';

/*
 * The whole bridge as a real child process (real timers, real signals, real exit codes) against the
 * fake panel and a real Mosquitto broker (leased from tests/docker-compose.yml, see ../mosquitto.js).
 * Everything here costs real seconds, so independent scenarios of one table run concurrently inside a
 * single test (runRows): describe.concurrent is unusable because onCleanup() keeps one global list that
 * the first finished test would drain for all the others. Each row leases its own broker, because the
 * bridge hard-codes its topics (rows that must never reach a broker may share one).
 *
 * What Mosquitto cannot do by itself (refuse or swallow a connection, forge a packet, cut the socket) goes
 * through broker.proxy(). Broker-side observations come from Mosquitto's log, which lags the connections:
 * waitFor what is expected and syncLog() before asserting that something did NOT happen.
 *
 * PARADOX_NODE selects the runtime of the child (default: the Node running vitest). Assertions rely on the bridge's own messages and exit codes, not on
 * Node's wording, except where a test says it branches on the child's major version.
 */

const NODE = process.env.PARADOX_NODE || process.execPath;
const NODE_MAJOR = Number(execFileSync(NODE, ['-p', 'process.versions.node.split(".")[0]'], { encoding: 'utf8' }));
const APP = path.join(BUILD_DIR, 'app.js');

// Literal copy of one golden row of spec/crypto.json (panel session value -> the u/p query the bridge must send).
const golden = {
  session: '91AC25D06A0C26BA',
  username: 'user',
  password: '1234',
  u: 'EBA2095C',
  p: '82016AC9BD9B087D6C393B19C756B255',
};
const MQTT_CREDENTIALS = { username: 'mqttuser', password: 'mqttpass' };
// Mosquitto answers every failed login with CONNACK 5; this is how mqtt.js words it:
const NOT_AUTHORIZED = 'Connection refused: Not authorized';
// A CONNACK with return code 4 (bad credentials), as a broker would have to forge it on a live connection.
const FORGED_CONNACK_BAD_CREDENTIALS = [0x20, 0x02, 0x00, 0x04];

const ENV_NAMES = ['HOSTNAME', 'USERNAME', 'PASSWORD', 'PORT', 'MQTT_HOSTNAME', 'MQTT_PORT', 'MQTT_USERNAME', 'MQTT_PASSWORD'];
const HTML = { 'Content-Type': 'text/html' };
const LOGIN_ATTEMPT_PATHS = ['/logout.html', '/login_page.html', '/default.html'];

const ARM_LINE = 'GET /statuslive.html?area=00&value=r';
const DISARM_LINE = 'GET /statuslive.html?area=00&value=d';

const ZONE_SLOTS = 32;
const zones = (...open) => Array.from({ length: ZONE_SLOTS }, (_, i) => (open.includes(i) ? 1 : 0));
const zoneCodes = (...codes) => Array.from({ length: ZONE_SLOTS }, (_, i) => codes[i] || 0);

const liveBridges = new Set();

// Real processes and containers on a busy machine: generous limits cost nothing while everything is fast.
const TEST_TIMEOUT = 90000;

class TimedPanel extends FakePanel {
  /** Stamps every request when the panel receives it, so timing assertions do not depend on how late the test polled. */
  handle(request) {
    request.at = performance.now();
    return super.handle(request);
  }
}

/** Like waitFor, but a timeout reports what every running bridge has printed, which is what explains it. */
async function until(condition, message, timeout = 15000) {
  try {
    return await waitFor(condition, { timeout, interval: 10, message });
  } catch (error) {
    const reports = [...liveBridges].map((b) => `exit: ${JSON.stringify(b.result)}\nstdout: ${b.stdout.slice(-400)}\nstderr: ${b.stderr.slice(-400)}\nbroker: ${JSON.stringify(b.broker.events.slice(-6))}`);
    throw new Error(`${error.message}\n${reports.join('\n---\n')}`);
  }
}

class Bridge {
  /** `env` entries set to undefined are left out, so a variable can be missing from the child's environment. */
  constructor(env, { cwd = os.tmpdir(), broker } = {}) {
    this.broker = broker;
    this.stdout = '';
    this.stderr = '';
    this.result = null;
    this.exitedAt = null;
    // cwd is never the repo: a non-numeric PORT makes the server create a socket file there.
    this.child = spawn(NODE, [APP], {
      cwd,
      env: { PATH: process.env.PATH, ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8').on('data', (chunk) => { this.stdout += chunk; });
    this.child.stderr.setEncoding('utf8').on('data', (chunk) => { this.stderr += chunk; });
    const finish = (resolve, result) => {
      this.exitedAt = performance.now();
      resolve((this.result = result));
    };
    this.closed = new Promise((resolve) => {
      this.child.once('error', (error) => finish(resolve, { code: null, signal: null, error }));
      this.child.once('close', (code, signal) => finish(resolve, { code, signal }));
    });
    liveBridges.add(this);
    onCleanup(async () => {
      this.child.kill('SIGKILL');
      await this.closed;
      liveBridges.delete(this);
    });
  }

  kill(signal) {
    this.child.kill(signal);
  }

  /** Resolves with { code, signal } once the child has exited and its output pipes are drained. */
  waitForExit(timeout = 10000) {
    return until(() => this.result, 'the bridge process to exit', timeout);
  }
}

/**
 * Starts a FakePanel that accepts the bridge's credentials, leases a Mosquitto broker that has a user with
 * the bridge's MQTT credentials, and starts a bridge process wired to both.
 *
 * `brokerUser` is the account the broker knows (default: the one the bridge is configured with); a bridge
 * configured with other credentials is rejected for real. `proxy` routes the bridge through a
 * broker.proxy(): `true` forwards, a function gets the proxy to break it before the bridge starts.
 * `broker` reuses a lease the caller owns (and has set up: no user is created then).
 */
async function launch({ panel: panelOptions, brokerUser = MQTT_CREDENTIALS, proxy: proxyOption, broker: leased, env, cwd } = {}) {
  const panel = await new TimedPanel({
    sessionValue: golden.session,
    credentials: { [golden.session]: { u: golden.u, p: golden.p } },
    ...panelOptions,
  }).start();
  const broker = leased ?? await leaseBroker();
  if (!leased) await broker.addUser(brokerUser);
  const proxy = proxyOption ? await broker.proxy() : undefined;
  if (typeof proxyOption === 'function') await proxyOption(proxy);
  const mqttEndpoint = proxy ?? broker;
  const port = await reservePort();
  const bridge = new Bridge({
    HOSTNAME: panel.hostname,
    USERNAME: golden.username,
    PASSWORD: golden.password,
    PORT: String(port),
    MQTT_HOSTNAME: mqttEndpoint.hostname,
    MQTT_PORT: String(mqttEndpoint.port),
    MQTT_USERNAME: MQTT_CREDENTIALS.username,
    MQTT_PASSWORD: MQTT_CREDENTIALS.password,
    ...env,
  }, { cwd, broker });
  return { panel, broker, proxy, port, bridge };
}

const untilListening = ({ bridge, port }) => until(() => bridge.stdout.includes(`Server listening on port ${port}`), 'the server to listen');

/** The command subscriptions are made before the first poll, but the broker log that shows them lags. */
const untilSubscribed = ({ broker }) => until(() => broker.subscriptions.length === 2, 'both command subscriptions');

const publishedMessages = ({ broker }) => broker.published.map((p) => `${p.topic} ${p.payload}`);

const polls = (panel) => panel.requestsTo('/statuslive.html').filter((request) => !request.query.value);

/** Plain HTTP request with its own connection (Connection: close), so no idle socket outlives the call. */
function request(target, method, urlPath, { agent = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...target, method, path: urlPath, agent }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Makes the panel answer HTTP 500 to the commands with these `value` codes (r = arm, d = disarm) and honour the others. */
function failCommands(panel, failing) {
  panel.respondWith('/statuslive.html', ({ query }) => {
    if (failing.includes(query.value)) return { status: 500, headers: HTML, body: 'busy' };
    if (query.value === 'r') panel.setStatus({ useraccess: [ARMED, 0] });
    if (query.value === 'd') panel.setStatus({ useraccess: [DISARMED, 0] });
    return { status: 200, headers: HTML, body: renderStatusPage(panel) };
  });
}

const rest = (ctx, method, urlPath, options) => request({ host: '127.0.0.1', port: ctx.port }, method, urlPath, options);

/** Runs independent scenarios concurrently (each owns its bridge, panel and broker) and names every failing row. */
async function runRows(rows, scenario) {
  const outcomes = await Promise.allSettled(rows.map((row) => scenario(row)));
  const failures = outcomes.flatMap((outcome, i) => (outcome.status === 'rejected' ? [`[${rows[i].name}] ${outcome.reason.message}`] : []));
  expect(failures).toEqual([]);
}

/** The bridge must exit 1 before it listens or polls the panel, after logging every text of `stderrIncludes`. */
async function expectStartupFailure({ bridge, panel }, stderrIncludes, { timeout } = {}) {
  expect(await bridge.waitForExit(timeout)).toEqual({ code: 1, signal: null });
  for (const text of stderrIncludes) expect(bridge.stderr).toContain(text);
  expect(bridge.stdout).not.toContain('Server listening');
  expect(polls(panel)).toEqual([]);
}

/** Login runs before the MQTT connection is opened, so a failing login must leave the broker untouched. */
async function expectLoginFailure(ctx, stderrIncludes) {
  await expectStartupFailure(ctx, stderrIncludes);
  await ctx.broker.syncLog();
  expect(ctx.broker.connects).toEqual([]);
}

describe('bridge process', () => {
  describe('configuration', () => {
    // Scenario table: language-neutral, can move to spec/process.json when the Python suite needs it.
    const MISSING_ENV = [
      ...ENV_NAMES.map((name) => ({ name: `${name} missing`, missing: [name], reported: name })),
      { name: 'several missing: the first in declaration order is reported', missing: ['MQTT_PASSWORD', 'PORT'], reported: 'PORT' },
      { name: 'nothing set at all', missing: ENV_NAMES, reported: 'HOSTNAME' },
    ];

    it('KNOWN BUG KB-20: exits 1 before touching the network with the misspelled "Missing enviromnent variable: <first missing name>"', async () => {
      // No row may reach the broker, so they can all be pointed at one.
      const broker = await leaseBroker();
      await broker.addUser(MQTT_CREDENTIALS);

      await runRows(MISSING_ENV, async ({ missing, reported }) => {
        const ctx = await launch({ broker, env: Object.fromEntries(missing.map((name) => [name, undefined])) });

        expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });
        expect(ctx.bridge.stderr).toContain(`Error: Missing enviromnent variable: ${reported}`);
        expect(ctx.bridge.stdout).toBe('');
        expect(ctx.panel.requests).toEqual([]);
      });

      await broker.syncLog();
      expect(broker.connects).toEqual([]);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-41: an empty environment variable counts as set, so an empty USERNAME fails at login instead of in the config check', async () => {
      const ctx = await launch({ env: { USERNAME: '' } });

      expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });
      expect(ctx.bridge.stderr).not.toContain('Missing enviromnent variable');
      expect(ctx.panel.requestsTo('/default.html')).toHaveLength(1);
    }, TEST_TIMEOUT);
  });

  describe('startup', () => {
    it('logs in, connects to MQTT with the configured credentials, subscribes to both command topics, then starts listening', async () => {
      const ctx = await launch();

      await untilListening(ctx);

      expect(ctx.panel.requestLines).toEqual([
        'GET /logout.html',
        'GET /login_page.html',
        `GET /default.html?u=${golden.u}&p=${golden.p}`,
        'GET /index.html',
      ]);
      expect(ctx.bridge.stdout).toContain('Session value: 91AC25D06A0C26BA');
      expect(ctx.bridge.stdout).toContain('MQTT client connected');
      await untilSubscribed(ctx);
      await ctx.broker.syncLog();
      // Mosquitto never reports passwords: the bridge being let in (CONNACK 0) as the one user that has them is the evidence.
      expect(ctx.broker.connects).toHaveLength(1);
      expect(ctx.broker.connects[0]).toMatchObject({ username: 'mqttuser' });
      expect(ctx.broker.connacks).toEqual([0]);
      expect(ctx.broker.subscriptions).toEqual([
        { topic: 'paradox/command/arm', qos: 0 },
        { topic: 'paradox/command/disarm', qos: 0 },
      ]);
      expect(ctx.bridge.result).toBeNull();
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-11: a rejected login that the panel answers with the login page again is reported as "Session value not found in login page"', async () => {
      const ctx = await launch({ env: { PASSWORD: 'wrong' } });

      await expectLoginFailure(ctx, ['Error: Session value not found in login page']);

      expect(ctx.panel.requests.map((r) => r.path)).toEqual(LOGIN_ATTEMPT_PATHS);
    }, TEST_TIMEOUT);

    it('exits 1 with "Login failed" when the panel answers the login with a page of another title', async () => {
      const ctx = await launch();
      ctx.panel.respondWith('/default.html', {
        status: 200,
        headers: HTML,
        body: '<html><head><title>Paradox Login</title></head><body></body></html>',
      });

      await expectLoginFailure(ctx, ['Error: Login failed']);

      expect(ctx.panel.requests.map((r) => r.path)).toEqual(LOGIN_ATTEMPT_PATHS);
    }, TEST_TIMEOUT);

    it('exits 1 when the panel is not reachable at all, after warning that the logout before login failed', async () => {
      const ctx = await launch({ env: { HOSTNAME: `127.0.0.1:${await reservePort()}` } });

      await expectLoginFailure(ctx, ['Logout before login failed', 'ECONNREFUSED']);

      expect(ctx.panel.requests).toEqual([]);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-5: an index page that keeps failing is requested 11 times back to back before startup gives up', async () => {
      const ctx = await launch();
      ctx.panel.respondWith('/index.html', { status: 500, headers: HTML, body: 'busy' });

      await expectLoginFailure(ctx, ['Request failed with status code 500']);

      expect(ctx.panel.requests.map((r) => r.path)).toEqual([...LOGIN_ATTEMPT_PATHS, ...Array(11).fill('/index.html')]);
    }, TEST_TIMEOUT);

    it('exits 1 when the login page has no session value, without sending any credentials', async () => {
      const ctx = await launch();
      ctx.panel.respondWith('/login_page.html', { status: 200, headers: HTML, body: '<html><head><title>Paradox</title></head><body>busy</body></html>' });

      await expectLoginFailure(ctx, ['Error: Session value not found in login page']);

      expect(ctx.panel.requests.map((r) => r.path)).toEqual(['/logout.html', '/login_page.html']);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-10: a zone name with a hyphen makes the index page unparsable and login fail', async () => {
      const ctx = await launch({ panel: { zones: [[1, 'Front-door']] } });

      await expectLoginFailure(ctx, ["Error: Regex didn't match the value"]);

      expect(ctx.panel.requests.map((r) => r.path)).toEqual([...LOGIN_ATTEMPT_PATHS, '/index.html']);
    }, TEST_TIMEOUT);

    it('exits 1 when the MQTT broker rejects the credentials, without ever polling the panel', async () => {
      const ctx = await launch({ env: { MQTT_PASSWORD: 'not-the-password' } });

      await expectStartupFailure(ctx, [NOT_AUTHORIZED]);

      await until(() => ctx.broker.connacks.length === 1, 'the broker to answer the login');
      await ctx.broker.syncLog();
      // Mosquitto logs a CONNECT only once it accepted it, so the one rejected attempt shows up as a CONNACK alone.
      expect(ctx.broker.connacks).toEqual([5]);
      expect(ctx.broker.connects).toEqual([]);
      expect(ctx.bridge.stdout).not.toContain('MQTT client connected');
    }, TEST_TIMEOUT);

    it('gives up after the 5 s connect timeout when nothing listens on the MQTT port or the broker never answers CONNECT', async () => {
      // The bridge's TCP connections are the ones the proxy accepted; its CONNECT never reaches Mosquitto in either row.
      const rows = [
        { name: 'nothing listening', proxy: (proxy) => proxy.stop(), accepted: 0, sentConnect: false },
        { name: 'broker accepts TCP but never answers CONNECT', proxy: (proxy) => proxy.blackhole(), accepted: 1, sentConnect: true },
      ];

      await runRows(rows, async ({ proxy, accepted, sentConnect }) => {
        const ctx = await launch({ proxy });

        await expectStartupFailure(ctx, ['Error: MQTT connect timeout'], { timeout: 20000 });

        const [index] = ctx.panel.requestsTo('/index.html');
        const sinceLogin = ctx.bridge.exitedAt - index.at;
        expect(sinceLogin).toBeGreaterThanOrEqual(4500);
        expect(sinceLogin).toBeLessThan(6500);
        expect(ctx.panel.requestsTo('/index.html')).toHaveLength(1);
        expect(ctx.proxy.accepted).toBe(accepted);
        if (sentConnect) {
          expect(ctx.proxy.connects).toMatchObject([{ username: MQTT_CREDENTIALS.username, password: MQTT_CREDENTIALS.password }]);
        }
        await ctx.broker.syncLog();
        expect(ctx.broker.connects).toEqual([]);
        expect(ctx.bridge.stdout).not.toContain('MQTT client connected');
        expect(ctx.panel.requestsTo('/keep_alive.html')).toEqual([]);
      });
    }, TEST_TIMEOUT);

    it('exits 1 on an uncaught error event when the REST port is already in use', async () => {
      const blocker = await new Promise((resolve) => {
        const server = http.createServer();
        server.listen(0, () => resolve(server));
      });
      onCleanup(() => new Promise((resolve) => blocker.close(resolve)));
      const ctx = await launch({ env: { PORT: String(blocker.address().port) } });

      expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });

      expect(ctx.bridge.stderr).toContain('EADDRINUSE');
      expect(ctx.bridge.stdout).toContain('MQTT client connected');
      expect(ctx.bridge.stdout).not.toContain('Server listening');
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-25: an out-of-range PORT is only noticed by listen(), after login and the MQTT connect, and exits 1', async () => {
      const ctx = await launch({ env: { PORT: '99999' } });

      expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });

      expect(ctx.bridge.stderr).toContain('ERR_SOCKET_BAD_PORT');
      expect(ctx.bridge.stdout).toContain('MQTT client connected');
      expect(ctx.panel.requestsTo('/index.html')).toHaveLength(1);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-25: a non-numeric PORT makes the REST server listen on a Unix socket of that name in the working directory', async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paradox-bridge-'));
      onCleanup(() => fs.rmSync(cwd, { recursive: true, force: true }));
      const ctx = await launch({ env: { PORT: 'bridge.sock' }, cwd });

      await until(() => ctx.bridge.stdout.includes('Server listening on port bridge.sock'), 'the server to listen');

      expect(fs.statSync(path.join(cwd, 'bridge.sock')).isSocket()).toBe(true);
      const response = await request({ socketPath: path.join(cwd, 'bridge.sock') }, 'GET', '/status');
      expect(response.status).toBe(200);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-13: a panel that never answers during login hangs startup forever, and SIGTERM then kills the process by default action', async () => {
      const ctx = await launch();
      ctx.panel.respondWith('/login_page.html', { hang: true });

      await until(() => ctx.panel.requestsTo('/login_page.html').length === 1, 'the login page request');
      await settle(1200);

      await ctx.broker.syncLog();
      expect(ctx.bridge.result).toBeNull();
      expect(ctx.broker.connects).toEqual([]);
      expect(ctx.bridge.stdout).not.toContain('Server listening');
      ctx.bridge.kill('SIGTERM');
      // The signal handlers are installed only at the very end of startup, so Node's default applies:
      // death by signal instead of the 128 + n exit code of the handled path.
      expect(await ctx.bridge.waitForExit()).toEqual({ code: null, signal: 'SIGTERM' });
    }, TEST_TIMEOUT);
  });

  describe('running', () => {
    // First poll: the bridge assumes armed = unknown and every sensor closed, and only publishes differences from that.
    const THREE_ZONES_FIRST_DISABLED = [[0, ' '], [1, 'Door'], [1, 'Window']];
    const FIRST_POLL = [
      { name: 'disarmed, all zones closed: only the armed topic gets OFF', useraccess: [1, 0], statuszone: zones(), published: ['paradox/status/armed OFF'] },
      {
        name: 'armed with zones 0 and 5 open: ON for the armed topic and the two open sensors, closed ones stay silent',
        useraccess: [2, 0],
        statuszone: zones(0, 5),
        published: ['paradox/status/armed ON', 'paradox/sensor/0 ON', 'paradox/sensor/5 ON'],
      },
      { name: 'arming (code 7) counts as armed', useraccess: [7, 0], statuszone: zones(), published: ['paradox/status/armed ON'] },
      { name: 'unknown area code (3): nothing is published', useraccess: [3, 0], statuszone: zones(), published: [] },
      { name: 'KB-18: only area 1 matters, area 2 armed does not make the bridge armed', useraccess: [1, 2], statuszone: zones(), published: ['paradox/status/armed OFF'] },
      {
        name: 'KB-2: with the first zone disabled, status entry 1 (the Door) is published as sensor 1, the position of the Window',
        zones: THREE_ZONES_FIRST_DISABLED,
        useraccess: [1, 0],
        statuszone: zones(1),
        published: ['paradox/status/armed OFF', 'paradox/sensor/1 ON'],
      },
      {
        name: 'KB-2: with the first zone disabled, the last zone (status entry 2) is never read',
        zones: THREE_ZONES_FIRST_DISABLED,
        useraccess: [1, 0],
        statuszone: zones(2),
        published: ['paradox/status/armed OFF'],
      },
      {
        name: 'KB-1: with 32 enabled zones only the first 16 are watched: status entry 15 is published, entries 16 and 20 are never read',
        zones: Array.from({ length: 32 }, (_, i) => [1, `Zone ${i + 1}`]),
        useraccess: [1, 0],
        statuszone: zones(10, 15, 16, 20),
        published: ['paradox/status/armed OFF', 'paradox/sensor/10 ON', 'paradox/sensor/15 ON'],
      },
      {
        name: 'KB-21: only status code 1 is an open zone, in alarm (2), trouble (3, 4), memory (5, 6) and bypassed (7) are reported as closed',
        useraccess: [1, 0],
        statuszone: zoneCodes(2, 3, 4, 5, 6, 7),
        published: ['paradox/status/armed OFF'],
      },
    ];

    it('KNOWN BUG KB-4: only differences from the assumed initial state reach MQTT on the first poll, retained, and unchanged polls publish nothing (rows KB-1, KB-2, KB-18 pin their own quirks)', async () => {
      await runRows(FIRST_POLL, async ({ zones: panelZones, useraccess, statuszone, published }) => {
        const ctx = await launch({ panel: { zones: panelZones, useraccess, statuszone } });

        // The third poll is due a second after the second one, by when the second one's result has been handled (and published, had it been a change).
        await until(() => polls(ctx.panel).length >= 3, 'three status polls');
        await ctx.broker.syncLog();

        expect(publishedMessages(ctx)).toEqual(published);
        expect(ctx.broker.published.every((p) => p.retain === true && p.qos === 0)).toBe(true);
        // The broker really holds what was published, and nothing else: the retain flag is not just claimed.
        const retained = Object.fromEntries(published.map((message) => message.split(' ')));
        for (const topic of new Set(['paradox/status/armed', ...Object.keys(retained)])) {
          expect(await ctx.broker.retained(topic)).toBe(retained[topic] ?? null);
        }
      });
    }, TEST_TIMEOUT);

    it('publishes later panel changes to MQTT and logs, without publishing, an armed code it does not know', async () => {
      const ctx = await launch();
      const published = () => publishedMessages(ctx);
      await until(() => published().length === 1, 'the first publish');

      ctx.panel.setStatus({ useraccess: [2, 0], statuszone: zones(0, 3) });
      await until(() => published().length === 4, 'the publishes of the armed panel');
      ctx.panel.setStatus({ useraccess: [3, 0], statuszone: zones() });
      await until(() => published().length === 6, 'the publishes of the closed sensors');

      await until(() => ctx.bridge.stdout.includes('Unknown armed status'), 'the unknown armed status log');
      expect(published()).toEqual([
        'paradox/status/armed OFF',
        'paradox/status/armed ON',
        'paradox/sensor/0 ON',
        'paradox/sensor/3 ON',
        'paradox/sensor/0 OFF',
        'paradox/sensor/3 OFF',
      ]);
      expect(ctx.broker.published.every((p) => p.retain === true)).toBe(true);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-16: MQTT command payloads are ignored, the topic alone arms or disarms; a failing command is only logged', async () => {
      const ctx = await launch();
      const published = () => publishedMessages(ctx);
      await until(() => published().length === 1, 'the first publish');
      await untilSubscribed(ctx);

      await ctx.broker.publish('paradox/command/arm', 'OFF');
      await until(() => ctx.panel.requestLines.includes(ARM_LINE), 'the arm request');
      await until(() => published().length === 2, 'the armed state to come back');

      failCommands(ctx.panel, ['r']);
      await ctx.broker.publish('paradox/command/arm', 'ON');
      await ctx.broker.publish('paradox/command/disarm', '');
      await until(() => ctx.bridge.stderr.includes('Request failed with status code 500'), 'the failed arm to be logged');
      await until(() => ctx.panel.requestLines.includes(DISARM_LINE), 'the disarm request');
      await until(() => published().length === 3, 'the disarmed state to come back');

      expect(published()).toEqual(['paradox/status/armed OFF', 'paradox/status/armed ON', 'paradox/status/armed OFF']);
      expect(ctx.bridge.result).toBeNull();
      // Node before 15 only warns about an unhandled rejection and keeps running, so the exit check above would not see it.
      expect(ctx.bridge.stderr).not.toContain('Unhandled');
    }, TEST_TIMEOUT);

    it('GET /status returns the raw status JSON; POST /arm and /disarm send the panel commands; other routes are 404', async () => {
      const ctx = await launch({ panel: { statuszone: zones(1) } });
      await untilListening(ctx);

      const status = await rest(ctx, 'GET', '/status');
      expect(status.status).toBe(200);
      expect(status.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(JSON.parse(status.body)).toEqual({ statuszone: zones(1), useraccess: [1, 0], alarms: [0] });

      const arm = await rest(ctx, 'POST', '/arm');
      expect(arm).toMatchObject({ status: 200, body: 'OK' });
      expect(JSON.parse((await rest(ctx, 'GET', '/status')).body).useraccess).toEqual([2, 0]);
      const disarm = await rest(ctx, 'POST', '/disarm');
      expect(disarm).toMatchObject({ status: 200, body: 'OK' });
      expect(JSON.parse((await rest(ctx, 'GET', '/status')).body).useraccess).toEqual([1, 0]);

      expect(ctx.panel.requestLines.filter((line) => line.includes('area='))).toEqual([ARM_LINE, DISARM_LINE]);
      expect((await rest(ctx, 'GET', '/arm')).status).toBe(404);
      expect((await rest(ctx, 'POST', '/status')).status).toBe(404);
      expect((await rest(ctx, 'GET', '/')).status).toBe(404);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-15: GET /status always reports alarms [0], whatever alarms the panel lists', async () => {
      const ctx = await launch();
      ctx.panel.setStatus({ alarms: ['1', '0', '3'] });
      await untilListening(ctx);

      const { body } = await rest(ctx, 'GET', '/status');

      expect(JSON.parse(body).alarms).toEqual([0]);
    }, TEST_TIMEOUT);

    it('answers 500 with the error message as JSON when the panel fails a REST-triggered request', async () => {
      const ctx = await launch();
      await untilListening(ctx);
      await until(() => polls(ctx.panel).length === 1, 'the first poll');
      // Taken right after a poll: the next one is ~1 s away, so only the REST call can consume the one-shot override.
      ctx.panel.respondWith('/statuslive.html', { status: 500, headers: HTML, body: 'busy' }, { times: 1 });

      const status = await rest(ctx, 'GET', '/status');

      expect(status.status).toBe(500);
      expect(JSON.parse(status.body)).toEqual({ msg: 'Request failed with status code 500' });
      failCommands(ctx.panel, ['r', 'd']);
      for (const route of ['/arm', '/disarm']) {
        const response = await rest(ctx, 'POST', route);
        expect(response.status).toBe(500);
        expect(JSON.parse(response.body)).toEqual({ msg: 'Request failed with status code 500' });
      }
      expect(ctx.bridge.result).toBeNull();
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-14: POST /arm answers 200 even though the panel only served the login page, and the next poll then kills the bridge', async () => {
      const ctx = await launch({ panel: { requireLogin: true } });
      await untilListening(ctx);
      ctx.panel.expireSession();

      const response = await rest(ctx, 'POST', '/arm');

      expect(response).toMatchObject({ status: 200, body: 'OK' });
      expect(ctx.panel.requestLines).toContain(ARM_LINE);
      expect(ctx.panel.useraccess).toEqual([1, 0]);
      expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-19: the REST API needs no credentials and listens on every interface (127.0.0.2 stands in for a LAN address)', async () => {
      const ctx = await launch();
      await untilListening(ctx);

      const other = { host: '127.0.0.2', port: ctx.port };

      expect((await request(other, 'GET', '/status')).status).toBe(200);
      expect((await request(other, 'POST', '/arm')).status).toBe(200);
      expect(ctx.panel.requestLines).toContain(ARM_LINE);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-9: sends GET /keep_alive.html?msgid=1 every 3 s without the random cache-buster; a failing keep-alive is only logged', async () => {
      const rows = [
        { name: 'healthy panel', failFirstKeepAlive: false },
        { name: 'first keep-alive answered with HTTP 500', failFirstKeepAlive: true },
      ];

      await runRows(rows, async ({ failFirstKeepAlive }) => {
        const ctx = await launch();
        if (failFirstKeepAlive) ctx.panel.respondWith('/keep_alive.html', { status: 500, headers: HTML, body: 'busy' }, { times: 1 });

        await until(() => ctx.panel.requestsTo('/keep_alive.html').length === 2, 'two keep-alives', 20000);

        const [first, second] = ctx.panel.requestsTo('/keep_alive.html');
        const sinceLogin = first.at - ctx.panel.requestsTo('/index.html')[0].at;
        expect(sinceLogin).toBeGreaterThanOrEqual(2200);
        expect(sinceLogin).toBeLessThan(4600);
        // Both stamps are taken by the panel, so the gap is the bridge's interval plus one loopback hop of jitter.
        expect(second.at - first.at).toBeGreaterThanOrEqual(2750);
        expect(second.at - first.at).toBeLessThan(3400);
        expect(ctx.panel.requestLines.filter((line) => line.includes('keep_alive'))).toEqual(['GET /keep_alive.html?msgid=1', 'GET /keep_alive.html?msgid=1']);
        // Polls run every second: 2 or 3 of them (the third is due together with the keep-alive) come before the first keep-alive.
        const requestPaths = ctx.panel.requests.map((request) => request.path);
        const pollsBeforeKeepAlive = requestPaths.slice(0, requestPaths.indexOf('/keep_alive.html')).filter((path) => path === '/statuslive.html').length;
        expect(pollsBeforeKeepAlive).toBeGreaterThanOrEqual(2);
        expect(pollsBeforeKeepAlive).toBeLessThanOrEqual(3);
        if (!failFirstKeepAlive) return expect(ctx.bridge.stderr).toBe('');

        await until(() => ctx.bridge.stderr.includes('Request failed with status code 500'), 'the keep-alive failure to be logged');
        const pollsBefore = polls(ctx.panel).length;
        await until(() => polls(ctx.panel).length > pollsBefore, 'another poll');
        expect(ctx.bridge.result).toBeNull();
        expect(ctx.bridge.stderr).not.toContain('Unhandled');
      });
    }, TEST_TIMEOUT);
  });

  describe('failures after startup', () => {
    const POLL_FAILURES = [
      { name: 'panel goes away', stderrIncludes: 'ECONNREFUSED', pollsReachingPanel: 0, panel: {}, breakPanel: (panel) => panel.stop() },
      { name: 'panel answers HTTP 500', stderrIncludes: 'Request failed with status code 500', pollsReachingPanel: 1, panel: {}, breakPanel: (panel) => panel.respondWith('/statuslive.html', { status: 500, headers: HTML, body: 'busy' }) },
      { name: 'session expires and the panel serves the login page', stderrIncludes: "Regex didn't match the value", pollsReachingPanel: 1, panel: { requireLogin: true }, breakPanel: (panel) => panel.expireSession() },
    ];

    it('KNOWN BUG KB-12: the first failed status poll is fatal (exit 1) and there is no re-login or retry', async () => {
      await runRows(POLL_FAILURES, async ({ stderrIncludes, pollsReachingPanel, panel: panelOptions, breakPanel }) => {
        const ctx = await launch({ panel: panelOptions });
        await untilListening(ctx);
        await breakPanel(ctx.panel);

        expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });

        expect(ctx.bridge.stderr).toContain(stderrIncludes);
        expect(ctx.panel.requestsTo('/default.html')).toHaveLength(1);
        expect(ctx.panel.requestsTo('/login_page.html')).toHaveLength(1);
        expect(polls(ctx.panel)).toHaveLength(pollsReachingPanel);
      });
    }, TEST_TIMEOUT);

    it('exits 1 when the MQTT connection drops after startup', async () => {
      const rows = [
        { name: 'the network connection is cut', proxy: true, drop: ({ proxy }) => proxy.dropConnections() },
        { name: 'the broker disconnects the session', drop: ({ broker }) => broker.kick(MQTT_CREDENTIALS.username) },
      ];

      await runRows(rows, async ({ proxy, drop }) => {
        const ctx = await launch({ proxy });
        await untilListening(ctx);

        await drop(ctx);

        expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });
      });
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-7: the pre-connect error handler is still attached, so a late MQTT error is logged by it before the exit handler ends the process', async () => {
      const ctx = await launch({ proxy: true });
      await untilListening(ctx);
      expect(ctx.bridge.stderr).toBe('');

      // A real broker never sends a second CONNACK, so the proxy plays one.
      ctx.proxy.inject(FORGED_CONNACK_BAD_CREDENTIALS);

      expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });
      expect(ctx.bridge.stderr).toContain('Connection refused: Bad username or password');
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-13: a panel that stops answering is never given up on: polls pile up unanswered and the process neither fails nor exits', async () => {
      const ctx = await launch();
      await untilListening(ctx);
      ctx.panel.respondWith('/statuslive.html', { hang: true });

      await until(() => polls(ctx.panel).length === 2, 'two overlapping polls');

      expect(ctx.bridge.result).toBeNull();
      expect(ctx.bridge.stderr).toBe('');
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-38: SIGTERM stops the pollers but does not complete while a REST request is stuck on a hung panel', async () => {
      const ctx = await launch();
      await untilListening(ctx);
      ctx.panel.respondWith('/statuslive.html', { hang: true });
      // Signalled just before the 3 s keep-alive and third poll are due, so a worker that kept running would show up.
      await until(() => polls(ctx.panel).length === 2, 'the second poll');
      const stuck = http.get({ host: '127.0.0.1', port: ctx.port, path: '/status', agent: false });
      stuck.on('error', () => {});
      onCleanup(() => stuck.destroy());
      await until(() => ctx.panel.requestsTo('/statuslive.html').length === 3, 'the REST request to reach the panel');

      const requestsAtSignal = ctx.panel.requests.length;
      ctx.bridge.kill('SIGTERM');
      await until(() => ctx.bridge.stdout.includes('Process received a SIGTERM signal'), 'the signal to be handled');
      await settle(1500);

      expect(ctx.bridge.result).toBeNull();
      expect(ctx.panel.requests).toHaveLength(requestsAtSignal);
    }, TEST_TIMEOUT);
  });

  describe('shutdown', () => {
    it('KNOWN BUG KB-3: SIGTERM ends the process with exit code 143 but never logs out of the panel', async () => {
      const ctx = await launch();
      await untilListening(ctx);
      expect(ctx.panel.requestsTo('/logout.html')).toHaveLength(1);

      ctx.bridge.kill('SIGTERM');

      expect(await ctx.bridge.waitForExit()).toEqual({ code: 143, signal: null });
      expect(ctx.bridge.stdout).toContain('Process received a SIGTERM signal');
      expect(ctx.panel.requestsTo('/logout.html')).toHaveLength(1);
    }, TEST_TIMEOUT);

    it('exits with 128 plus the signal number on SIGHUP (129) and SIGINT (130)', async () => {
      const rows = [
        { name: 'SIGHUP', signal: 'SIGHUP', code: 129 },
        { name: 'SIGINT', signal: 'SIGINT', code: 130 },
      ];

      await runRows(rows, async ({ signal, code }) => {
        const ctx = await launch();
        await untilListening(ctx);

        ctx.bridge.kill(signal);

        expect(await ctx.bridge.waitForExit()).toEqual({ code, signal: null });
        expect(ctx.bridge.stdout).toContain(`Process received a ${signal} signal`);
      });
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-38: repeated SIGTERM, SIGINT and SIGHUP do not end a shutdown that waits for a stuck request, only SIGKILL does', async () => {
      const ctx = await launch();
      await untilListening(ctx);
      ctx.panel.respondWith('/statuslive.html', { hang: true });
      const stuck = http.get({ host: '127.0.0.1', port: ctx.port, path: '/status', agent: false });
      stuck.on('error', () => {});
      onCleanup(() => stuck.destroy());
      await until(() => ctx.panel.requestsTo('/statuslive.html').length >= 1, 'the REST request to reach the panel');

      ctx.bridge.kill('SIGTERM');
      await until(() => ctx.bridge.stdout.includes('Process received a SIGTERM signal'), 'the first signal to be handled');
      ctx.bridge.kill('SIGINT');
      ctx.bridge.kill('SIGHUP');
      ctx.bridge.kill('SIGTERM');
      await until(
        () => ['SIGINT', 'SIGHUP'].every((signal) => ctx.bridge.stdout.includes(`Process received a ${signal} signal`))
          && ctx.bridge.stdout.split('Process received a SIGTERM signal').length === 3,
        'the repeated signals to be handled',
      );
      await settle(1000);

      expect(ctx.bridge.result).toBeNull();
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-38: an idle keep-alive HTTP client delays the SIGTERM exit until its connection closes (Node < 19: the 5 s server keep-alive timeout)', async () => {
      const ctx = await launch();
      await untilListening(ctx);
      const agent = new http.Agent({ keepAlive: true });
      onCleanup(() => agent.destroy());
      expect((await rest(ctx, 'GET', '/status', { agent })).status).toBe(200);

      const signalledAt = performance.now();
      ctx.bridge.kill('SIGTERM');

      expect(await ctx.bridge.waitForExit(20000)).toEqual({ code: 143, signal: null });
      // Node >= 19 closes idle connections in server.close(); older versions wait for the socket to time out.
      if (NODE_MAJOR >= 19) expect(ctx.bridge.exitedAt - signalledAt).toBeLessThan(2500);
      else expect(ctx.bridge.exitedAt - signalledAt).toBeGreaterThanOrEqual(2500);
    }, TEST_TIMEOUT);
  });

  describe('logging', () => {
    // Row "long username and password" of spec/crypto.json, so the panel accepts the login without the test hashing anything.
    const login = {
      session: 'A86572A01074210A',
      username: 'administrator-account-01',
      password: 'correct horse battery staple 42',
      u: '190B865D5E772853950CC680FD3CE2C420CDA7109E08B014',
      p: '86DEC7C0F4E24C250E6C0A1B9B45B404',
    };
    const mqtt = { username: 'mqtt-admin-account', password: 'mqtt-secret-horse' };
    const panelAccepting = { sessionValue: login.session, credentials: { [login.session]: { u: login.u, p: login.p } } };
    const FAILURES = [
      {
        name: 'the panel rejects the login',
        panel: { ...panelAccepting, credentials: {} },
        check: (ctx) => expectLoginFailure(ctx, ['Session value not found in login page']),
      },
      {
        name: 'the login request itself fails with HTTP 500',
        panel: panelAccepting,
        arrange: (ctx) => ctx.panel.respondWith('/default.html', { status: 500, headers: HTML, body: 'busy' }),
        check: (ctx) => expectLoginFailure(ctx, ['Request failed with status code 500']),
      },
      {
        name: 'the MQTT broker rejects the credentials',
        panel: panelAccepting,
        brokerUser: { username: mqtt.username, password: 'something-else' },
        check: (ctx) => expectStartupFailure(ctx, [NOT_AUTHORIZED]),
      },
      {
        name: 'a status poll fails after startup',
        panel: panelAccepting,
        arrange: (ctx) => ctx.panel.respondWith('/statuslive.html', { status: 500, headers: HTML, body: 'busy' }),
        check: async (ctx) => {
          expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });
          expect(ctx.bridge.stderr).toContain('Request failed with status code 500');
        },
      },
    ];

    it('never writes the panel or MQTT credentials to stdout or stderr, however it fails', async () => {
      await runRows(FAILURES, async ({ panel, brokerUser = mqtt, arrange, check }) => {
        const ctx = await launch({
          panel,
          brokerUser,
          env: { USERNAME: login.username, PASSWORD: login.password, MQTT_USERNAME: mqtt.username, MQTT_PASSWORD: mqtt.password },
        });
        if (arrange) arrange(ctx);

        await check(ctx);

        const output = ctx.bridge.stdout + ctx.bridge.stderr;
        for (const secret of [login.username, login.password, mqtt.username, mqtt.password]) expect(output).not.toContain(secret);
      });
    }, TEST_TIMEOUT);
  });
});
