import { describe, expect, it } from 'vitest';
import { ARMED, DISARMED } from '../mock_paradox.js';
import { withTitle } from '../support.js';
import { rejection } from '../helpers/outcomes.js';
import { html } from '../helpers/responses.js';
import { COMMANDS, expectResponseHandled, spec, startBridge } from '../helpers/alarm.js';

describe('requests as sent', () => {
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
  it.each(withTitle(spec.body_ignoring_responses))('$title', (row) => expectResponseHandled(command, row));

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
});
