import { describe, expect, it } from 'vitest';
import { expectConnectTimeout, expectTimeout, rejection } from '../helpers/outcomes.ts';
import { html } from '../helpers/responses.ts';
import { specText, withTitle } from '../support.ts';
import {
  OPERATIONS, expectKeepAliveOutcome, expectParsedStatus, expectRequestAsSent, httpFailureRows, requestRows, spec,
  startBridge,
} from '../helpers/status.ts';

describe('getStatus() page parsing', () => {
  it.each(withTitle(spec.get_status))('$title', expectParsedStatus);

  it('rejects values with a leading zero with a SyntaxError instead of reading them as octal', async () => {
    const { panel, getStatus } = await startBridge();
    panel.respondWith('/statuslive.html', html('tbl_statuszone = new Array(010,011);var stayd="0";tbl_useraccess = new Array(1,0);'));

    const error = await rejection(getStatus());

    expect(error.name).toBe('SyntaxError');
  });

  it.each([
    ['tbl_alarmes', `tbl_alarmes = new Array(${'1'.repeat(30)}a);tbl_troubles = new Array();`],
    ['tbl_troubles', `tbl_alarmes = new Array();tbl_troubles = new Array(${'1'.repeat(30)}a);`],
  ])('rejects a long run of digits in %s that ends in garbage at once, instead of retrying every way to split it', async (_table, tables) => {
    const { panel, getStatus } = await startBridge();
    panel.respondWith('/statuslive.html', html(`tbl_statuszone = new Array(1,0);var stayd="0";tbl_useraccess = new Array(1,0);${tables}`));

    const started = performance.now();
    const error = await rejection(getStatus());

    expect(error.message).toBe("Regex didn't match the value");
    // A pattern with every separator optional needs about 4 s for these 30 digits, and 4 times as long per 2 more;
    // about 30 s when this is the pattern's first run, which V8 interprets instead of compiling, as when run alone.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('getStatus() against the fake panel', () => {
  it('returns the panel state as served', async () => {
    const { panel, getStatus } = await startBridge({ statuszone: [1, 0, 5, ...new Array(29).fill(0)], useraccess: [2, 0] });
    panel.setStatus({ alarms: ['1'], troubles: ['16', '38'] });

    expect(await getStatus()).toEqual({
      statuszone: [1, 0, 5, ...new Array(29).fill(0)],
      useraccess: [2, 0],
      alarms: [1],
      troubles: [16, 38],
    });
    expect(panel.requestLines).toEqual(['GET /statuslive.html']);
  });

  it('reads the panel afresh on every call', async () => {
    const { panel, getStatus } = await startBridge({ useraccess: [1, 0] });

    const before = await getStatus();
    panel.setStatus({ useraccess: [2, 0], statuszone: [0, 1, ...new Array(30).fill(0)], alarms: ['1'], troubles: ['19'] });
    const after = await getStatus();

    expect(before.useraccess).toEqual([1, 0]);
    expect(after).toEqual({ statuszone: [0, 1, ...new Array(30).fill(0)], useraccess: [2, 0], alarms: [1], troubles: [19] });
  });

  it('concurrent calls each make their own request and all resolve', async () => {
    const { panel, getStatus } = await startBridge({ useraccess: [2, 0] });

    const results = await Promise.all([getStatus(), getStatus(), getStatus()]);

    expect(panel.requestsTo('/statuslive.html')).toHaveLength(3);
    expect(results.map((result) => result.useraccess)).toEqual([[2, 0], [2, 0], [2, 0]]);
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
    panel.respondWith(
      '/statuslive.html',
      html(`${filler}tbl_statuszone = new Array(1,2);tbl_useraccess = new Array(2,0);tbl_alarmes = new Array("1");tbl_troubles = new Array("38");`),
    );

    expect(await getStatus()).toEqual({ statuszone: [1, 2], useraccess: [2, 0], alarms: [1], troubles: [38] });
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

  it('rejects 20000 ms after the call when the panel never answers', async () => {
    const api = await startBridge();

    await expectTimeout(api.panel, pathname, api[operation]);
  });

  it('rejects 20000 ms after the call when the panel stalls halfway through the body', async () => {
    const api = await startBridge();

    await expectTimeout(api.panel, pathname, api[operation], { stall: '<html><head>' });
  });

  it('rejects 2000 ms after the call when the connection never opens', async () => {
    const api = await startBridge();

    await expectConnectTimeout(api.panel, api[operation]);
  });
});

describe('sendKeepAlive()', () => {
  it('resolves with no value', async () => {
    const { sendKeepAlive } = await startBridge();

    await expect(sendKeepAlive()).resolves.toBeUndefined();
  });

  it.each(withTitle(spec.body_ignoring_responses))('$title', expectKeepAliveOutcome);

  it.each(withTitle(requestRows(spec.login_page_responses, 'sendKeepAlive')))('$title', expectKeepAliveOutcome);

  it('rejects after the session expired, as status polling does', async () => {
    const { panel, getStatus, sendKeepAlive } = await startBridge({ requireLogin: true });
    expect(panel.loggedIn).toBe(false);

    const error = await rejection(sendKeepAlive());
    await rejection(getStatus());

    expect(error.message).toBe('Keep-alive answered with the login page');
    expect(panel.requestLines).toEqual(['GET /keep_alive.html?msgid=1', 'GET /statuslive.html']);
  });
});

describe('requests as sent', () => {
  it.each(withTitle(requestRows(spec.requests, 'getStatus', 'sendKeepAlive')))('$title sends exactly $request, with only the HTTP client default headers', expectRequestAsSent);
});
