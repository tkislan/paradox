import { describe, expect, it } from 'vitest';
import { ARMED, DISARMED } from '../mock_paradox.js';
import { settle, specText, useFakeClock, waitFor, withTitle } from '../support.js';
import { rejection, track } from '../helpers/outcomes.js';
import { html } from '../helpers/responses.js';
import { COMMANDS, requestRows, spec, startBridge } from '../helpers/alarm.js';

describe('requests as sent', () => {
  it.each(withTitle(requestRows('arm', 'disarm')))('$title sends exactly $request, with only the HTTP client default headers', async ({ operation, request, absent_headers }) => {
    const api = await startBridge();

    await api[operation]();

    expect(api.panel.requestLines).toEqual([request]);
    const { headers } = api.panel.requests[0];
    for (const name of absent_headers) expect(headers).not.toHaveProperty(name);
    expect(Object.keys(headers).filter((name) => !['host', 'connection'].includes(name)).sort()).toEqual(['accept', 'user-agent']);
    expect(headers.accept).toBe('application/json, text/plain, */*');
    expect(headers['user-agent']).toMatch(/^axios\//);
  });

  it('concurrent commands are all sent, without debouncing', async () => {
    const { panel, arm, disarm } = await startBridge();

    await Promise.all([arm(), arm(), disarm()]);

    expect([...panel.requestLines].sort()).toEqual([
      'GET /statuslive.html?area=00&value=d',
      'GET /statuslive.html?area=00&value=r',
      'GET /statuslive.html?area=00&value=r',
    ]);
  });
});

describe('effect on the panel', () => {
  it('arm() puts the panel into the armed state and disarm() back into the disarmed state', async () => {
    const { panel, arm, disarm, getStatus } = await startBridge({ useraccess: [DISARMED, 0] });

    await arm();
    expect((await getStatus()).useraccess[0]).toBe(ARMED);
    expect(panel.useraccess).toEqual([ARMED, 0]);

    await disarm();
    expect((await getStatus()).useraccess[0]).toBe(DISARMED);
    expect(panel.useraccess).toEqual([DISARMED, 0]);
  });
});

describe.each(COMMANDS)('%s() outcome', (command) => {
  it.each(withTitle(spec.body_ignoring_responses))('$title', async ({ response, expected }) => {
    const api = await startBridge();
    api.panel.respondWith('/statuslive.html', html(specText(response.body), response.status));

    if ('error' in expected) {
      const error = await rejection(api[command]());
      expect(error.message).toBe(expected.error);
    } else {
      await expect(api[command]()).resolves.toBeUndefined();
    }
  });

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

  it('gives up on a redirect loop instead of following it forever', async () => {
    const api = await startBridge();
    api.panel.respondWith('/statuslive.html', (request) => html('', 302, { Location: request.url }));

    const error = await rejection(api[command]());

    expect(error.message).toBe('Maximum number of redirects exceeded');
  });

  it('does not send back a cookie the panel set', async () => {
    const api = await startBridge();
    api.panel.respondWith('/statuslive.html', html('', 200, { 'Set-Cookie': 'ID=abc123; Path=/' }), { times: 1 });

    await api[command]();
    await api[command]();

    expect(api.panel.requestsTo('/statuslive.html')).toHaveLength(2);
    expect(api.panel.requests[1].headers).not.toHaveProperty('cookie');
  });

  it('rejects on HTTP 500 without retrying', async () => {
    const api = await startBridge();
    api.panel.respondWith('/statuslive.html', html('boom', 500));

    const error = await rejection(api[command]());

    expect(error.response.status).toBe(500);
    expect(api.panel.requestsTo('/statuslive.html')).toHaveLength(1);
  });

  it('rejects when the connection is refused', async () => {
    const api = await startBridge();
    await api.panel.stop();

    const error = await rejection(api[command]());

    expect(error.code).toBe('ECONNREFUSED');
  });

  it('rejects when the connection is reset without retrying', async () => {
    const api = await startBridge();
    api.panel.respondWith('/statuslive.html', { destroy: true });

    const error = await rejection(api[command]());

    expect(error.code).toBe('ECONNRESET');
    expect(api.panel.requestsTo('/statuslive.html')).toHaveLength(1);
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
