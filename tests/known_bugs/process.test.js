import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { leaseBroker } from '../mosquitto.js';
import { onCleanup, settle } from '../support.js';
import {
  ARM_LINE, DISARM_LINE, HTML, LOGIN_ATTEMPT_PATHS, MQTT_CREDENTIALS, TEST_TIMEOUT,
} from '../fixtures/process.js';
import {
  FIRST_POLL, FORGED_CONNACK_BAD_CREDENTIALS, KEEP_ALIVE_ROWS, MISSING_ENV, POLL_FAILURES,
} from '../fixtures/known_bugs/process.js';
import {
  NODE_MAJOR, expectLoginFailure, failCommands, launch, polls, publishedMessages, request, rest, runRows, until,
  untilListening, untilSubscribed,
} from '../helpers/process.js';

describe('bridge process', () => {
  describe('configuration', () => {
    it('KNOWN BUG KB-20: exits 1 before touching the network with the misspelled "Missing enviromnent variable: <first missing name>"', async () => {
      // No row may reach the broker, so they can all be pointed at one.
      const broker = await leaseBroker();
      await broker.addUser(MQTT_CREDENTIALS);

      await runRows(MISSING_ENV, async ({ missing, reported }) => {
        const ctx = await launch({ broker, env: Object.fromEntries(missing.map((name) => [name, undefined])) });

        expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });
        expect(ctx.bridge.stderr).toContain(`Error: Missing enviromnent variable: ${reported}`);
        expect(ctx.bridge.stdout).toBe('');
        expect(ctx.panel.requests).toEqual([]);
      });

      await broker.syncLog();
      expect(broker.connects).toEqual([]);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-41: an empty environment variable counts as set, so an empty USERNAME fails at login instead of in the config check', async () => {
      const ctx = await launch({ env: { USERNAME: '' } });

      expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });
      expect(ctx.bridge.stderr).not.toContain('Missing enviromnent variable');
      expect(ctx.panel.requestsTo('/default.html')).toHaveLength(1);
    }, TEST_TIMEOUT);
  });

  describe('startup', () => {
    it('KNOWN BUG KB-11: a rejected login that the panel answers with the login page again is reported as "Session value not found in login page"', async () => {
      const ctx = await launch({ env: { PASSWORD: 'wrong' } });

      await expectLoginFailure(ctx, ['Error: Session value not found in login page']);

      expect(ctx.panel.requests.map((r) => r.path)).toEqual(LOGIN_ATTEMPT_PATHS);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-5: an index page that keeps failing is requested 11 times back to back before startup gives up', async () => {
      const ctx = await launch();
      ctx.panel.respondWith('/index.html', { status: 500, headers: HTML, body: 'busy' });

      await expectLoginFailure(ctx, ['Request failed with status code 500']);

      expect(ctx.panel.requests.map((r) => r.path)).toEqual([...LOGIN_ATTEMPT_PATHS, ...Array(11).fill('/index.html')]);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-10: a zone name with a hyphen makes the index page unparsable and login fail', async () => {
      const ctx = await launch({ panel: { zones: [[1, 'Front-door']] } });

      await expectLoginFailure(ctx, ["Error: Regex didn't match the value"]);

      expect(ctx.panel.requests.map((r) => r.path)).toEqual([...LOGIN_ATTEMPT_PATHS, '/index.html']);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-25: an out-of-range PORT is only noticed by listen(), after login and the MQTT connect, and exits 1', async () => {
      const ctx = await launch({ env: { PORT: '99999' } });

      expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });

      expect(ctx.bridge.stderr).toContain('ERR_SOCKET_BAD_PORT');
      expect(ctx.bridge.stdout).toContain('MQTT client connected');
      expect(ctx.panel.requestsTo('/index.html')).toHaveLength(1);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-25: a non-numeric PORT makes the REST server listen on a Unix socket of that name in the working directory', async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paradox-bridge-'));
      onCleanup(() => fs.rmSync(cwd, { recursive: true, force: true }));
      const ctx = await launch({ env: { PORT: 'bridge.sock' }, cwd });

      await until(() => ctx.bridge.stdout.includes('Server listening on port bridge.sock'), 'the server to listen');

      expect(fs.statSync(path.join(cwd, 'bridge.sock')).isSocket()).toBe(true);
      const response = await request({ socketPath: path.join(cwd, 'bridge.sock') }, 'GET', '/status');
      expect(response.status).toBe(200);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-13: a panel that never answers during login hangs startup forever, and SIGTERM then kills the process by default action', async () => {
      const ctx = await launch();
      ctx.panel.respondWith('/login_page.html', { hang: true });

      await until(() => ctx.panel.requestsTo('/login_page.html').length === 1, 'the login page request');
      await settle(1200);

      await ctx.broker.syncLog();
      expect(ctx.bridge.result).toBeNull();
      expect(ctx.broker.connects).toEqual([]);
      expect(ctx.bridge.stdout).not.toContain('Server listening');
      ctx.bridge.kill('SIGTERM');
      // The signal handlers are installed only at the very end of startup, so Node's default applies:
      // death by signal instead of the 128 + n exit code of the handled path.
      expect(await ctx.bridge.waitForExit()).toEqual({ code: null, signal: 'SIGTERM' });
    }, TEST_TIMEOUT);
  });

  describe('running', () => {
    it('KNOWN BUG KB-4: only differences from the assumed initial state reach MQTT on the first poll, retained, and unchanged polls publish nothing (rows KB-1, KB-2, KB-18 pin their own quirks)', async () => {
      await runRows(FIRST_POLL, async ({ zones: panelZones, useraccess, statuszone, published }) => {
        const ctx = await launch({ panel: { zones: panelZones, useraccess, statuszone } });

        // The third poll is due a second after the second one, by when the second one's result has been handled (and published, had it been a change).
        await until(() => polls(ctx.panel).length >= 3, 'three status polls');
        await ctx.broker.syncLog();

        expect(publishedMessages(ctx)).toEqual(published);
        expect(ctx.broker.published.every((p) => p.retain === true && p.qos === 0)).toBe(true);
        // The broker really holds what was published, and nothing else: the retain flag is not just claimed.
        const retained = Object.fromEntries(published.map((message) => message.split(' ')));
        for (const topic of new Set(['paradox/status/armed', ...Object.keys(retained)])) {
          expect(await ctx.broker.retained(topic)).toBe(retained[topic] ?? null);
        }
      });
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-16: MQTT command payloads are ignored, the topic alone arms or disarms; a failing command is only logged', async () => {
      const ctx = await launch();
      const published = () => publishedMessages(ctx);
      await until(() => published().length === 1, 'the first publish');
      await untilSubscribed(ctx);

      await ctx.broker.publish('paradox/command/arm', 'OFF');
      await until(() => ctx.panel.requestLines.includes(ARM_LINE), 'the arm request');
      await until(() => published().length === 2, 'the armed state to come back');

      failCommands(ctx.panel, ['r']);
      await ctx.broker.publish('paradox/command/arm', 'ON');
      await ctx.broker.publish('paradox/command/disarm', '');
      await until(() => ctx.bridge.stderr.includes('Request failed with status code 500'), 'the failed arm to be logged');
      await until(() => ctx.panel.requestLines.includes(DISARM_LINE), 'the disarm request');
      await until(() => published().length === 3, 'the disarmed state to come back');

      expect(published()).toEqual(['paradox/status/armed OFF', 'paradox/status/armed ON', 'paradox/status/armed OFF']);
      expect(ctx.bridge.result).toBeNull();
      // Node before 15 only warns about an unhandled rejection and keeps running, so the exit check above would not see it.
      expect(ctx.bridge.stderr).not.toContain('Unhandled');
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-15: GET /status always reports alarms [0], whatever alarms the panel lists', async () => {
      const ctx = await launch();
      ctx.panel.setStatus({ alarms: ['1', '0', '3'] });
      await untilListening(ctx);

      const { body } = await rest(ctx, 'GET', '/status');

      expect(JSON.parse(body).alarms).toEqual([0]);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-14: POST /arm answers 200 even though the panel only served the login page, and the next poll then kills the bridge', async () => {
      const ctx = await launch({ panel: { requireLogin: true } });
      await untilListening(ctx);
      ctx.panel.expireSession();

      const response = await rest(ctx, 'POST', '/arm');

      expect(response).toMatchObject({ status: 200, body: 'OK' });
      expect(ctx.panel.requestLines).toContain(ARM_LINE);
      expect(ctx.panel.useraccess).toEqual([1, 0]);
      expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-19: the REST API needs no credentials and listens on every interface (127.0.0.2 stands in for a LAN address)', async () => {
      const ctx = await launch();
      await untilListening(ctx);

      const other = { host: '127.0.0.2', port: ctx.port };

      expect((await request(other, 'GET', '/status')).status).toBe(200);
      expect((await request(other, 'POST', '/arm')).status).toBe(200);
      expect(ctx.panel.requestLines).toContain(ARM_LINE);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-9: sends GET /keep_alive.html?msgid=1 every 3 s without the random cache-buster; a failing keep-alive is only logged', async () => {

      await runRows(KEEP_ALIVE_ROWS, async ({ failFirstKeepAlive }) => {
        const ctx = await launch();
        if (failFirstKeepAlive) ctx.panel.respondWith('/keep_alive.html', { status: 500, headers: HTML, body: 'busy' }, { times: 1 });

        await until(() => ctx.panel.requestsTo('/keep_alive.html').length === 2, 'two keep-alives', 20000);

        const [first, second] = ctx.panel.requestsTo('/keep_alive.html');
        const sinceLogin = first.at - ctx.panel.requestsTo('/index.html')[0].at;
        expect(sinceLogin).toBeGreaterThanOrEqual(2200);
        expect(sinceLogin).toBeLessThan(4600);
        // Both stamps are taken by the panel, so the gap is the bridge's interval plus one loopback hop of jitter.
        expect(second.at - first.at).toBeGreaterThanOrEqual(2750);
        expect(second.at - first.at).toBeLessThan(3400);
        expect(ctx.panel.requestLines.filter((line) => line.includes('keep_alive'))).toEqual(['GET /keep_alive.html?msgid=1', 'GET /keep_alive.html?msgid=1']);
        // Polls run every second: 2 or 3 of them (the third is due together with the keep-alive) come before the first keep-alive.
        const requestPaths = ctx.panel.requests.map((request) => request.path);
        const pollsBeforeKeepAlive = requestPaths.slice(0, requestPaths.indexOf('/keep_alive.html')).filter((path) => path === '/statuslive.html').length;
        expect(pollsBeforeKeepAlive).toBeGreaterThanOrEqual(2);
        expect(pollsBeforeKeepAlive).toBeLessThanOrEqual(3);
        if (!failFirstKeepAlive) return expect(ctx.bridge.stderr).toBe('');

        await until(() => ctx.bridge.stderr.includes('Request failed with status code 500'), 'the keep-alive failure to be logged');
        const pollsBefore = polls(ctx.panel).length;
        await until(() => polls(ctx.panel).length > pollsBefore, 'another poll');
        expect(ctx.bridge.result).toBeNull();
        expect(ctx.bridge.stderr).not.toContain('Unhandled');
      });
    }, TEST_TIMEOUT);
  });

  describe('failures after startup', () => {
    it('KNOWN BUG KB-12: the first failed status poll is fatal (exit 1) and there is no re-login or retry', async () => {
      await runRows(POLL_FAILURES, async ({ stderrIncludes, pollsReachingPanel, panel: panelOptions, breakPanel }) => {
        const ctx = await launch({ panel: panelOptions });
        await untilListening(ctx);
        await breakPanel(ctx.panel);

        expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });

        expect(ctx.bridge.stderr).toContain(stderrIncludes);
        expect(ctx.panel.requestsTo('/default.html')).toHaveLength(1);
        expect(ctx.panel.requestsTo('/login_page.html')).toHaveLength(1);
        expect(polls(ctx.panel)).toHaveLength(pollsReachingPanel);
      });
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-7: the pre-connect error handler is still attached, so a late MQTT error is logged by it before the exit handler ends the process', async () => {
      const ctx = await launch({ proxy: true });
      await untilListening(ctx);
      expect(ctx.bridge.stderr).toBe('');

      // A real broker never sends a second CONNACK, so the proxy plays one.
      ctx.proxy.inject(FORGED_CONNACK_BAD_CREDENTIALS);

      expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });
      expect(ctx.bridge.stderr).toContain('Connection refused: Bad username or password');
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-13: a panel that stops answering is never given up on: polls pile up unanswered and the process neither fails nor exits', async () => {
      const ctx = await launch();
      await untilListening(ctx);
      ctx.panel.respondWith('/statuslive.html', { hang: true });

      await until(() => polls(ctx.panel).length === 2, 'two overlapping polls');

      expect(ctx.bridge.result).toBeNull();
      expect(ctx.bridge.stderr).toBe('');
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-38: SIGTERM stops the pollers but does not complete while a REST request is stuck on a hung panel', async () => {
      const ctx = await launch();
      await untilListening(ctx);
      ctx.panel.respondWith('/statuslive.html', { hang: true });
      // Signalled just before the 3 s keep-alive and third poll are due, so a worker that kept running would show up.
      await until(() => polls(ctx.panel).length === 2, 'the second poll');
      const stuck = http.get({ host: '127.0.0.1', port: ctx.port, path: '/status', agent: false });
      stuck.on('error', () => {});
      onCleanup(() => stuck.destroy());
      await until(() => ctx.panel.requestsTo('/statuslive.html').length === 3, 'the REST request to reach the panel');

      const requestsAtSignal = ctx.panel.requests.length;
      ctx.bridge.kill('SIGTERM');
      await until(() => ctx.bridge.stdout.includes('Process received a SIGTERM signal'), 'the signal to be handled');
      await settle(1500);

      expect(ctx.bridge.result).toBeNull();
      expect(ctx.panel.requests).toHaveLength(requestsAtSignal);
    }, TEST_TIMEOUT);
  });

  describe('shutdown', () => {
    it('KNOWN BUG KB-3: SIGTERM ends the process with exit code 143 but never logs out of the panel', async () => {
      const ctx = await launch();
      await untilListening(ctx);
      expect(ctx.panel.requestsTo('/logout.html')).toHaveLength(1);

      ctx.bridge.kill('SIGTERM');

      expect(await ctx.bridge.waitForExit()).toEqual({ code: 143, signal: null });
      expect(ctx.bridge.stdout).toContain('Process received a SIGTERM signal');
      expect(ctx.panel.requestsTo('/logout.html')).toHaveLength(1);
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-38: repeated SIGTERM, SIGINT and SIGHUP do not end a shutdown that waits for a stuck request, only SIGKILL does', async () => {
      const ctx = await launch();
      await untilListening(ctx);
      ctx.panel.respondWith('/statuslive.html', { hang: true });
      const stuck = http.get({ host: '127.0.0.1', port: ctx.port, path: '/status', agent: false });
      stuck.on('error', () => {});
      onCleanup(() => stuck.destroy());
      await until(() => ctx.panel.requestsTo('/statuslive.html').length >= 1, 'the REST request to reach the panel');

      ctx.bridge.kill('SIGTERM');
      await until(() => ctx.bridge.stdout.includes('Process received a SIGTERM signal'), 'the first signal to be handled');
      ctx.bridge.kill('SIGINT');
      ctx.bridge.kill('SIGHUP');
      ctx.bridge.kill('SIGTERM');
      await until(
        () => ['SIGINT', 'SIGHUP'].every((signal) => ctx.bridge.stdout.includes(`Process received a ${signal} signal`))
          && ctx.bridge.stdout.split('Process received a SIGTERM signal').length === 3,
        'the repeated signals to be handled',
      );
      await settle(1000);

      expect(ctx.bridge.result).toBeNull();
    }, TEST_TIMEOUT);

    it('KNOWN BUG KB-38: an idle keep-alive HTTP client delays the SIGTERM exit until its connection closes (Node < 19: the 5 s server keep-alive timeout)', async () => {
      const ctx = await launch();
      await untilListening(ctx);
      const agent = new http.Agent({ keepAlive: true });
      onCleanup(() => agent.destroy());
      expect((await rest(ctx, 'GET', '/status', { agent })).status).toBe(200);

      const signalledAt = performance.now();
      ctx.bridge.kill('SIGTERM');

      expect(await ctx.bridge.waitForExit(20000)).toEqual({ code: 143, signal: null });
      // Node >= 19 closes idle connections in server.close(); older versions wait for the socket to time out.
      if (NODE_MAJOR >= 19) expect(ctx.bridge.exitedAt - signalledAt).toBeLessThan(2500);
      else expect(ctx.bridge.exitedAt - signalledAt).toBeGreaterThanOrEqual(2500);
    }, TEST_TIMEOUT);
  });
});
