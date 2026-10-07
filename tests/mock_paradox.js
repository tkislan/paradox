import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onCleanup } from './support.js';

/*
 * Fake Paradox IP100/IP150 web UI, built from the captured pages in tests/data/.
 *
 * Contract (everything the bridge ever asks of the panel):
 *   GET /logout.html                       -> ends the session
 *   GET /login_page.html                   -> page containing loginaff("<session value>", ...)
 *   GET /default.html?u=<..>&p=<..>        -> "Paradox IP Module" page on success, the login page otherwise
 *   GET /index.html                        -> page containing tbl_zone = new Array(<enabled>,"<name>",...)
 *   GET /statuslive.html                   -> page containing tbl_statuszone / tbl_useraccess / tbl_alarmes
 *   GET /statuslive.html?area=00&value=r|d -> arm / disarm, then the status page
 *   GET /keep_alive.html?msgid=1           -> 200
 * What a real panel answers to a failed login, a command, a keep-alive or an expired session was not
 * captured; those responses are plausible stand-ins, so tests must not rely on their bodies.
 *
 * `handle()` is pure (request in, response out) so the same contract can be ported to any HTTP mock;
 * `start()` wraps it in a real HTTP server on loopback.
 */

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const readPage = (name) => fs.readFileSync(path.join(DATA_DIR, name), 'utf8');

const TEMPLATES = {
  login: readPage('login_page.html'),
  default: readPage('default_page.html'),
  index: readPage('index_page.html'),
  status: readPage('unarmed.html'),
};

const ZONE_SLOTS = 32;
const DEFAULT_ZONES = [
  [1, 'Predsien'], [1, 'Lava izba'], [1, 'Prava izba'], [1, 'Spalna'], [1, 'Obyvacka'], [1, 'Chodba'],
];

export const DISARMED = 1;
export const ARMED = 2;
export const ARMING = 7;

const swap = (template, pattern, replacement) => {
  if (!pattern.test(template)) throw new Error(`Template does not contain ${pattern}`);
  return template.replace(pattern, () => replacement);
};

export function renderLoginPage(sessionValue) {
  return swap(TEMPLATES.login, /loginaff\("\w+"/, `loginaff("${sessionValue}"`);
}

export function renderIndexPage(zones) {
  const slots = Array.from({ length: ZONE_SLOTS }, (_, i) => zones[i] || [0, ' ']);
  const array = slots.map(([enabled, name]) => `${enabled},"${name}"`).join(',');
  return swap(TEMPLATES.index, /tbl_zone = new Array\([^)]*\)/, `tbl_zone = new Array(${array})`);
}

export function renderStatusPage({ statuszone, useraccess, alarms = [] }) {
  let page = swap(TEMPLATES.status, /tbl_statuszone = new Array\([^)]*\)/, `tbl_statuszone = new Array(${statuszone.join(',')})`);
  page = swap(page, /tbl_useraccess = new Array\([^)]*\)/, `tbl_useraccess = new Array(${useraccess.join(',')})`);
  return swap(page, /tbl_alarmes = new Array\([^)]*\)/, `tbl_alarmes = new Array(${alarms.map((a) => `"${a}"`).join(',')})`);
}

const html = (body, status = 200) => ({ status, headers: { 'Content-Type': 'text/html' }, body });

export class FakePanel {
  /**
   * @param {object} [options]
   * @param {string} [options.sessionValue] value handed out in the login page
   * @param {{[sessionValue: string]: {u: string, p: string}}} [options.credentials] the u/p query values
   *   accepted per session value; with none configured every login is rejected
   * @param {Array<[number, string]>} [options.zones] [enabled, name] pairs of the index page
   * @param {number[]} [options.statuszone] per-zone status codes (32 entries)
   * @param {number[]} [options.useraccess] area state codes, first entry is area 1
   * @param {boolean} [options.requireLogin] answer the login page instead of data pages while logged out
   */
  constructor({
    sessionValue = '91AC25D06A0C26BA',
    credentials = {},
    zones = DEFAULT_ZONES,
    statuszone = new Array(ZONE_SLOTS).fill(0),
    useraccess = [DISARMED, 0],
    requireLogin = false,
  } = {}) {
    this.sessionValue = sessionValue;
    this.credentials = credentials;
    this.zones = zones;
    this.statuszone = statuszone;
    this.useraccess = useraccess;
    this.requireLogin = requireLogin;
    this.alarms = [];

    this.loggedIn = false;
    this.requests = [];
    this.overrides = [];
    this.server = null;
    this.sockets = new Set();
    this.port = 0;
  }

  get hostname() {
    return `127.0.0.1:${this.port}`;
  }

  /** Every request line seen so far, as sent on the wire, e.g. `GET /default.html?u=AB&p=CD`. */
  get requestLines() {
    return this.requests.map((r) => `${r.method} ${r.url}`);
  }

  requestsTo(pathname) {
    return this.requests.filter((r) => r.path === pathname);
  }

  /** Merges new data-page state; subsequent status pages reflect it. */
  setStatus({ statuszone, useraccess, alarms }) {
    if (statuszone) this.statuszone = statuszone;
    if (useraccess) this.useraccess = useraccess;
    if (alarms) this.alarms = alarms;
  }

  /** Drops the session, as if it timed out or another login took it over. */
  expireSession() {
    this.loggedIn = false;
  }

  /**
   * Answers the next `times` requests for `pathname` with `response` instead of the normal behaviour.
   * `response` is a handle() result, a function (request) => result, or a transport fault:
   * { destroy: true } resets the socket, { hang: true } never answers.
   */
  respondWith(pathname, response, { times = Infinity } = {}) {
    this.overrides.push({ pathname, response, times });
  }

  clearOverrides() {
    this.overrides = [];
  }

  /** @returns {{status: number, headers: object, body: string} | {destroy: true} | {hang: true}} */
  handle(request) {
    const override = this.overrides.find((o) => o.pathname === request.path && o.times > 0);
    if (override) {
      override.times -= 1;
      return typeof override.response === 'function' ? override.response(request) : override.response;
    }

    switch (request.path) {
      case '/logout.html':
        this.loggedIn = false;
        return html('<html><body>Logged out</body></html>');

      case '/login_page.html':
        return html(renderLoginPage(this.sessionValue));

      case '/default.html': {
        const expected = this.credentials[this.sessionValue];
        const ok = expected && request.query.u === expected.u && request.query.p === expected.p;
        this.loggedIn = Boolean(ok);
        return html(ok ? TEMPLATES.default : renderLoginPage(this.sessionValue));
      }

      case '/index.html':
        return this.requireLogin && !this.loggedIn ? html(renderLoginPage(this.sessionValue)) : html(renderIndexPage(this.zones));

      case '/statuslive.html':
        if (this.requireLogin && !this.loggedIn) return html(renderLoginPage(this.sessionValue));
        if (request.query.value === 'r') this.useraccess = [ARMED, ...this.useraccess.slice(1)];
        if (request.query.value === 'd') this.useraccess = [DISARMED, ...this.useraccess.slice(1)];
        return html(renderStatusPage(this));

      case '/keep_alive.html':
        return this.requireLogin && !this.loggedIn ? html(renderLoginPage(this.sessionValue)) : html('');

      default:
        return html('Not found', 404);
    }
  }

  /** Starts listening on loopback (on `port` if given, e.g. to bring a stopped panel back). Auto-stops after the test. */
  async start(port = 0) {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://panel');
      const request = {
        method: req.method,
        url: req.url,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
      };
      this.requests.push(request);

      const result = this.handle(request);
      if (result.hang) return;
      if (result.destroy) return req.socket.destroy();

      res.writeHead(result.status, result.headers);
      res.end(result.body);
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise((resolve) => this.server.listen(port, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    onCleanup(() => this.stop());
    return this;
  }

  /** Stops listening and kills open connections, so further requests fail with ECONNREFUSED. */
  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => server.close(resolve));
  }
}
