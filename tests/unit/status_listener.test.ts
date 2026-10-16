import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  captureUnhandledRejections, loadSpec, settle, waitFor, withTitle,
} from '../support.ts';
import { holdNextResponse, injectFailure } from '../helpers/panel_faults.ts';
import {
  POLL, POLL_LINE, ZONES, boot, bootLoggedIn, expectPollCadence, expectPollEvents, startListener,
} from '../helpers/status_listener.ts';
import { StatusMachineSpec } from '../spec/schemas.ts';

const require = createRequire(import.meta.url);

const spec = loadSpec('status_machine', StatusMachineSpec);

describe('poll scenarios (spec/status_machine.json)', () => {
  const groups = ['first_poll', 'armed_codes', 'sensor_codes', 'transitions', 'zone_indexing', 'failures'] as const;

  describe.each(groups)('%s', (group) => {
    it.each(withTitle(spec[group]))('$title', expectPollEvents);
  });
});

describe('poll cadence', () => {
  it.each(withTitle(spec.status_poll_cadence))('$title', expectPollCadence);
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

  it('no answer: emits the timeout error 10000 ms after the poll was sent, not a millisecond earlier', async () => {
    const { panel, errors, clock, tick } = await startListener(ZONES);
    panel.respondWith(POLL, { hang: true }, { times: 1 });

    await tick();
    await clock.advance(9999);
    await settle();
    expect(errors).toEqual([]);

    await clock.advance(1);
    await waitFor(() => errors.length === 1, { message: 'the timeout error' });
    expect(errors[0]).toMatchObject({ message: 'timeout of 10000ms exceeded' });
  });

  it('reports a failure through the error event only: nothing is rejected', async () => {
    const { panel, errors, tick } = await startListener(ZONES);
    const unhandled = captureUnhandledRejections();
    await injectFailure(panel, POLL, { status: 500 });

    await tick();

    expect(errors).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });

  it('once the session has expired every poll fails, and the listener itself does not log in again', async () => {
    const { panel, watch, tick } = await bootLoggedIn();
    const { zoneTuples } = await require('../../src/api/login.js').login();
    const { events, errors } = watch(zoneTuples);
    await tick();
    expect(events).toEqual([['armedChanged', false]]);
    const requestsBeforeExpiry = panel.requests.length;

    panel.expireSession();
    await tick();
    await tick();

    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ message: "Regex didn't match the value" });
    expect(panel.requestLines.slice(requestsBeforeExpiry)).toEqual([POLL_LINE, POLL_LINE]);
  });
});

describe('hung and slow panels', () => {
  it('while the panel does not answer, the ticks are skipped: one poll stays pending until it fails', async () => {
    const { panel, events, clock, tick } = await startListener(ZONES);
    panel.respondWith(POLL, { hang: true });
    await tick();

    await clock.advance(3000);
    await settle();
    expect(panel.requestsTo(POLL)).toHaveLength(1);
    expect(events).toEqual([]);

    await panel.stop();
    await waitFor(() => events.length === 1, { message: 'the dropped connection to surface' });
    // The panel is gone, so this poll is refused: its error is what shows that the tick polled.
    await tick();
    expect(events).toEqual([['error'], ['error']]);
  });

  it('a slow answer holds back the next poll, so no answer can arrive after a newer one', async () => {
    const { panel, events, clock, tick } = await startListener(ZONES);
    panel.setStatus({ statuszone: [1, 0], useraccess: [1, 0] });
    const slow = holdNextResponse(panel, POLL);
    await tick();
    panel.setStatus({ statuszone: [0, 0], useraccess: [1, 0] });
    await clock.advance(1000);
    await settle();
    expect(panel.requestsTo(POLL)).toHaveLength(1);
    expect(events).toEqual([]);

    slow.release();
    await waitFor(() => events.length === 2, { message: 'the slow answer to be applied' });
    expect(events).toEqual([['armedChanged', false], ['sensorChanged', '0', true]]);

    await tick();
    expect(events).toEqual([['armedChanged', false], ['sensorChanged', '0', true], ['sensorChanged', '0', false]]);
  });
});

describe('exceptions inside a poll', () => {
  it('with no error listener a failed poll rejects nothing, and the next tick polls again', async () => {
    const { panel, statusListener, tick } = await boot();
    const unhandled = captureUnhandledRejections();
    statusListener(ZONES);
    await injectFailure(panel, POLL, { status: 500 });

    await tick();
    await tick();

    expect(unhandled).toEqual([]);
    expect(panel.requestsTo(POLL)).toHaveLength(2);
  });

  it('a poll that fails after stop() rejects nothing', async () => {
    const { panel, logs, statusListener, tick } = await boot();
    const unhandled = captureUnhandledRejections();
    const listener = statusListener(ZONES);
    panel.respondWith(POLL, { hang: true }, { times: 1 });
    await tick();

    listener.stop();
    await panel.stop();
    await waitFor(() => logs.error.length > 0, { message: 'the failed poll to be logged' });
    await settle();

    expect(logs.error[0]).toEqual([expect.objectContaining({ code: 'ECONNRESET' })]);
    expect(unhandled).toEqual([]);
  });

  it('an exception thrown by a listener is logged instead of rejected, and the next tick polls again', async () => {
    const { panel, logs, statusListener, tick } = await boot();
    const unhandled = captureUnhandledRejections();
    statusListener(ZONES).on('armedChanged', () => { throw new Error('listener failed'); });
    panel.setStatus({ useraccess: [2, 0] });

    await tick();
    await tick();

    expect(unhandled).toEqual([]);
    expect(logs.error).toContainEqual([expect.objectContaining({ message: 'listener failed' })]);
    expect(panel.requestsTo(POLL)).toHaveLength(2);
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

describe('with the real login()', () => {
  it('a zone after an unused slot is the sensor of its own slot and reads its own status', async () => {
    const { panel, watch, tick } = await bootLoggedIn({ zones: [[1, 'Door'], [0, ' '], [1, 'Hall']] });
    const { zoneTuples } = await require('../../src/api/login.js').login();
    expect(zoneTuples).toEqual([[1, 'Door'], [0, ' '], [1, 'Hall'], ...Array(29).fill([0, ' '])]);
    const { events } = watch(zoneTuples);

    panel.setStatus({ statuszone: [0, 0, 1, ...Array(29).fill(0)], useraccess: [1, 0] });
    await tick();
    expect(events).toEqual([['armedChanged', false], ['sensorChanged', '2', true]]);

    panel.setStatus({ statuszone: [0, 1, 0, ...Array(29).fill(0)] });
    await tick();
    expect(events).toEqual([['armedChanged', false], ['sensorChanged', '2', true], ['sensorChanged', '2', false]]);
  });
});
