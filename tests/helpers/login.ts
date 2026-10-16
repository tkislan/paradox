import { createRequire } from 'node:module';
import { expect, vi } from 'vitest';
import { FakePanel, type FakePanelOptions, type PanelResult, renderIndexPage, type Zone } from '../mock_paradox.ts';
import { captureConsole, loadSpec, setBridgeEnv, settle, specText, useFakeClock, waitFor } from '../support.ts';
import { CryptoSpec, LoginCasesSpec, type ResponseRule } from '../spec/schemas.ts';

const require = createRequire(import.meta.url);

export const crypto = loadSpec('crypto', CryptoSpec);

export const spec = loadSpec('login_cases', LoginCasesSpec);

export function vector(name: string) {
  const credentials = crypto.credentials.find((c) => c.name === name);
  if (!credentials) throw new Error(`spec/crypto.json has no credentials named ${name}`);
  return credentials;
}

export const golden = vector('sample session, 4 digit code');

export const SAMPLE_ZONES: Zone[] = [
  [1, 'Predsien'], [1, 'Lava izba'], [1, 'Prava izba'], [1, 'Spalna'], [1, 'Obyvacka'], [1, 'Chodba'],
  ...Array<Zone>(26).fill([0, ' ']),
];

export const FLOW_PATHS = ['/logout.html', '/login_page.html', '/default.html', '/index.html'];

const ZONE_SLOTS = 32;

function pageBody(rule: ResponseRule) {
  if (rule.file !== undefined) return specText({ file: rule.file });
  if (rule.body !== undefined) return rule.body;
  if (rule.zones !== undefined) return renderIndexPage(rule.zones);
  if (rule.zones_by_slot !== undefined) {
    const zones = Array.from({ length: ZONE_SLOTS }, (): Zone => [0, ' ']);
    for (const [slot, zone] of Object.entries(rule.zones_by_slot)) zones[Number(slot)] = zone;
    return renderIndexPage(zones);
  }
  return '';
}

function toResponse(rule: ResponseRule): PanelResult {
  if (rule.destroy) return { destroy: true };
  if (rule.hang) return { hang: true };
  return { status: rule.status ?? 200, headers: { 'Content-Type': 'text/html', ...rule.headers }, body: pageBody(rule) };
}

function applyResponses(panel: FakePanel, responses: Record<string, ResponseRule | ResponseRule[]>) {
  for (const [pathname, rules] of Object.entries(responses)) {
    for (const rule of [rules].flat()) panel.respondWith(pathname, toResponse(rule), { times: rule.times });
  }
}

export async function startBridge({ responses = {}, panelOptions = {}, env = {} }: {
  responses?: Record<string, ResponseRule | ResponseRule[]>;
  panelOptions?: FakePanelOptions;
  env?: Record<string, string | undefined>;
} = {}) {
  const output = captureConsole();
  const panel = await new FakePanel({
    sessionValue: golden.session,
    credentials: { [golden.session]: { u: golden.u, p: golden.p } },
    ...panelOptions,
  }).start();
  setBridgeEnv({ HOSTNAME: panel.hostname, USERNAME: golden.username, PASSWORD: golden.password, ...env });
  applyResponses(panel, responses);
  return { panel, output, ...require('../../src/api/login.js') };
}

export const outcomeOf = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

export const warnings = (output) => output.warn.map((args) => args.join(' '));

function expectedCounts(row) {
  const counts = row.expected.request_counts ?? Object.fromEntries(FLOW_PATHS.map((p) => [p, 1]));
  const paths = new Set([...FLOW_PATHS, ...Object.keys(counts)]);
  return Object.fromEntries([...paths].map((p) => [p, counts[p] ?? 0]));
}

export function expectRequestCounts(panel, counts: Record<string, number>) {
  const actual = Object.fromEntries(Object.keys(counts).map((p) => [p, panel.requestsTo(p).length]));
  expect(actual).toEqual(counts);
  expect(panel.requests).toHaveLength(Object.values(counts).reduce((sum, n) => sum + n, 0));
}

export async function runLoginScenario(row) {
  const bridge = await startBridge({ responses: row.panel });

  await expectScenario(row, bridge, await outcomeOf(bridge.login()));
}

/**
 * Plays an index_retry row on the fake clock: before each further /index.html attempt the clock stops 1 ms short of its
 * time in expected.index_at_ms, where no new request may have come, then moves on to it.
 */
export async function runIndexRetryScenario(row) {
  const clock = useFakeClock();
  const bridge = await startBridge({ responses: row.panel });
  let outcome;
  outcomeOf(bridge.login()).then((settled) => { outcome = settled; });
  const times = row.expected.index_at_ms;
  const attempts = () => bridge.panel.requestsTo('/index.html').length;

  await waitFor(() => attempts() >= 1, { message: 'the first index page request' });
  for (let attempt = 1; attempt < times.length; attempt += 1) {
    // Moving the clock before the failed attempt has started its wait would skip past the wait unnoticed.
    await waitFor(() => vi.getTimerCount() > 0, { message: `the wait before index page request ${attempt + 1}` });
    await clock.advance(times[attempt] - times[attempt - 1] - 1);
    await settle();
    expect(attempts()).toBe(attempt);
    await clock.advance(1);
    await waitFor(() => attempts() > attempt, { message: `index page request ${attempt + 1}` });
  }
  await waitFor(() => outcome, { message: 'login() to settle without another wait' });
  await expectScenario(row, bridge, outcome);
}

/**
 * Plays a hangs row on the fake clock: before each time in expected.requests and expected.settles_at_ms the clock stops
 * 1 ms short, where no new request may have come and login() may not have settled, then moves on to it.
 */
export async function runHangScenario(row) {
  const clock = useFakeClock();
  const bridge = await startBridge({ responses: row.panel });
  let outcome;
  outcomeOf(bridge.login()).then((settled) => { outcome = settled; });
  const { requests, settles_at_ms: settlesAt } = row.expected;
  const times = [...new Set([...requests.map(([at]) => at), settlesAt])].sort((a, b) => a - b);
  const arrivedBy = (time) => requests.filter(([at]) => at <= time).length;
  let now = 0;

  for (const time of times) {
    if (time > now) {
      await clock.advance(time - now - 1);
      await settle();
      expect(bridge.panel.requests).toHaveLength(arrivedBy(time - 1));
      expect(outcome).toBeUndefined();
      await clock.advance(1);
      now = time;
    }
    await waitFor(() => bridge.panel.requests.length >= arrivedBy(time), { message: `the requests due at ${time} ms` });
  }
  await waitFor(() => outcome, { message: `login() to settle at ${settlesAt} ms` });
  await settle();

  expectOutcome(row, bridge.output, outcome);
  expect(bridge.panel.requests.map((request) => request.path)).toEqual(requests.map(([, path]) => path));
}

function expectOutcome(row, output, outcome) {
  if (row.expected.error !== undefined) {
    expect(outcome.value).toBeUndefined();
    expect(outcome.error?.message).toBe(row.expected.error);
  } else {
    expect(outcome).toEqual({ value: { zoneTuples: row.expected.zoneTuples } });
  }
  expect(warnings(output)).toEqual(row.expected.warnings ?? []);
}

export async function expectScenario(row, { panel, output }, outcome) {
  expectOutcome(row, output, outcome);
  expectRequestCounts(panel, expectedCounts(row));
  if (row.expected.default_query !== undefined) {
    expect(panel.requestsTo('/default.html')[0].url).toBe(`/default.html?${row.expected.default_query}`);
  }
}

export function expectHeaders(panel, row) {
  const [request] = panel.requestsTo(row.path);
  const expected = Object.fromEntries(
    Object.entries<string>(row.headers).map(([name, value]) => [name.toLowerCase(), value.replaceAll('{hostname}', panel.hostname)]),
  );

  if (row.complete) expect(request.headers).toEqual(expected);
  else expect(request.headers).toMatchObject(expected);
  for (const [name, prefix] of Object.entries<string>(row.headers_starting_with ?? {})) {
    expect(String(request.headers[name.toLowerCase()]).slice(0, prefix.length)).toBe(prefix);
  }
  for (const name of row.absent ?? []) expect(request.headers).not.toHaveProperty(name.toLowerCase());
}
