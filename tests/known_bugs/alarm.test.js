import { describe, expect, it } from 'vitest';
import { DISARMED } from '../mock_paradox.js';
import { loadKnownBugSpec, settle, useFakeClock, waitFor, withTitle } from '../support.js';
import { rejection, track } from '../helpers/outcomes.js';
import { html } from '../helpers/responses.js';
import { COMMANDS, expectRequestAsSent, expectResponseHandled, requestRows, startBridge } from '../helpers/alarm.js';

const spec = loadKnownBugSpec('status_pages');

describe('requests as sent', () => {
  it.each(withTitle(requestRows(spec.requests, 'arm', 'disarm')))('$title sends exactly $request, with only the HTTP client default headers', expectRequestAsSent);
});

describe.each(COMMANDS)('%s() outcome', (command) => {
  it.each(withTitle(spec.body_ignoring_responses))('$title', (row) => expectResponseHandled(command, row));

  it('KNOWN BUG KB-14: after the session expired it reports success although the panel did nothing', async () => {
    const api = await startBridge({ requireLogin: true, useraccess: [DISARMED, 0] });
    expect(api.panel.loggedIn).toBe(false);

    await expect(api[command]()).resolves.toBeUndefined();

    expect(api.panel.useraccess).toEqual([DISARMED, 0]);
    expect(api.panel.requestsTo('/statuslive.html')).toHaveLength(1);
  });

  it.each([
    ['to a page that answers 200', '/login_page.html', null],
    ['to a missing page', '/nowhere.html', 'Request failed with status code 404'],
  ])('KNOWN BUG KB-14: follows a redirect %s and lets the final response decide', async (_, location, error) => {
    const api = await startBridge();
    api.panel.respondWith('/statuslive.html', html('', 302, { Location: location }), { times: 1 });

    if (error) {
      expect((await rejection(api[command]())).message).toBe(error);
    } else {
      await expect(api[command]()).resolves.toBeUndefined();
    }

    expect(api.panel.requestLines).toHaveLength(2);
    expect(api.panel.requestLines[1]).toBe(`GET ${location}`);
  });

  it('KNOWN BUG KB-13: waits forever for a panel that never answers', async () => {
    const api = await startBridge();
    api.panel.respondWith('/statuslive.html', { hang: true });
    const clock = useFakeClock();
    const call = track(api[command]());
    await waitFor(() => api.panel.requestsTo('/statuslive.html').length === 1, { message: 'the request to reach the panel' });

    await clock.advance(10 * 60 * 1000);
    await settle(100);

    expect(call.state).toBe('pending');
    await api.panel.stop();
    await waitFor(() => call.state === 'rejected', { message: 'the call to end once the connection drops' });
  });
});
