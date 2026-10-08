import { vi } from 'vitest';
import { FakePanel } from '../mock_paradox.js';
import { captureConsole, loadBridge, loadSpec, onCleanup, setBridgeEnv, useFakeClock, waitFor } from '../support.js';
import { drain, injectFailure, servePage } from './panel_faults.js';

const golden = loadSpec('crypto').credentials[0];

export const POLL = '/statuslive.html';

export const POLL_LINE = 'GET /statuslive.html';

export const ZONES = [[1, 'A'], [1, 'B']];

/**
 * A fake panel, a fake clock and a freshly loaded status_listener.js. `watch(zones)` starts a
 * listener and records what it emits; `tick(n)` advances 1000 ms and waits for the n polls it triggers.
 */
export async function boot(panelOptions = {}, env = {}) {
  const logs = captureConsole();
  const panel = await new FakePanel(panelOptions).start();
  setBridgeEnv({ HOSTNAME: panel.hostname, ...env });
  const clock = useFakeClock();
  const bridge = loadBridge();
  const { statusListener } = bridge.load('status_listener.js');
  const watchers = [];

  const watch = (zones) => {
    const listener = statusListener(zones);
    const watcher = { listener, events: [], errors: [] };
    listener.on('armedChanged', (armed) => watcher.events.push(['armedChanged', armed]));
    listener.on('sensorChanged', (index, open) => watcher.events.push(['sensorChanged', index, open]));
    listener.on('error', (error) => {
      watcher.errors.push(error);
      watcher.events.push(['error']);
    });
    watchers.push(watcher);
    return watcher;
  };

  // A refused connection never reaches the panel, so a poll is complete once it either arrived or failed.
  const progress = () => panel.requestsTo(POLL).length + watchers.reduce((sum, w) => sum + w.errors.length, 0);
  const tick = async (polls = 1) => {
    const before = progress();
    await clock.advance(1000);
    await waitFor(() => progress() >= before + polls, { message: `${polls} poll(s)` });
    await drain();
  };

  return { panel, clock, logs, bridge, statusListener, watch, tick };
}

/**
 * Spies on setInterval (call it after boot(), before creating a listener). Returns a function that runs
 * the most recently registered interval callback once and returns its promise, so a test can await one
 * poll's outcome, rejection included, without a fake-clock tick.
 */
export function captureIntervals() {
  const spy = vi.spyOn(globalThis, 'setInterval');
  // Must be undone before useFakeClock's own cleanup, or the restored spy would put the fake timer back.
  onCleanup(() => spy.mockRestore());
  return () => spy.mock.calls.at(-1)[0]();
}

export async function startListener(zones, panelOptions) {
  const env = await boot(panelOptions);
  return { ...env, ...env.watch(zones) };
}

/** A panel that answers data pages only after the real login() has run against it. */
export function bootLoggedIn(panelOptions = {}) {
  return boot(
    {
      sessionValue: golden.session,
      credentials: { [golden.session]: { u: golden.u, p: golden.p } },
      requireLogin: true,
      ...panelOptions,
    },
    { USERNAME: golden.username, PASSWORD: golden.password },
  );
}

export async function applyPoll(panel, poll) {
  if (poll.fail) return injectFailure(panel, POLL, poll.fail);
  if (poll.page) servePage(panel, POLL, poll.page);
  else panel.setStatus(poll);
  return async () => {};
}
