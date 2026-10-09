import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { onCleanup, reservePort } from '../support.ts';
import {
  ARM_LINE, DISARM_LINE, HTML, LOGIN_ATTEMPT_PATHS, MQTT_CREDENTIALS, NOT_AUTHORIZED, SIGNAL_ROWS, TEST_TIMEOUT,
  golden, login, mqtt, zones,
} from '../fixtures/process.ts';
import {
  CONNECT_TIMEOUT_ROWS, DROP_ROWS, FAILURES, expectLoginFailure, expectStartupFailure, failCommands, launch, polls,
  publishedMessages, rest, runRows, until, untilListening, untilSubscribed,
} from '../helpers/process.ts';

describe('bridge process', () => {
  describe('startup', () => {
    it('logs in, connects to MQTT with the configured credentials, subscribes to both command topics, then starts listening', async () => {
      const ctx = await launch();

      await untilListening(ctx);

      expect(ctx.panel.requestLines).toEqual([
        'GET /logout.html',
        'GET /login_page.html',
        `GET /default.html?u=${golden.u}&p=${golden.p}`,
        'GET /index.html',
      ]);
      expect(ctx.bridge.stdout).toContain('Session value: 91AC25D06A0C26BA');
      expect(ctx.bridge.stdout).toContain('MQTT client connected');
      await untilSubscribed(ctx);
      await ctx.broker.syncLog();
      // Mosquitto never reports passwords: the bridge being let in (CONNACK 0) as the one user that has them is the evidence.
      expect(ctx.broker.connects).toHaveLength(1);
      expect(ctx.broker.connects[0]).toMatchObject({ username: 'mqttuser' });
      expect(ctx.broker.connacks).toEqual([0]);
      expect(ctx.broker.subscriptions).toEqual([
        { topic: 'paradox/command/arm', qos: 0 },
        { topic: 'paradox/command/disarm', qos: 0 },
      ]);
      expect(ctx.bridge.result).toBeNull();
    }, TEST_TIMEOUT);

    it('exits 1 with "Login failed" when the panel answers the login with a page of another title', async () => {
      const ctx = await launch();
      ctx.panel.respondWith('/default.html', {
        status: 200,
        headers: HTML,
        body: '<html><head><title>Paradox Login</title></head><body></body></html>',
      });

      await expectLoginFailure(ctx, ['Error: Login failed']);

      expect(ctx.panel.requests.map((r) => r.path)).toEqual(LOGIN_ATTEMPT_PATHS);
    }, TEST_TIMEOUT);

    it('exits 1 when the panel is not reachable at all, after warning that the logout before login failed', async () => {
      const ctx = await launch({ env: { HOSTNAME: `127.0.0.1:${await reservePort()}` } });

      await expectLoginFailure(ctx, ['Logout before login failed', 'ECONNREFUSED']);

      expect(ctx.panel.requests).toEqual([]);
    }, TEST_TIMEOUT);

    it('exits 1 when the login page has no session value, without sending any credentials', async () => {
      const ctx = await launch();
      ctx.panel.respondWith('/login_page.html', { status: 200, headers: HTML, body: '<html><head><title>Paradox</title></head><body>busy</body></html>' });

      await expectLoginFailure(ctx, ['Error: Session value not found in login page']);

      expect(ctx.panel.requests.map((r) => r.path)).toEqual(['/logout.html', '/login_page.html']);
    }, TEST_TIMEOUT);

    it('exits 1 when the MQTT broker rejects the credentials, without ever polling the panel', async () => {
      const ctx = await launch({ env: { MQTT_PASSWORD: 'not-the-password' } });

      await expectStartupFailure(ctx, [NOT_AUTHORIZED]);

      await until(() => ctx.broker.connacks.length === 1, 'the broker to answer the login');
      await ctx.broker.syncLog();
      // Mosquitto logs a CONNECT only once it accepted it, so the one rejected attempt shows up as a CONNACK alone.
      expect(ctx.broker.connacks).toEqual([5]);
      expect(ctx.broker.connects).toEqual([]);
      expect(ctx.bridge.stdout).not.toContain('MQTT client connected');
    }, TEST_TIMEOUT);

    it('gives up after the 5 s connect timeout when nothing listens on the MQTT port or the broker never answers CONNECT', async () => {

      await runRows(CONNECT_TIMEOUT_ROWS, async ({ proxy, accepted, sentConnect }) => {
        const ctx = await launch({ proxy });

        await expectStartupFailure(ctx, ['Error: MQTT connect timeout'], { timeout: 20000 });

        const [index] = ctx.panel.requestsTo('/index.html');
        const sinceLogin = ctx.bridge.exitedAt! - index.at!;
        expect(sinceLogin).toBeGreaterThanOrEqual(4500);
        expect(sinceLogin).toBeLessThan(6500);
        expect(ctx.panel.requestsTo('/index.html')).toHaveLength(1);
        expect(ctx.proxy!.accepted).toBe(accepted);
        if (sentConnect) {
          expect(ctx.proxy!.connects).toMatchObject([{ username: MQTT_CREDENTIALS.username, password: MQTT_CREDENTIALS.password }]);
        }
        await ctx.broker.syncLog();
        expect(ctx.broker.connects).toEqual([]);
        expect(ctx.bridge.stdout).not.toContain('MQTT client connected');
        expect(ctx.panel.requestsTo('/keep_alive.html')).toEqual([]);
      });
    }, TEST_TIMEOUT);

    it('exits 1 on an uncaught error event when the REST port is already in use', async () => {
      const blocker = await new Promise<http.Server>((resolve) => {
        const server = http.createServer();
        server.listen(0, () => resolve(server));
      });
      onCleanup(() => new Promise((resolve) => blocker.close(resolve)));
      const ctx = await launch({ env: { PORT: String((blocker.address() as AddressInfo).port) } });

      expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });

      expect(ctx.bridge.stderr).toContain('EADDRINUSE');
      expect(ctx.bridge.stdout).toContain('MQTT client connected');
      expect(ctx.bridge.stdout).not.toContain('Server listening');
    }, TEST_TIMEOUT);
  });

  describe('running', () => {
    it('publishes later panel changes to MQTT and logs, without publishing, an armed code it does not know', async () => {
      const ctx = await launch();
      const published = () => publishedMessages(ctx);
      await until(() => published().length === 1, 'the first publish');

      ctx.panel.setStatus({ useraccess: [2, 0], statuszone: zones(0, 3) });
      await until(() => published().length === 4, 'the publishes of the armed panel');
      ctx.panel.setStatus({ useraccess: [3, 0], statuszone: zones() });
      await until(() => published().length === 6, 'the publishes of the closed sensors');

      await until(() => ctx.bridge.stdout.includes('Unknown armed status'), 'the unknown armed status log');
      expect(published()).toEqual([
        'paradox/status/armed OFF',
        'paradox/status/armed ON',
        'paradox/sensor/0 ON',
        'paradox/sensor/3 ON',
        'paradox/sensor/0 OFF',
        'paradox/sensor/3 OFF',
      ]);
      expect(ctx.broker.published.every((p) => p.retain === true)).toBe(true);
    }, TEST_TIMEOUT);

    it('GET /status returns the raw status JSON; POST /arm and /disarm send the panel commands; other routes are 404', async () => {
      const ctx = await launch({ panel: { statuszone: zones(1) } });
      await untilListening(ctx);

      const status = await rest(ctx, 'GET', '/status');
      expect(status.status).toBe(200);
      expect(status.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(JSON.parse(status.body)).toEqual({ statuszone: zones(1), useraccess: [1, 0], alarms: [0] });

      const arm = await rest(ctx, 'POST', '/arm');
      expect(arm).toMatchObject({ status: 200, body: 'OK' });
      expect(JSON.parse((await rest(ctx, 'GET', '/status')).body).useraccess).toEqual([2, 0]);
      const disarm = await rest(ctx, 'POST', '/disarm');
      expect(disarm).toMatchObject({ status: 200, body: 'OK' });
      expect(JSON.parse((await rest(ctx, 'GET', '/status')).body).useraccess).toEqual([1, 0]);

      expect(ctx.panel.requestLines.filter((line) => line.includes('area='))).toEqual([ARM_LINE, DISARM_LINE]);
      expect((await rest(ctx, 'GET', '/arm')).status).toBe(404);
      expect((await rest(ctx, 'POST', '/status')).status).toBe(404);
      expect((await rest(ctx, 'GET', '/')).status).toBe(404);
    }, TEST_TIMEOUT);

    it('answers 500 with the error message as JSON when the panel fails a REST-triggered request', async () => {
      const ctx = await launch();
      await untilListening(ctx);
      await until(() => polls(ctx.panel).length === 1, 'the first poll');
      // Taken right after a poll: the next one is ~1 s away, so only the REST call can consume the one-shot override.
      ctx.panel.respondWith('/statuslive.html', { status: 500, headers: HTML, body: 'busy' }, { times: 1 });

      const status = await rest(ctx, 'GET', '/status');

      expect(status.status).toBe(500);
      expect(JSON.parse(status.body)).toEqual({ msg: 'Request failed with status code 500' });
      failCommands(ctx.panel, ['r', 'd']);
      for (const route of ['/arm', '/disarm']) {
        const response = await rest(ctx, 'POST', route);
        expect(response.status).toBe(500);
        expect(JSON.parse(response.body)).toEqual({ msg: 'Request failed with status code 500' });
      }
      expect(ctx.bridge.result).toBeNull();
    }, TEST_TIMEOUT);
  });

  describe('failures after startup', () => {
    it('exits 1 when the MQTT connection drops after startup', async () => {

      await runRows(DROP_ROWS, async ({ proxy, drop }) => {
        const ctx = await launch({ proxy });
        await untilListening(ctx);

        await drop(ctx);

        expect(await ctx.bridge.waitForExit()).toEqual({ code: 1, signal: null });
      });
    }, TEST_TIMEOUT);
  });

  describe('shutdown', () => {
    it('exits with 128 plus the signal number on SIGHUP (129) and SIGINT (130)', async () => {

      await runRows(SIGNAL_ROWS, async ({ signal, code }) => {
        const ctx = await launch();
        await untilListening(ctx);

        ctx.bridge.kill(signal);

        expect(await ctx.bridge.waitForExit()).toEqual({ code, signal: null });
        expect(ctx.bridge.stdout).toContain(`Process received a ${signal} signal`);
      });
    }, TEST_TIMEOUT);
  });

  describe('logging', () => {
    it('never writes the panel or MQTT credentials to stdout or stderr, however it fails', async () => {
      await runRows(FAILURES, async ({ panel, brokerUser = mqtt, arrange, check }) => {
        const ctx = await launch({
          panel,
          brokerUser,
          env: { USERNAME: login.username, PASSWORD: login.password, MQTT_USERNAME: mqtt.username, MQTT_PASSWORD: mqtt.password },
        });
        if (arrange) arrange(ctx);

        await check(ctx);

        const output = ctx.bridge.stdout + ctx.bridge.stderr;
        for (const secret of [login.username, login.password, mqtt.username, mqtt.password]) expect(output).not.toContain(secret);
      });
    }, TEST_TIMEOUT);
  });
});
