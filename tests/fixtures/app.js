import { renderLoginPage } from '../mock_paradox.js';
import { loadSpec } from '../support.js';

// Every scenario waits for a free Mosquitto instance and talks to it over docker's network.
export const spec = loadSpec('system_scenarios');

export const login = spec.login;

// Loopback round trips take well under a millisecond; this is the window in which unexpected extra effects can still show up.
// What the broker did is settled separately, by broker.syncLog().
export const QUIET_MS = 10;

export const WAIT_INTERVAL_MS = 2;

export const REACH_TIMEOUT_MS = 8000;

export const READY_TIMEOUT_MS = 15000;

export const SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'];

export const FAULTS = {
  http_500: { status: 500, headers: { 'Content-Type': 'text/plain' }, body: 'Internal Server Error' },
  reset: { destroy: true },
  hang: { hang: true },
  login_page: { status: 200, headers: { 'Content-Type': 'text/html' }, body: renderLoginPage(login.session) },
  garbage: { status: 200, headers: { 'Content-Type': 'text/html' }, body: '<html>no status tables here</html>' },
  wrong_title: {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
    body: '<html><head><title>Not the panel</title></head><body></body></html>',
  },
};
