import { describe, expect, it, vi } from 'vitest';
import { rejection, track } from '../helpers/outcomes.js';
import { html } from '../helpers/responses.js';
import { loadKnownBugSpec, settle, specText, useFakeClock, waitFor, withTitle } from '../support.js';
import {
  OPERATIONS, expectKeepAliveOutcome, expectParsedStatus, expectRequestAsSent, requestRows, startBridge,
} from '../helpers/status.js';

const spec = loadKnownBugSpec('status_pages');

describe('getStatus() page parsing', () => {
  it.each(withTitle(spec.get_status))('$title', expectParsedStatus);

  it.each([
    ['the login page', specText({ file: 'data/login_page.html' }), 'tbl_statuszone'],
    ['a page with only the zone table', 'tbl_statuszone = new Array(1,2);', 'tbl_useraccess'],
  ])('KNOWN BUG KB-36: a failed parse logs the whole page, then the pattern that did not match (%s)', async (_, page, failedTable) => {
    const { panel, logs, getStatus } = await startBridge();
    panel.respondWith('/statuslive.html', html(page));

    await rejection(getStatus());

    expect(logs.error).toHaveLength(2);
    expect(logs.error[0]).toEqual([page]);
    expect(logs.error[1][0]).toContain(failedTable);
  });
});

describe.each(OPERATIONS)('%s() transport', (operation, pathname) => {
  it('KNOWN BUG KB-13: waits forever for a panel that never answers', async () => {
    const api = await startBridge();
    api.panel.respondWith(pathname, { hang: true });
    const clock = useFakeClock();
    const call = track(api[operation]());
    await waitFor(() => api.panel.requestsTo(pathname).length === 1, { message: 'the request to reach the panel' });

    await clock.advance(10 * 60 * 1000);
    await settle(100);

    expect(call.state).toBe('pending');
    // Dropping the connection is the only way the call ever ends.
    await api.panel.stop();
    await waitFor(() => call.state === 'rejected', { message: 'the call to end once the connection drops' });
  });
});

describe('sendKeepAlive()', () => {
  it.each(withTitle(spec.body_ignoring_responses.map((row) => ({ ...row, known_bug: 'KB-28' }))))('$title', expectKeepAliveOutcome);

  it.each([
    ['0 (no fractional part)', 0],
    ['1e-7 (exponent notation, no decimal point)', 1e-7],
    ['0.123', 0.123],
    ['0.5', 0.5],
    ['0.999999999', 0.999999999],
  ])('KNOWN BUG KB-9: sends only msgid=1 whatever Math.random returns: %s', async (_, random) => {
    const { panel, sendKeepAlive } = await startBridge();
    vi.spyOn(Math, 'random').mockReturnValue(random);

    await sendKeepAlive();

    expect(panel.requestLines).toEqual(['GET /keep_alive.html?msgid=1']);
  });

  it('KNOWN BUG KB-28: after the session expires the keep-alive still succeeds while status polling fails', async () => {
    const { panel, getStatus, sendKeepAlive } = await startBridge({ requireLogin: true });
    expect(panel.loggedIn).toBe(false);

    await expect(sendKeepAlive()).resolves.toBeUndefined();
    const error = await rejection(getStatus());

    expect(error.message).toBe("Regex didn't match the value");
    expect(panel.requestLines).toEqual(['GET /keep_alive.html?msgid=1', 'GET /statuslive.html']);
  });
});

describe('requests as sent', () => {
  it.each(withTitle(requestRows(spec.requests, 'getStatus', 'sendKeepAlive')))('$title sends exactly $request, with only the HTTP client default headers', expectRequestAsSent);
});
