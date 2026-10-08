import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import { ARMED, DISARMED, FakePanel, renderStatusPage } from '../mock_paradox.js';
import { leaseBroker } from '../mosquitto.js';
import { BUILD_DIR, onCleanup, reservePort, waitFor } from '../support.js';
import { HTML, MQTT_CREDENTIALS, NOT_AUTHORIZED, golden, mqtt, panelAccepting } from '../fixtures/process.js';

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

export const NODE_MAJOR = Number(execFileSync(NODE, ['-p', 'process.versions.node.split(".")[0]'], { encoding: 'utf8' }));

const APP = path.join(BUILD_DIR, 'app.js');

const liveBridges = new Set();

class TimedPanel extends FakePanel {
  /** Stamps every request when the panel receives it, so timing assertions do not depend on how late the test polled. */
  handle(request) {
    request.at = performance.now();
    return super.handle(request);
  }
}

/** Like waitFor, but a timeout reports what every running bridge has printed, which is what explains it. */
export async function until(condition, message, timeout = 15000) {
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
export async function launch({ panel: panelOptions, brokerUser = MQTT_CREDENTIALS, proxy: proxyOption, broker: leased, env, cwd } = {}) {
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

export const untilListening = ({ bridge, port }) => until(() => bridge.stdout.includes(`Server listening on port ${port}`), 'the server to listen');

/** The command subscriptions are made before the first poll, but the broker log that shows them lags. */
export const untilSubscribed = ({ broker }) => until(() => broker.subscriptions.length === 2, 'both command subscriptions');

export const publishedMessages = ({ broker }) => broker.published.map((p) => `${p.topic} ${p.payload}`);

export const polls = (panel) => panel.requestsTo('/statuslive.html').filter((request) => !request.query.value);

/** Plain HTTP request with its own connection (Connection: close), so no idle socket outlives the call. */
export function request(target, method, urlPath, { agent = false } = {}) {
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
export function failCommands(panel, failing) {
  panel.respondWith('/statuslive.html', ({ query }) => {
    if (failing.includes(query.value)) return { status: 500, headers: HTML, body: 'busy' };
    if (query.value === 'r') panel.setStatus({ useraccess: [ARMED, 0] });
    if (query.value === 'd') panel.setStatus({ useraccess: [DISARMED, 0] });
    return { status: 200, headers: HTML, body: renderStatusPage(panel) };
  });
}

export const rest = (ctx, method, urlPath, options) => request({ host: '127.0.0.1', port: ctx.port }, method, urlPath, options);

/** Runs independent scenarios concurrently (each owns its bridge, panel and broker) and names every failing row. */
export async function runRows(rows, scenario) {
  const outcomes = await Promise.allSettled(rows.map((row) => scenario(row)));
  const failures = outcomes.flatMap((outcome, i) => (outcome.status === 'rejected' ? [`[${rows[i].name}] ${outcome.reason.message}`] : []));
  expect(failures).toEqual([]);
}

/** The bridge must exit 1 before it listens or polls the panel, after logging every text of `stderrIncludes`. */
export async function expectStartupFailure({ bridge, panel }, stderrIncludes, { timeout } = {}) {
  expect(await bridge.waitForExit(timeout)).toEqual({ code: 1, signal: null });
  for (const text of stderrIncludes) expect(bridge.stderr).toContain(text);
  expect(bridge.stdout).not.toContain('Server listening');
  expect(polls(panel)).toEqual([]);
}

/** Login runs before the MQTT connection is opened, so a failing login must leave the broker untouched. */
export async function expectLoginFailure(ctx, stderrIncludes) {
  await expectStartupFailure(ctx, stderrIncludes);
  await ctx.broker.syncLog();
  expect(ctx.broker.connects).toEqual([]);
}

export const POLL_FAILURES = [
  { name: 'panel goes away', stderrIncludes: 'ECONNREFUSED', pollsReachingPanel: 0, panel: {}, breakPanel: (panel) => panel.stop() },
  { name: 'panel answers HTTP 500', stderrIncludes: 'Request failed with status code 500', pollsReachingPanel: 1, panel: {}, breakPanel: (panel) => panel.respondWith('/statuslive.html', { status: 500, headers: HTML, body: 'busy' }) },
  { name: 'session expires and the panel serves the login page', stderrIncludes: "Regex didn't match the value", pollsReachingPanel: 1, panel: { requireLogin: true }, breakPanel: (panel) => panel.expireSession() },
];

export const FAILURES = [
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

// The bridge's TCP connections are the ones the proxy accepted; its CONNECT never reaches Mosquitto in either row.
export const CONNECT_TIMEOUT_ROWS = [
  { name: 'nothing listening', proxy: (proxy) => proxy.stop(), accepted: 0, sentConnect: false },
  { name: 'broker accepts TCP but never answers CONNECT', proxy: (proxy) => proxy.blackhole(), accepted: 1, sentConnect: true },
];

export const DROP_ROWS = [
  { name: 'the network connection is cut', proxy: true, drop: ({ proxy }) => proxy.dropConnections() },
  { name: 'the broker disconnects the session', drop: ({ broker }) => broker.kick(MQTT_CREDENTIALS.username) },
];
