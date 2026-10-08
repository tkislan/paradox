import { describe, expect, it } from 'vitest';
import { withTitle } from '../support.js';
import {
  FLOW_PATHS, SAMPLE_ZONES, crypto, expectHeaders, expectRequestCounts, golden, outcomeOf, runLoginScenario, spec,
  startBridge, vector, warnings,
} from '../helpers/login.js';

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

  it.each(withTitle(spec.login))('$title', runLoginScenario);

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
});

describe('login() request headers', () => {
  it.each(spec.request_headers)('$name', async (row) => {
    const { panel, login } = await startBridge();

    await login();

    expectHeaders(panel, row);
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
