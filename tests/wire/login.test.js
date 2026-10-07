import { describe, expect, it } from 'vitest';
import { FakePanel, renderIndexPage } from '../mock_paradox.js';
import {
  captureConsole, loadBridge, loadSpec, setBridgeEnv, settle, specText, useFakeClock, waitFor, withTitle,
} from '../support.js';

const crypto = loadSpec('crypto');
const spec = loadSpec('login_cases');

const vector = (name) => crypto.credentials.find((c) => c.name === name);
const golden = vector('sample session, 4 digit code');
const SAMPLE_ZONES = [[1, 'Predsien'], [1, 'Lava izba'], [1, 'Prava izba'], [1, 'Spalna'], [1, 'Obyvacka'], [1, 'Chodba']];
const FLOW_PATHS = ['/logout.html', '/login_page.html', '/default.html', '/index.html'];
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

async function startBridge({ responses = {}, panelOptions = {}, env = {} } = {}) {
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

const outcomeOf = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const warnings = (output) => output.warn.map((args) => args.join(' '));

function expectedCounts(row) {
  const counts = row.expected.request_counts ?? Object.fromEntries(FLOW_PATHS.map((p) => [p, 1]));
  const paths = new Set([...FLOW_PATHS, ...Object.keys(counts)]);
  return Object.fromEntries([...paths].map((p) => [p, counts[p] ?? 0]));
}

function expectRequestCounts(panel, counts) {
  const actual = Object.fromEntries(Object.keys(counts).map((p) => [p, panel.requestsTo(p).length]));
  expect(actual).toEqual(counts);
  expect(panel.requests).toHaveLength(Object.values(counts).reduce((sum, n) => sum + n, 0));
}

async function expectScenario(row, { panel, output, login }) {
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

function expectHeaders(panel, row) {
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

describe('login()', () => {
  it('logs in with the encrypted credentials and returns the enabled zones', async () => {
    const { panel, output, login } = await startBridge();

    const result = await login();

    expect(result).toEqual({ zoneTuples: SAMPLE_ZONES });
    expect(panel.requestLines).toEqual([
      'GET /logout.html',
      'GET /login_page.html',
      `GET /default.html?u=${golden.u}&p=${golden.p}`,
      'GET /index.html',
    ]);
    expect(panel.loggedIn).toBe(true);
    expect(warnings(output)).toEqual([]);
  });

  it.each(withTitle(spec.login))('$title', async (row) => {
    const bridge = await startBridge({ responses: row.panel });

    await expectScenario(row, bridge);
  });

  it('repeats the whole sequence, starting with a logout, on a second login', async () => {
    const { panel, login } = await startBridge();

    await login();
    await login();

    expect(panel.requestLines.map((line) => line.split('?')[0])).toEqual([
      'GET /logout.html', 'GET /login_page.html', 'GET /default.html', 'GET /index.html',
      'GET /logout.html', 'GET /login_page.html', 'GET /default.html', 'GET /index.html',
    ]);
    expect(panel.loggedIn).toBe(true);
  });

  it('derives the credentials from the session value of the login page it just fetched', async () => {
    const first = golden;
    const second = vector('playground session');
    const { panel, login } = await startBridge({
      panelOptions: {
        credentials: {
          [first.session]: { u: first.u, p: first.p },
          [second.session]: { u: second.u, p: second.p },
        },
      },
    });

    await login();
    panel.sessionValue = second.session;
    await login();

    expect(panel.requestsTo('/default.html').map((r) => r.url)).toEqual([
      `/default.html?u=${first.u}&p=${first.p}`,
      `/default.html?u=${second.u}&p=${second.p}`,
    ]);
    expect(panel.loggedIn).toBe(true);
  });

  it.each(crypto.credentials.filter((c) => c.session === golden.session))(
    'sends the credentials of USERNAME and PASSWORD: $name',
    async ({ username, password, u, p }) => {
      const { panel, login } = await startBridge({ env: { USERNAME: username, PASSWORD: password }, panelOptions: { credentials: { [golden.session]: { u, p } } } });

      await login();

      expect(panel.requestsTo('/default.html')[0].url).toBe(`/default.html?u=${u}&p=${p}`);
    },
  );

  it('KNOWN BUG KB-11: a wrong password is reported with the session value message and leaves no session', async () => {
    const { panel, login } = await startBridge({ env: { PASSWORD: 'not the password' } });

    const outcome = await outcomeOf(login());

    expect(outcome.error?.message).toBe('Session value not found in login page');
    expect(panel.loggedIn).toBe(false);
    expectRequestCounts(panel, { '/logout.html': 1, '/login_page.html': 1, '/default.html': 1, '/index.html': 0 });
  });

  it('KNOWN BUG KB-3: a login that fails after the credentials were accepted leaves the panel session open', async () => {
    const { panel, login } = await startBridge({
      responses: { '/index.html': { zones: [[1, 'Obývačka']] } },
    });

    const outcome = await outcomeOf(login());

    expect(outcome.error?.message).toBe("Regex didn't match the value");
    expect(panel.loggedIn).toBe(true);
    expect(panel.requestsTo('/logout.html')).toHaveLength(1);
  });

  it('does two independent login sequences when called concurrently', async () => {
    const { panel, login } = await startBridge();

    const results = await Promise.all([login(), login()]);

    expect(results).toEqual([{ zoneTuples: SAMPLE_ZONES }, { zoneTuples: SAMPLE_ZONES }]);
    expectRequestCounts(panel, Object.fromEntries(FLOW_PATHS.map((p) => [p, 2])));
  });

  it('rejects with the connection error when the panel is down, after a warning for the logout', async () => {
    const { panel, output, login } = await startBridge();
    await panel.stop();

    const outcome = await outcomeOf(login());

    expect(outcome.error?.code).toBe('ECONNREFUSED');
    expect(outcome.error?.message).toContain('ECONNREFUSED');
    expect(warnings(output)).toEqual(['Logout before login failed']);
  });

  it('KNOWN BUG KB-39: entries of the zone list without a comma between them reach the interpreter and fail with its SyntaxError', async () => {
    const { login } = await startBridge({
      responses: { '/index.html': { body: '<html><script>tbl_zone = new Array(1,"A"1,"B");</script></html>' } },
    });

    const outcome = await outcomeOf(login());

    expect(outcome.error?.name).toBe('SyntaxError');
  });
});

describe('login() index page retry', () => {
  it.each(withTitle(spec.index_retry))('$title', async (row) => {
    useFakeClock();
    const bridge = await startBridge({ responses: row.panel });

    await expectScenario(row, bridge);
  });
});

describe('login() request headers', () => {
  it.each(spec.request_headers)('$name', async (row) => {
    const { panel, login } = await startBridge();

    await login();

    expectHeaders(panel, row);
  });
});

describe('login() against a panel that stops answering', () => {
  it.each(withTitle(spec.hangs))('$title', async (row) => {
    const { panel, login } = await startBridge({ responses: { [row.hang]: { hang: true } } });
    let state = 'pending';
    const settled = login().then(() => { state = 'resolved'; }, () => { state = 'rejected'; });

    await waitFor(() => panel.requestsTo(row.hang).length === 1, { message: `a request to ${row.hang}` });
    await settle(100);

    expect(state).toBe('pending');
    expectRequestCounts(panel, Object.fromEntries(FLOW_PATHS.map((p) => [p, row.expected.request_counts[p] ?? 0])));

    await panel.stop();
    await settled;
    expect(state).toBe('rejected');
  });
});

describe('logout()', () => {
  it.each(spec.logout)('$name', async (row) => {
    const { panel, logout } = await startBridge({ responses: row.panel });

    const outcome = await outcomeOf(logout());

    if (row.expected.error === undefined) expect(outcome).toEqual({ value: undefined });
    else expect(outcome.error?.message).toBe(row.expected.error);
    expect(panel.requestLines).toEqual(['GET /logout.html']);
  });

  it.each(spec.request_headers.filter((row) => row.path === '/logout.html'))('$name when called alone', async (row) => {
    const { panel, logout } = await startBridge();

    await logout();

    expectHeaders(panel, row);
  });

  it('logs the panel session out', async () => {
    const { panel, login, logout } = await startBridge();
    await login();

    await logout();

    expect(panel.loggedIn).toBe(false);
  });

  it('rejects with the connection error when the panel is down', async () => {
    const { panel, logout } = await startBridge();
    await panel.stop();

    const outcome = await outcomeOf(logout());

    expect(outcome.error?.code).toBe('ECONNREFUSED');
  });
});
