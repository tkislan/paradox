import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, vi } from 'vitest';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

// PARADOX_BUILD_DIR points the suite at a mutated copy of the build (see README, "Mutation checks").
export const BUILD_DIR = process.env.PARADOX_BUILD_DIR
  ? path.resolve(process.env.PARADOX_BUILD_DIR)
  : path.join(TESTS_DIR, '..', 'src');

const nodeRequire = createRequire(import.meta.url);

// Captured before any test installs fake timers; the harness itself must keep real time.
const realSetTimeout = globalThis.setTimeout;

export const DEFAULT_ENV = {
  HOSTNAME: '127.0.0.1:1',
  USERNAME: 'testuser',
  PASSWORD: 'testpass',
  PORT: '0',
  MQTT_HOSTNAME: '127.0.0.1',
  MQTT_PORT: '1',
  MQTT_USERNAME: 'mqttuser',
  MQTT_PASSWORD: 'mqttpass',
};

/** Test title of a spec row; rows that pin a bug are announced as "KNOWN BUG KB-n: <name>". */
export const rowTitle = (row) => `${row.known_bug ? `KNOWN BUG ${row.known_bug}: ` : ''}${row.name ?? row.operation}`;

/** Spec rows -> [title, row] tuples (use with the '%s' name format). */
export const cases = (rows) => rows.map((row) => [rowTitle(row), row]);

/** Spec rows -> it.each rows that carry a `title` (use with the '$title' name format). */
export const withTitle = (rows) => rows.map((row) => ({ ...row, title: rowTitle(row) }));

/** Text of a spec field that is either an inline string or {"file": "<path relative to tests/>"}. */
export const specText = (content) => (typeof content === 'string' ? content : fs.readFileSync(path.join(TESTS_DIR, content.file), 'utf8'));

/** Parses tests/spec/<name>.json: the language-neutral case tables shared with a future Python suite. */
export function loadSpec(name) {
  return JSON.parse(fs.readFileSync(path.join(TESTS_DIR, 'spec', `${name}.json`), 'utf8'));
}

/** Parses tests/spec/known_bugs/<name>.json: the rows of <name>.json that pin a defect, which a port need not reproduce. */
export function loadKnownBugSpec(name) {
  return loadSpec(`known_bugs/${name}`);
}

const cleanups = [];

/** Registers a function to run (LIFO, awaited) after the current test. */
export function onCleanup(fn) {
  cleanups.push(fn);
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function clearBuildCache() {
  for (const file of Object.keys(nodeRequire.cache)) {
    if (file.startsWith(BUILD_DIR)) delete nodeRequire.cache[file];
  }
}

/**
 * Sets process.env for the bridge for the duration of the test. config.js reads the environment once
 * at require time, so set this BEFORE loading any module. A value of `undefined` unsets the variable.
 * Returns the effective env.
 */
export function setBridgeEnv(overrides = {}) {
  const env = { ...DEFAULT_ENV, ...overrides };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    onCleanup(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  return env;
}

/**
 * Loads modules of the built bridge (the Babel output of src/) from an empty module cache, so each
 * test sees fresh module state and a fresh config.js. Modules loaded through the same `loadBridge`
 * result share instances; call `loadBridge` again for a clean slate.
 *
 *   const { load } = loadBridge();
 *   const { getStatus } = load('api/status.js');
 */
export function loadBridge() {
  clearBuildCache();
  onCleanup(clearBuildCache);
  return { load: (relativePath) => nodeRequire(path.join(BUILD_DIR, relativePath)) };
}

/** Silences and records console output of the code under test. Returns { log, warn, error } call lists. */
export function captureConsole() {
  const calls = { log: [], warn: [], error: [] };
  for (const level of Object.keys(calls)) {
    vi.spyOn(console, level).mockImplementation((...args) => { calls[level].push(args); });
  }
  return calls;
}

/**
 * Replaces process.exit with a recorder. The real one never returns, but code under test is fine
 * continuing past it, and throwing would turn every exit path into an unhandled rejection.
 * Returns the vitest spy; exit codes are `spy.mock.calls.map(([code]) => code)`.
 */
export function spyProcessExit() {
  return vi.spyOn(process, 'exit').mockImplementation(() => undefined);
}

/** Removes listeners the code under test adds to `process`, so signal handlers do not leak between tests. */
export function isolateProcessListeners(events = ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  for (const event of events) {
    const before = process.listeners(event);
    onCleanup(() => {
      for (const listener of process.listeners(event)) {
        if (!before.includes(listener)) process.removeListener(event, listener);
      }
    });
  }
}

/**
 * Fakes setTimeout/setInterval/Date but NOT setImmediate or nextTick, so real loopback sockets
 * (fake panel, fake broker) keep working while the bridge's 1 s / 3 s / 5 s timers are driven by hand.
 */
export function useFakeClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  onCleanup(() => vi.useRealTimers());
  return {
    /** Advances fake time, running due timers and their promise continuations. Does not wait for network I/O. */
    advance: (ms) => vi.advanceTimersByTimeAsync(ms),
  };
}

/** Real-time pause, immune to fake timers. Use to let loopback I/O settle before a "nothing happened" assertion. */
export function settle(ms = 30) {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

/** Polls `condition` in real time until it returns truthy; throws after `timeout` ms. Returns the truthy value. */
export async function waitFor(condition, { timeout = 3000, interval = 5, message = 'condition' } = {}) {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => realSetTimeout(resolve, interval));
  }
}

const PORT_CLAIMS_DIR = path.join(os.tmpdir(), 'paradox-bridge-test-ports');

/**
 * A free loopback port that no other reservePort() caller, in this or a parallel test process, gets
 * until the test ends. Needed wherever the bridge must be told a port before it binds it: a port freed
 * by closing a probe server is taken again by anything else listening on port 0 or dialing out. So the
 * range is below the OS's ephemeral one, and each port is claimed with an atomic mkdir.
 */
export async function reservePort() {
  fs.mkdirSync(PORT_CLAIMS_DIR, { recursive: true });
  for (;;) {
    const port = 1500 + Math.floor(Math.random() * 8000);
    const claim = path.join(PORT_CLAIMS_DIR, String(port));
    try {
      fs.mkdirSync(claim);
    } catch {
      continue;
    }
    onCleanup(() => fs.rmdirSync(claim));
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
}
