import { createRequire } from 'node:module';
import { expect } from 'vitest';
import { FakePanel, type FakePanelOptions, type Zone } from '../mock_paradox.ts';
import {
  captureConsole, loadSpec, setBridgeEnv, settle, useFakeClock, waitFor,
} from '../support.ts';
import { drain, holdNextResponse, injectFailure, servePage } from './panel_faults.ts';
import { CryptoSpec } from '../spec/schemas.ts';

const require = createRequire(import.meta.url);

const golden = loadSpec('crypto', CryptoSpec).credentials[0];

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

  const watch = (zones) => {
    const listener = statusListener(zones);
    const watcher: Watcher = { listener, events: [], errors: [] };
    listener.on('armedChanged', (armed) => watcher.events.push(['armedChanged', armed]));
    listener.on('sensorChanged', (index, open) => watcher.events.push(['sensorChanged', index, open]));
    listener.on('error', (error) => {
      watcher.errors.push(error);
      watcher.events.push(['error']);
    });
    return watcher;
  };

  // A refused connection never reaches the panel, and a poll the panel did not answer emits no error, so a poll is
  // complete once it either arrived or its failure was logged.
  const progress = () => panel.requestsTo(POLL).length + logs.error.length;
  const tick = async (polls = 1) => {
    const before = progress();
    await clock.advance(1000);
    await waitFor(() => progress() >= before + polls, { message: `${polls} poll(s)` });
    await drain();
  };

  return { panel, clock, logs, statusListener, watch, tick };
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

/**
 * Plays one cadence row: a listener over ZONES, the fake clock moved by each entry of `advance_ms`, and after each the
 * number of polls the panel has seen so far. With `answers_after_step` the panel holds the answer to the step's poll
 * until the step is over.
 */
export async function expectPollCadence({ advance_ms: advanceMs, expected_requests: expectedRequests, answers_after_step: answersAfterStep = false }) {
  const { panel, clock } = await startListener(ZONES);

  for (const [step, ms] of advanceMs.entries()) {
    const slow = answersAfterStep ? holdNextResponse(panel, POLL) : null;
    await clock.advance(ms);
    await waitFor(() => panel.requestsTo(POLL).length >= expectedRequests[step], { message: `step ${step}` });
    await settle(10);
    expect(panel.requestsTo(POLL), `after step ${step}`).toHaveLength(expectedRequests[step]);
    if (slow) {
      slow.release();
      await drain();
    }
  }

  expect([...new Set(panel.requestLines)]).toEqual([POLL_LINE]);
}
