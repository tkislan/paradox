import { createRequire } from 'node:module';
import { expect, vi } from 'vitest';
import { FakePanel, type FakePanelOptions, type Zone } from '../mock_paradox.ts';
import {
  captureConsole, loadSpec, onCleanup, setBridgeEnv, settle, useFakeClock, waitFor,
} from '../support.ts';
import { drain, injectFailure, servePage } from './panel_faults.ts';

const require = createRequire(import.meta.url);

const golden = loadSpec('crypto').credentials[0];

export const POLL = '/statuslive.html';

export const POLL_LINE = 'GET /statuslive.html';

export const ZONES: Zone[] = [[1, 'A'], [1, 'B']];

type Watcher = { listener: any; events: unknown[][]; errors: unknown[] };

/**
 * A fake panel, a fake clock and a freshly loaded status_listener.js. `watch(zones)` starts a
 * listener and records what it emits; `tick(n)` advances 1000 ms and waits for the n polls it triggers.
 */
export async function boot(panelOptions: FakePanelOptions = {}, env: Record<string, string> = {}) {
  const logs = captureConsole();
  const panel = await new FakePanel(panelOptions).start();
  setBridgeEnv({ HOSTNAME: panel.hostname, ...env });
  const clock = useFakeClock();
  const { statusListener } = require('../../src/status_listener.js');
  const watchers: Watcher[] = [];

  const watch = (zones) => {
    const listener = statusListener(zones);
    const watcher: Watcher = { listener, events: [], errors: [] };
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

  return { panel, clock, logs, statusListener, watch, tick };
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
  return () => spy.mock.calls.at(-1)![0]();
}

export async function startListener(zones, panelOptions?: FakePanelOptions) {
  const env = await boot(panelOptions);
  return { ...env, ...env.watch(zones) };
}

/** A panel that answers data pages only after the real login() has run against it. */
export function bootLoggedIn(panelOptions: FakePanelOptions = {}) {
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

/** Plays one spec scenario: a listener over `zones`, one tick per entry of `polls`, then the events it emitted. */
export async function expectPollEvents({ zones, polls, expected_events: expectedEvents }) {
  const { panel, events, tick } = await startListener(zones);

  for (const poll of polls) {
    const restore = await applyPoll(panel, poll);
    await tick();
    await restore();
  }

  await settle();
  expect(events).toEqual(expectedEvents);
  expect([...new Set(panel.requestLines)]).toEqual([POLL_LINE]);
}
