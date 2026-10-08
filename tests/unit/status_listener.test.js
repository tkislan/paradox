import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { loadSpec, settle, waitFor, withTitle } from '../support.js';
import { holdNextResponse, injectFailure } from '../helpers/panel_faults.js';
import {
  POLL, POLL_LINE, ZONES, boot, captureIntervals, expectPollEvents, startListener,
} from '../helpers/status_listener.js';

const spec = loadSpec('status_machine');

describe('poll scenarios (spec/status_machine.json)', () => {
  const groups = ['first_poll', 'armed_codes', 'sensor_codes', 'transitions', 'failures'];

  describe.each(groups)('%s', (group) => {
    it.each(withTitle(spec[group]))('$title', expectPollEvents);
  });
});

describe('poll cadence', () => {
  it.each(withTitle(spec.status_poll_cadence))('$title', async ({ advance_ms, expected_requests }) => {
    const { panel, clock } = await startListener(ZONES);

    for (const [step, ms] of advance_ms.entries()) {
      await clock.advance(ms);
      await waitFor(() => panel.requestsTo(POLL).length >= expected_requests[step], { message: `step ${step}` });
      await settle(10);
      expect(panel.requestsTo(POLL), `after step ${step}`).toHaveLength(expected_requests[step]);
    }

    expect([...new Set(panel.requestLines)]).toEqual([POLL_LINE]);
  });
});

describe('statusListener()', () => {
  it('returns { on, stop }, and on() returns the underlying emitter', async () => {
    const { listener } = await startListener(ZONES);
    const handler = () => {};

    const emitter = listener.on('armedChanged', handler);

    expect(Object.keys(listener).sort()).toEqual(['on', 'stop']);
    expect(emitter).toBeInstanceOf(EventEmitter);
    expect(emitter.listeners('armedChanged')).toContain(handler);
    expect(listener.on('sensorChanged', handler)).toBe(emitter);
  });

  it('emits nothing before the first poll', async () => {
    const { events, errors } = await startListener(ZONES);

    await settle();

    expect(events).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('sends exactly one GET /statuslive.html per tick', async () => {
    const { panel, tick } = await startListener(ZONES);

    await tick();
    await tick();

    expect(panel.requestLines).toEqual([POLL_LINE, POLL_LINE]);
  });

  it('logs which status tables changed, with their old and new values', async () => {
    const { panel, tick, logs } = await startListener(ZONES);
    panel.setStatus({ statuszone: [1, 0], useraccess: [1, 0] });

    await tick();

    expect(logs.log).toEqual([
      ['statuszone changed'], [''], ['1,0'],
      ['useraccess changed'], [''], ['1,0'],
      ['alarms changed'], [''], ['0'],
    ]);

    logs.log.length = 0;
    await tick();
    expect(logs.log).toEqual([]);

    panel.setStatus({ statuszone: [0, 0] });
    await tick();
    expect(logs.log).toEqual([['statuszone changed'], ['1,0'], ['0,0']]);
  });
});

describe('failed polls', () => {
  it('HTTP error: emits the error, once, and logs it', async () => {
    const { panel, errors, logs, tick } = await startListener(ZONES);
    await injectFailure(panel, POLL, { status: 500 });

    await tick();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: 'Request failed with status code 500', response: { status: 500 } });
    expect(logs.error).toEqual([[errors[0]]]);
  });

  it('connection refused: emits the connection error', async () => {
    const { panel, errors, tick } = await startListener(ZONES);
    await injectFailure(panel, POLL, { connection: 'refused' });

    await tick();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('connection reset: emits the connection error', async () => {
    const { panel, errors, tick } = await startListener(ZONES);
    await injectFailure(panel, POLL, { connection: 'reset' });

    await tick();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'ECONNRESET' });
  });

  it('unparseable page: emits the parse error after the parser has logged the page and the pattern', async () => {
    const { panel, errors, logs, tick } = await startListener(ZONES);
    await injectFailure(panel, POLL, { status: 200, body: 'nothing to see' });

    await tick();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "Regex didn't match the value" });
    expect(logs.error.map(([first]) => first)).toEqual(['nothing to see', expect.stringContaining('tbl_statuszone'), errors[0]]);
  });

  it('reports a failure through the error event only: the timer callback itself resolves', async () => {
    const { panel, statusListener } = await boot();
    const pollOnce = captureIntervals();
    const errors = [];
    statusListener(ZONES).on('error', (error) => errors.push(error));
    await injectFailure(panel, POLL, { status: 500 });

    await expect(pollOnce()).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
  });
});

describe('stop()', () => {
  it('halts polling', async () => {
    const { panel, listener, clock, tick } = await startListener(ZONES);
    await tick();

    listener.stop();
    await clock.advance(5000);
    await settle();

    expect(panel.requestsTo(POLL)).toHaveLength(1);
  });

  it('before the first poll: the panel is never asked', async () => {
    const { panel, listener, clock } = await startListener(ZONES);

    listener.stop();
    await clock.advance(5000);
    await settle();

    expect(panel.requestsTo(POLL)).toHaveLength(0);
  });

  it('removes the listeners: a poll still in flight is heard by nobody', async () => {
    const { panel, listener, events, tick } = await startListener(ZONES);
    panel.setStatus({ statuszone: [1, 0], useraccess: [2, 0] });
    const inFlight = holdNextResponse(panel, POLL);
    await tick();

    listener.stop();
    inFlight.release();
    await settle();

    expect(events).toEqual([]);
    expect(listener.on('armedChanged', () => {}).listenerCount('armedChanged')).toBe(1);
  });

  it('can be called twice', async () => {
    const { listener } = await startListener(ZONES);

    listener.stop();

    expect(() => listener.stop()).not.toThrow();
  });

  it('stops only its own listener', async () => {
    const { panel, watch, tick } = await boot();
    const first = watch(ZONES);
    const second = watch(ZONES);
    panel.setStatus({ statuszone: [0, 0], useraccess: [1, 0] });
    await tick(2);
    expect(first.events).toEqual([['armedChanged', false]]);
    expect(second.events).toEqual([['armedChanged', false]]);

    first.listener.stop();
    panel.setStatus({ statuszone: [1, 0], useraccess: [1, 0] });
    await tick(1);

    expect(panel.requestsTo(POLL)).toHaveLength(3);
    expect(first.events).toEqual([['armedChanged', false]]);
    expect(second.events).toEqual([['armedChanged', false], ['sensorChanged', '0', true]]);
  });
});
