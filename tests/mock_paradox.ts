import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onCleanup } from './support.ts';

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
const readPage = (name: string) => fs.readFileSync(path.join(DATA_DIR, name), 'utf8');

const TEMPLATES = {
  login: readPage('login_page.html'),
  default: readPage('default_page.html'),
  index: readPage('index_page.html'),
  status: readPage('unarmed.html'),
};

const ZONE_SLOTS = 32;
export type Zone = [enabled: number, name: string];

const DEFAULT_ZONES: Zone[] = [
  [1, 'Predsien'], [1, 'Lava izba'], [1, 'Prava izba'], [1, 'Spalna'], [1, 'Obyvacka'], [1, 'Chodba'],
];

export const DISARMED = 1;
export const ARMED = 2;
export const ARMING = 7;

const swap = (template: string, pattern: RegExp, replacement: string) => {
  if (!pattern.test(template)) throw new Error(`Template does not contain ${pattern}`);
  return template.replace(pattern, () => replacement);
};

export function renderLoginPage(sessionValue: string) {
  return swap(TEMPLATES.login, /loginaff\("\w+"/, `loginaff("${sessionValue}"`);
}

export function renderIndexPage(zones: Zone[]) {
  const slots = Array.from({ length: ZONE_SLOTS }, (_, i) => zones[i] || [0, ' ']);
  const array = slots.map(([enabled, name]) => `${enabled},"${name}"`).join(',');
  return swap(TEMPLATES.index, /tbl_zone = new Array\([^)]*\)/, `tbl_zone = new Array(${array})`);
}

function renderStatusPage({ statuszone, useraccess, alarms = [] }: { statuszone: number[]; useraccess: number[]; alarms?: string[] }) {
  let page = swap(TEMPLATES.status, /tbl_statuszone = new Array\([^)]*\)/, `tbl_statuszone = new Array(${statuszone.join(',')})`);
  page = swap(page, /tbl_useraccess = new Array\([^)]*\)/, `tbl_useraccess = new Array(${useraccess.join(',')})`);
  return swap(page, /tbl_alarmes = new Array\([^)]*\)/, `tbl_alarmes = new Array(${alarms.map((a) => `"${a}"`).join(',')})`);
}

const html = (body: string, status = 200) => ({ status, headers: { 'Content-Type': 'text/html' }, body });

export type PanelRequest = {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
};

/** What the panel answers: a response, or a transport fault (`destroy` resets the socket, `hang` never answers). */
export type PanelResult =
  | { status: number; headers: Record<string, string>; body: string; destroy?: never; hang?: never }
  | { destroy: true; hang?: never }
  | { hang: true; destroy?: never };

type Override = { pathname: string; response: PanelResult | ((request: PanelRequest) => PanelResult); times: number };

export type FakePanelOptions = {
  /** Value handed out in the login page. */
  sessionValue?: string;
  /** The u/p query values accepted per session value; with none configured every login is rejected. */
  credentials?: { [sessionValue: string]: { u: string; p: string } };
  /** [enabled, name] pairs of the index page. */
  zones?: Zone[];
  /** Per-zone status codes (32 entries). */
  statuszone?: number[];
  /** Area state codes, first entry is area 1. */
  useraccess?: number[];
  /** Answer the login page instead of data pages while logged out. */
  requireLogin?: boolean;
};

export class FakePanel {
  sessionValue: string;
  credentials: NonNullable<FakePanelOptions['credentials']>;
  zones: Zone[];
  statuszone: number[];
  useraccess: number[];
  requireLogin: boolean;
  alarms: string[];
  loggedIn: boolean;
  requests: PanelRequest[];
  overrides: Override[];
  server: http.Server | null;
  sockets: Set<Socket>;
  port: number;

  constructor({
    sessionValue = '91AC25D06A0C26BA',
    credentials = {},
    zones = DEFAULT_ZONES,
    statuszone = new Array(ZONE_SLOTS).fill(0),
    useraccess = [DISARMED, 0],
    requireLogin = false,
  }: FakePanelOptions = {}) {
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

  requestsTo(pathname: string) {
    return this.requests.filter((r) => r.path === pathname);
  }

  /** Merges new data-page state; subsequent status pages reflect it. */
  setStatus({ statuszone, useraccess, alarms }: { statuszone?: number[]; useraccess?: number[]; alarms?: string[] }) {
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
  respondWith(pathname: string, response: Override['response'], { times = Infinity } = {}) {
    this.overrides.push({ pathname, response, times });
  }

  clearOverrides() {
    this.overrides = [];
  }

  handle(request: PanelRequest): PanelResult {
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
      // An http.Server request always has a method and a URL.
      const url = new URL(req.url!, 'http://panel');
      const request: PanelRequest = {
        method: req.method!,
        url: req.url!,
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
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
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
