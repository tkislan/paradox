import { expect } from 'vitest';
import { FakePanel } from '../mock_paradox.js';
import { captureConsole, loadBridge, setBridgeEnv, settle, useFakeClock, waitFor } from '../support.js';
import { drain, injectFailure } from './panel_faults.js';

export const KEEP_ALIVE = '/keep_alive.html';

export const KEEP_ALIVE_LINE = 'GET /keep_alive.html?msgid=1';

export async function boot(panelOptions = {}) {
  const logs = captureConsole();
  const panel = await new FakePanel(panelOptions).start();
  setBridgeEnv({ HOSTNAME: panel.hostname });
  const clock = useFakeClock();
  const { keepAlive } = loadBridge().load('keep_alive_worker.js');
  return { panel, logs, clock, keepAlive };
}

/** Runs a keep-alive worker through `ticks` (a { fail } or {} per 3000 ms) and checks which ticks logged an error. */
export async function expectReportedFailures({ ticks, expected_error_logged: expectedErrorLogged }) {
  const { panel, logs, clock, keepAlive } = await boot();
  keepAlive();
  const logged = [];

  for (const { fail } of ticks) {
    const restore = fail ? await injectFailure(panel, KEEP_ALIVE, fail) : async () => {};
    const errorsBefore = logs.error.length;
    const attempts = () => panel.requestsTo(KEEP_ALIVE).length + logs.error.length;
    const before = attempts();
    await clock.advance(3000);
    await waitFor(() => attempts() > before, { message: 'a keep-alive attempt' });
    await drain();
    logged.push(logs.error.length - errorsBefore);
    await restore();
  }

  await settle();
  expect(logged).toEqual(expectedErrorLogged.map(Number));
  expect([...new Set(panel.requestLines)]).toEqual([KEEP_ALIVE_LINE]);
}
