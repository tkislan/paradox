import { describe, expect, it, vi } from 'vitest';
import { rejection, track } from '../helpers/outcomes.js';
import { html } from '../helpers/responses.js';
import { settle, specText, useFakeClock, waitFor, withTitle } from '../support.js';
import { OPERATIONS, httpFailureRows, plain, plainStatus, requestRows, spec, startBridge } from '../helpers/status.js';

describe('getStatus() page parsing', () => {
  it.each(withTitle(spec.get_status))('$title', async ({ page, expected }) => {
    const { panel, getStatus } = await startBridge();
    panel.respondWith('/statuslive.html', html(specText(page)));

    if ('error' in expected) {
      const error = await rejection(getStatus());
      expect(error.message).toBe(expected.error);
    } else {
      expect(plainStatus(await getStatus())).toEqual(expected);
    }
  });

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

describe('getStatus() against the fake panel', () => {
  it('returns the panel state as served', async () => {
    const { panel, getStatus } = await startBridge({ statuszone: [1, 0, 5, ...new Array(29).fill(0)], useraccess: [2, 0] });

    expect(plainStatus(await getStatus())).toEqual({
      statuszone: [1, 0, 5, ...new Array(29).fill(0)],
      useraccess: [2, 0],
      alarms: [0],
    });
    expect(panel.requestLines).toEqual(['GET /statuslive.html']);
  });

  it('reads the panel afresh on every call', async () => {
    const { panel, getStatus } = await startBridge({ useraccess: [1, 0] });

    const before = plainStatus(await getStatus());
    panel.setStatus({ useraccess: [2, 0], statuszone: [0, 1, ...new Array(30).fill(0)] });
    const after = plainStatus(await getStatus());

    expect(before.useraccess).toEqual([1, 0]);
    expect(after).toEqual({ statuszone: [0, 1, ...new Array(30).fill(0)], useraccess: [2, 0], alarms: [0] });
  });

  it('concurrent calls each make their own request and all resolve', async () => {
    const { panel, getStatus } = await startBridge({ useraccess: [2, 0] });

    const results = await Promise.all([getStatus(), getStatus(), getStatus()]);

    expect(panel.requestsTo('/statuslive.html')).toHaveLength(3);
    expect(results.map((result) => plain(result.useraccess))).toEqual([[2, 0], [2, 0], [2, 0]]);
  });

  it.each(httpFailureRows)('$name, even when the page is valid', async ({ response, expected }) => {
    const { panel, getStatus } = await startBridge();
    panel.respondWith('/statuslive.html', html(specText({ file: 'data/unarmed.html' }), response.status));

    const error = await rejection(getStatus());

    expect(error.message).toBe(expected.error);
  });

  it('finds the tables after a megabyte of other content', async () => {
    const { panel, getStatus } = await startBridge();
    const filler = `<!-- ${'x'.repeat(1024 * 1024)} -->`;
    panel.respondWith('/statuslive.html', html(`${filler}tbl_statuszone = new Array(1,2);tbl_useraccess = new Array(2,0);`));

    expect(plainStatus(await getStatus())).toEqual({ statuszone: [1, 2], useraccess: [2, 0], alarms: [0] });
  });
});

describe.each(OPERATIONS)('%s() redirects and cookies', (operation, pathname) => {
  it('follows a redirect and lets the final response decide', async () => {
    const api = await startBridge();
    api.panel.respondWith(pathname, html('', 302, { Location: '/moved.html' }), { times: 1 });
    api.panel.respondWith('/moved.html', html(specText({ file: 'data/armed.html' })));

    await api[operation]();

    expect(api.panel.requestsTo('/moved.html')).toHaveLength(1);
    expect(api.panel.requestsTo(pathname)).toHaveLength(1);
  });

  it('gives up on a redirect loop instead of following it forever', async () => {
    const api = await startBridge();
    api.panel.respondWith(pathname, (request) => html('', 302, { Location: request.url }));

    const error = await rejection(api[operation]());

    expect(error.message).toBe('Maximum number of redirects exceeded');
  });

  it('does not send back a cookie the panel set', async () => {
    const api = await startBridge();
    api.panel.respondWith(pathname, html(specText({ file: 'data/armed.html' }), 200, { 'Set-Cookie': 'ID=abc123; Path=/' }), { times: 1 });

    await api[operation]();
    await api[operation]();

    expect(api.panel.requestsTo(pathname)).toHaveLength(2);
    expect(api.panel.requests[1].headers).not.toHaveProperty('cookie');
  });
});

describe.each(OPERATIONS)('%s() transport', (operation, pathname) => {
  it('rejects on HTTP 500 and does not retry', async () => {
    const api = await startBridge();
    api.panel.respondWith(pathname, html('boom', 500));

    const error = await rejection(api[operation]());

    expect(error.message).toBe('Request failed with status code 500');
    expect(error.response.status).toBe(500);
    expect(api.panel.requestsTo(pathname)).toHaveLength(1);
  });

  it('rejects when the connection is refused', async () => {
    const api = await startBridge();
    await api.panel.stop();

    const error = await rejection(api[operation]());

    expect(error.code).toBe('ECONNREFUSED');
  });

  it('rejects when the connection is reset and does not retry', async () => {
    const api = await startBridge();
    api.panel.respondWith(pathname, { destroy: true });

    const error = await rejection(api[operation]());

    expect(error.code).toBe('ECONNRESET');
    expect(api.panel.requestsTo(pathname)).toHaveLength(1);
  });

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

  it('resolves with no value', async () => {
    const { sendKeepAlive } = await startBridge();

    await expect(sendKeepAlive()).resolves.toBeUndefined();
  });

  const keepAliveRows = spec.body_ignoring_responses.map((row) => (row.known_bug ? { ...row, known_bug: 'KB-28' } : row));

  it.each(withTitle(keepAliveRows))('$title', async ({ response, expected }) => {
    const { panel, sendKeepAlive } = await startBridge();
    panel.respondWith('/keep_alive.html', html(specText(response.body), response.status));

    if ('error' in expected) {
      const error = await rejection(sendKeepAlive());
      expect(error.message).toBe(expected.error);
    } else {
      await expect(sendKeepAlive()).resolves.toBeUndefined();
    }
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
  it.each(withTitle(requestRows('getStatus', 'sendKeepAlive')))('$title sends exactly $request, with only the HTTP client default headers', async ({ operation, request, absent_headers }) => {
    const api = await startBridge();

    await api[operation]();

    expect(api.panel.requestLines).toEqual([request]);
    const { headers } = api.panel.requests[0];
    for (const name of absent_headers) expect(headers).not.toHaveProperty(name);
    expect(Object.keys(headers).filter((name) => !['host', 'connection'].includes(name)).sort()).toEqual(['accept', 'user-agent']);
    expect(headers.accept).toBe('application/json, text/plain, */*');
    expect(headers['user-agent']).toMatch(/^axios\//);
  });
});
