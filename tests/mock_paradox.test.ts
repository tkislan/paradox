import { describe, expect, it } from 'vitest';
import { ARMED, DISARMED, FakePanel } from './mock_paradox.ts';

const get = (panel, path) => fetch(`http://${panel.hostname}${path}`);

describe('FakePanel', () => {
  it('hands out the session value in the login page', async () => {
    const panel = await new FakePanel({ sessionValue: 'ABCDEF0123456789' }).start();

    const body = await (await get(panel, '/login_page.html')).text();

    expect(body).toContain('loginaff("ABCDEF0123456789"');
  });

  it('accepts only the configured credentials for the current session value', async () => {
    const panel = await new FakePanel({ sessionValue: 'S1', credentials: { S1: { u: 'AA', p: 'BB' } } }).start();

    const wrong = await (await get(panel, '/default.html?u=AA&p=XX')).text();
    expect(wrong).not.toContain('<title>Paradox IP Module</title>');
    expect(panel.loggedIn).toBe(false);

    const right = await (await get(panel, '/default.html?u=AA&p=BB')).text();
    expect(right).toContain('<title>Paradox IP Module</title>');
    expect(panel.loggedIn).toBe(true);
  });

  it('serves the configured zones in the index page and pads them to 32 slots', async () => {
    const panel = await new FakePanel({ zones: [[1, 'Door'], [0, ' ']] }).start();

    const body = await (await get(panel, '/index.html')).text();

    const zones = body.match(/tbl_zone = new Array\(([^)]*)\)/)?.[1].split(',');
    expect(zones?.slice(0, 4)).toEqual(['1', '"Door"', '0', '" "']);
    expect(zones).toHaveLength(64);
  });

  it('renders the status arrays and applies arm/disarm commands', async () => {
    const panel = await new FakePanel({ statuszone: [1, 0, 5], useraccess: [DISARMED, 0] }).start();

    const before = await (await get(panel, '/statuslive.html')).text();
    expect(before).toContain('tbl_statuszone = new Array(1,0,5)');
    expect(before).toContain('tbl_useraccess = new Array(1,0)');

    const after = await (await get(panel, '/statuslive.html?area=00&value=r')).text();
    expect(after).toContain('tbl_useraccess = new Array(2,0)');
    expect(panel.useraccess).toEqual([ARMED, 0]);

    await get(panel, '/statuslive.html?area=00&value=d');
    expect(panel.useraccess).toEqual([DISARMED, 0]);
  });

  it('answers the login page for data pages while logged out when requireLogin is set', async () => {
    const panel = await new FakePanel({ requireLogin: true }).start();

    const body = await (await get(panel, '/statuslive.html')).text();

    expect(body).toContain('loginaff(');
    expect(body).not.toContain('tbl_statuszone');
  });

  it('records requests exactly as sent', async () => {
    const panel = await new FakePanel().start();

    await get(panel, '/keep_alive.html?msgid=1');
    await get(panel, '/nope.html');

    expect(panel.requestLines).toEqual(['GET /keep_alive.html?msgid=1', 'GET /nope.html']);
    expect(panel.requestsTo('/keep_alive.html')[0].query).toEqual({ msgid: '1' });
  });

  it('injects canned responses a limited number of times', async () => {
    const panel = await new FakePanel().start();
    panel.respondWith('/statuslive.html', { status: 500, headers: {}, body: 'boom' }, { times: 1 });

    expect((await get(panel, '/statuslive.html')).status).toBe(500);
    expect((await get(panel, '/statuslive.html')).status).toBe(200);
  });

  it('can reset connections and refuse them after stop()', async () => {
    const panel = await new FakePanel().start();
    panel.respondWith('/logout.html', { destroy: true }, { times: 1 });

    await expect(get(panel, '/logout.html')).rejects.toThrow();

    await panel.stop();
    await expect(get(panel, '/logout.html')).rejects.toThrow();
  });
});
