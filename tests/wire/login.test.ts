import { describe, expect, it } from 'vitest';
import { withTitle } from '../support.ts';
import {
  FLOW_PATHS, SAMPLE_ZONES, crypto, expectHeaders, expectRequestCounts, golden, outcomeOf, runHangScenario,
  runIndexRetryScenario, runLoginScenario, spec, startBridge, vector, warnings,
} from '../helpers/login.ts';
import { expectNoCredentials, expectTimeout } from '../helpers/outcomes.ts';

describe('login()', () => {
  it('logs in with the encrypted credentials and returns every zone slot', async () => {
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

  it('fails with a SyntaxError when entries of the zone list have no comma between them', async () => {
    const { login } = await startBridge({
      responses: { '/index.html': { body: '<html><script>tbl_zone = new Array(1,"A"1,"B");</script></html>' } },
    });

    const outcome = await outcomeOf(login());

    expect(outcome.error?.name).toBe('SyntaxError');
  });

  it('a zone with a two-digit flag is returned along with the others', async () => {
    const { login } = await startBridge({
      responses: { '/index.html': { body: '<html><script>tbl_zone = new Array(16,"Area five",1,"One");</script></html>' } },
    });

    const outcome = await outcomeOf(login());

    expect(outcome).toEqual({ value: { zoneTuples: [[16, 'Area five'], [1, 'One']] } });
  });

  it('rejects a wrong password and leaves no session', async () => {
    // What a real panel answers to wrong credentials was not captured (README), so its error message is not checked here.
    const { panel, login } = await startBridge({ env: { PASSWORD: 'not the password' } });

    const outcome = await outcomeOf(login());

    expect(outcome).toEqual({ error: expect.any(Error) });
    expect(panel.loggedIn).toBe(false);
    expectRequestCounts(panel, { '/logout.html': 1, '/login_page.html': 1, '/default.html': 1, '/index.html': 0 });
  });

  it('logs the panel session out when the login fails after the credentials were accepted', async () => {
    const { panel, login } = await startBridge({
      responses: { '/index.html': { body: '<html><head></head><body>nothing here</body></html>' } },
    });

    const outcome = await outcomeOf(login());

    expect(outcome.error?.message).toBe("Regex didn't match the value");
    expect(panel.loggedIn).toBe(false);
    expect(panel.requestLines.map((line) => line.split('?')[0])).toEqual([
      'GET /logout.html', 'GET /login_page.html', 'GET /default.html', 'GET /index.html', 'GET /logout.html',
    ]);
  });

  it.each([
    ['HTTP 500', { status: 500 }, 'Request failed with status code 500'],
    ['a reset connection', { destroy: true }, 'socket hang up'],
  ])('a default.html request failing with %s rejects with its message and without the hashed credentials', async (_what, response, message) => {
    const { login } = await startBridge({ responses: { '/default.html': response } });

    const outcome = await outcomeOf(login());

    expect(outcome.error?.message).toBe(message);
    expectNoCredentials(outcome.error, golden);
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

describe('login() index page retry', () => {
  it.each(withTitle(spec.index_retry))('$title', runIndexRetryScenario);
});

describe('login() against a panel that stops answering', () => {
  it.each(withTitle(spec.hangs))('$title', runHangScenario);
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

  it('rejects 10000 ms after the call when the panel never answers', async () => {
    const { panel, logout } = await startBridge();

    await expectTimeout(panel, '/logout.html', logout);
  });
});
