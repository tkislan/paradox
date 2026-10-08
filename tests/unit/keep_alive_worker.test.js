import { describe, expect, it } from 'vitest';
import { loadSpec, settle, waitFor, withTitle } from '../support.js';
import { KEEP_ALIVE, KEEP_ALIVE_LINE, boot, expectReportedFailures } from '../helpers/keep_alive_worker.js';

const spec = loadSpec('status_machine');

describe('keepAlive() cadence (spec/status_machine.json)', () => {
  it.each(withTitle(spec.keep_alive_cadence))('$title', async ({ advance_ms, expected_requests }) => {
    const { panel, clock, keepAlive } = await boot();
    keepAlive();

    for (const [step, ms] of advance_ms.entries()) {
      await clock.advance(ms);
      await waitFor(() => panel.requestsTo(KEEP_ALIVE).length >= expected_requests[step], { message: `step ${step}` });
      await settle(10);
      expect(panel.requestsTo(KEEP_ALIVE), `after step ${step}`).toHaveLength(expected_requests[step]);
    }

    expect([...new Set(panel.requestLines)]).toEqual([KEEP_ALIVE_LINE]);
  });
});

describe('keepAlive() request', () => {
  it('returns at once with { stop }', async () => {
    const { keepAlive } = await boot();

    const worker = keepAlive();

    expect(Object.keys(worker)).toEqual(['stop']);
    expect(worker.stop).toBeTypeOf('function');
  });
});

describe('keepAlive() failures', () => {
  it.each(withTitle(spec.keep_alive_failures))('$title', expectReportedFailures);

  it('logs the error object itself, and only that', async () => {
    const { panel, logs, clock, keepAlive } = await boot();
    panel.respondWith(KEEP_ALIVE, { status: 500, headers: {}, body: 'boom' }, { times: 1 });
    keepAlive();

    await clock.advance(3000);
    await waitFor(() => logs.error.length === 1, { message: 'the logged error' });

    expect(logs.error).toHaveLength(1);
    expect(logs.error[0]).toHaveLength(1);
    expect(logs.error[0][0]).toMatchObject({ message: 'Request failed with status code 500', response: { status: 500 } });
  });

  it('a connection error is logged with its code', async () => {
    const { panel, logs, clock, keepAlive } = await boot();
    keepAlive();
    await panel.stop();

    await clock.advance(3000);
    await waitFor(() => logs.error.length === 1, { message: 'the logged error' });

    expect(logs.error[0][0]).toMatchObject({ code: 'ECONNREFUSED' });
  });
});

describe('stop()', () => {
  it('halts the keep-alives', async () => {
    const { panel, clock, keepAlive } = await boot();
    const worker = keepAlive();
    await clock.advance(3000);
    await waitFor(() => panel.requestsTo(KEEP_ALIVE).length === 1, { message: 'the first keep-alive' });

    worker.stop();
    await clock.advance(30000);
    await settle();

    expect(panel.requestsTo(KEEP_ALIVE)).toHaveLength(1);
  });

  it('before the first keep-alive: none is ever sent', async () => {
    const { panel, clock, keepAlive } = await boot();
    const worker = keepAlive();

    worker.stop();
    await clock.advance(30000);
    await settle();

    expect(panel.requestsTo(KEEP_ALIVE)).toHaveLength(0);
  });

  it('can be called twice', async () => {
    const { keepAlive } = await boot();
    const worker = keepAlive();

    worker.stop();

    expect(() => worker.stop()).not.toThrow();
  });

  it('stops only its own worker', async () => {
    const { panel, clock, keepAlive } = await boot();
    const first = keepAlive();
    keepAlive();
    await clock.advance(3000);
    await waitFor(() => panel.requestsTo(KEEP_ALIVE).length === 2, { message: 'both keep-alives' });

    first.stop();
    await clock.advance(3000);
    await waitFor(() => panel.requestsTo(KEEP_ALIVE).length === 3, { message: 'the remaining worker' });
    await settle();

    expect(panel.requestsTo(KEEP_ALIVE)).toHaveLength(3);
  });
});
