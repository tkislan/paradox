import { describe, expect, it } from 'vitest';
import { loadKnownBugSpec, settle, useFakeClock, waitFor, withTitle } from '../support.ts';
import {
  FLOW_PATHS, expectRequestCounts, expectScenario, outcomeOf, runLoginScenario, startBridge,
} from '../helpers/login.ts';

const spec = loadKnownBugSpec('login_cases');

describe('login()', () => {
  it.each(withTitle(spec.login))('$title', runLoginScenario);

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
