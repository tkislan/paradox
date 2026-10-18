import { describe, expect, it } from 'vitest';
import { settle, waitFor, withTitle } from '../support.ts';
import { login, spec } from '../fixtures/app.ts';
import { createBridge, runScenario } from '../helpers/app.ts';
import { expectNoCredentials } from '../helpers/outcomes.ts';
import { drain, holdNextResponse } from '../helpers/panel_faults.ts';

describe('scenarios', () => {
  for (const [group, rows] of Object.entries(spec)) {
    if (!Array.isArray(rows)) continue;
    describe(group, () => {
      it.each(withTitle(rows))('$title', runScenario);
    });
  }
});

describe('slow panel during a new login', () => {
  it('no poll goes out while a slow panel holds up the new login, so the first poll after it gets the new session and the bridge stays up', async () => {
    const world = await createBridge();
    world.load();
    await world.awaitReady();
    const loginPage = holdNextResponse(world.panel, '/login_page.html');
    world.panel.expireSession();
    await world.clock.advance(1000);
    await waitFor(() => world.panel.requestsTo('/login_page.html').length === 2);
    const poll = holdNextResponse(world.panel, '/statuslive.html');
    await world.clock.advance(1000);
    await settle();
    expect(world.panel.requestsTo('/statuslive.html')).toHaveLength(1);

    loginPage.release();
    await waitFor(() => world.panel.requestsTo('/index.html').length === 2);
    await world.clock.advance(1000);
    await waitFor(() => world.panel.requestsTo('/statuslive.html').length === 2);
    poll.release();
    await waitFor(() => world.broker.published.length > 0 || world.exitCodes().length > 0);
    await world.broker.barrier();

    expect(world.exitCodes()).toEqual([]);
    expect(world.panel.loggedIn).toBe(true);
    expect(world.broker.published).toEqual([{ topic: 'paradox/status/armed', payload: 'OFF' }]);
  });
});

describe('logging', () => {
  it('a login request failing with HTTP 500 is logged without the hashed panel username and password', async () => {
    const world = await createBridge({ panel: { faults: [{ path: '/default.html', kind: 'http_500' }] } });

    world.load();
    await waitFor(() => world.exitCodes().length === 1, { message: 'the failed login to end the process' });

    // The session value is logged as well, and with it the two hashes would allow an offline guess of the short panel code.
    expect(world.logs.error.length).toBeGreaterThan(0);
    expectNoCredentials(world.logs, login);
  });
});

describe('shutdown', () => {
  it('a signal during a new login logs out at once, and again once that login has opened its session, and polls no more', async () => {
    const world = await createBridge();
    world.load();
    await world.awaitReady();
    const loginPage = holdNextResponse(world.panel, '/login_page.html');
    world.panel.expireSession();
    await world.clock.advance(1000);
    await waitFor(() => world.panel.requestsTo('/login_page.html').length === 2, { message: 'the new login to ask for the login page' });

    // A panel answering in order answers this logout only after the login page it was asked for earlier, and by then
    // the new login has sent its credentials.
    const shutdownLogout = holdNextResponse(world.panel, '/logout.html');
    world.terminate();
    await waitFor(() => world.panel.requestsTo('/logout.html').length >= 3, { message: 'the shutdown to log out' });
    loginPage.release();
    await waitFor(() => world.panel.requestsTo('/index.html').length === 2, { message: 'the new login to finish' });
    shutdownLogout.release();
    await waitFor(() => world.exitCodes().length > 0, { message: 'the shutdown to end the process' });

    const polls = world.panel.requestsTo('/statuslive.html').length;
    await world.clock.advance(3000);
    await drain();

    expect(world.exitCodes()).toEqual([143]);
    expect(world.panel.loggedIn).toBe(false);
    expect(world.panel.requestsTo('/statuslive.html')).toHaveLength(polls);
  });
});
