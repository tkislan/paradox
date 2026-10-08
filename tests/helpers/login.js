import { expect } from 'vitest';
import { FakePanel, renderIndexPage } from '../mock_paradox.js';
import { captureConsole, loadBridge, loadSpec, setBridgeEnv, specText } from '../support.js';

export const crypto = loadSpec('crypto');

export const spec = loadSpec('login_cases');

export const vector = (name) => crypto.credentials.find((c) => c.name === name);

export const golden = vector('sample session, 4 digit code');

export const SAMPLE_ZONES = [[1, 'Predsien'], [1, 'Lava izba'], [1, 'Prava izba'], [1, 'Spalna'], [1, 'Obyvacka'], [1, 'Chodba']];

export const FLOW_PATHS = ['/logout.html', '/login_page.html', '/default.html', '/index.html'];

const ZONE_SLOTS = 32;

function pageBody(rule) {
  if (rule.file !== undefined) return specText(rule);
  if (rule.body !== undefined) return rule.body;
  if (rule.zones !== undefined) return renderIndexPage(rule.zones);
  if (rule.zones_by_slot !== undefined) {
    const zones = Array.from({ length: ZONE_SLOTS }, () => [0, ' ']);
    for (const [slot, zone] of Object.entries(rule.zones_by_slot)) zones[Number(slot)] = zone;
    return renderIndexPage(zones);
  }
  return '';
}

function toResponse(rule) {
  if (rule.destroy) return { destroy: true };
  if (rule.hang) return { hang: true };
  return { status: rule.status ?? 200, headers: { 'Content-Type': 'text/html', ...rule.headers }, body: pageBody(rule) };
}

function applyResponses(panel, responses) {
  for (const [pathname, rules] of Object.entries(responses)) {
    for (const rule of [].concat(rules)) panel.respondWith(pathname, toResponse(rule), { times: rule.times });
  }
}

export async function startBridge({ responses = {}, panelOptions = {}, env = {} } = {}) {
  const output = captureConsole();
  const panel = await new FakePanel({
    sessionValue: golden.session,
    credentials: { [golden.session]: { u: golden.u, p: golden.p } },
    ...panelOptions,
  }).start();
  setBridgeEnv({ HOSTNAME: panel.hostname, USERNAME: golden.username, PASSWORD: golden.password, ...env });
  applyResponses(panel, responses);
  return { panel, output, ...loadBridge().load('api/login.js') };
}

export const outcomeOf = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

export const warnings = (output) => output.warn.map((args) => args.join(' '));

function expectedCounts(row) {
  const counts = row.expected.request_counts ?? Object.fromEntries(FLOW_PATHS.map((p) => [p, 1]));
  const paths = new Set([...FLOW_PATHS, ...Object.keys(counts)]);
  return Object.fromEntries([...paths].map((p) => [p, counts[p] ?? 0]));
}

export function expectRequestCounts(panel, counts) {
  const actual = Object.fromEntries(Object.keys(counts).map((p) => [p, panel.requestsTo(p).length]));
  expect(actual).toEqual(counts);
  expect(panel.requests).toHaveLength(Object.values(counts).reduce((sum, n) => sum + n, 0));
}

export async function expectScenario(row, { panel, output, login }) {
  const outcome = await outcomeOf(login());

  if (row.expected.error !== undefined) {
    expect(outcome.value).toBeUndefined();
    expect(outcome.error?.message).toBe(row.expected.error);
  } else {
    expect(outcome).toEqual({ value: { zoneTuples: row.expected.zoneTuples } });
  }
  expect(warnings(output)).toEqual(row.expected.warnings ?? []);
  expectRequestCounts(panel, expectedCounts(row));
  if (row.expected.default_query !== undefined) {
    expect(panel.requestsTo('/default.html')[0].url).toBe(`/default.html?${row.expected.default_query}`);
  }
}

export function expectHeaders(panel, row) {
  const [request] = panel.requestsTo(row.path);
  const expected = Object.fromEntries(
    Object.entries(row.headers).map(([name, value]) => [name.toLowerCase(), value.replaceAll('{hostname}', panel.hostname)]),
  );

  if (row.complete) expect(request.headers).toEqual(expected);
  else expect(request.headers).toMatchObject(expected);
  for (const [name, prefix] of Object.entries(row.headers_starting_with ?? {})) {
    expect(String(request.headers[name.toLowerCase()]).slice(0, prefix.length)).toBe(prefix);
  }
  for (const name of row.absent ?? []) expect(request.headers).not.toHaveProperty(name.toLowerCase());
}
