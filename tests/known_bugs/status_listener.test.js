import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  captureConsole, loadKnownBugSpec, setBridgeEnv, useFakeClock, waitFor, withTitle,
} from '../support.js';
import { holdNextResponse, injectFailure } from '../helpers/panel_faults.js';
import {
  POLL, POLL_LINE, ZONES, boot, bootLoggedIn, captureIntervals, expectPollEvents, startListener,
} from '../helpers/status_listener.js';

const require = createRequire(import.meta.url);

const spec = loadKnownBugSpec('status_machine');

describe('poll scenarios (spec/known_bugs/status_machine.json)', () => {
  const groups = ['first_poll', 'armed_codes', 'sensor_codes', 'zone_indexing', 'failures'];

  describe.each(groups)('%s', (group) => {
    it.each(withTitle(spec[group]))('$title', expectPollEvents);
  });
});

describe('statusListener()', () => {
  it('KNOWN BUG KB-4: the constructor emits the assumed initial state before anyone can listen', async () => {
    captureConsole();
    setBridgeEnv();
    useFakeClock();
    const { statusListener } = require('../../src/status_listener.js');
    const emit = vi.spyOn(EventEmitter.prototype, 'emit');

    statusListener([[1, 'A'], [1, 'B']]);

    const startup = emit.mock.calls.filter(([name]) => name === 'armedChanged' || name === 'sensorChanged');
    expect(startup).toEqual([
      ['armedChanged', null],
      ['sensorChanged', '0', false],
      ['sensorChanged', '1', false],
    ]);
  });
});

describe('failed polls', () => {
  it('KNOWN BUG KB-12: once the session has expired every poll fails and nothing logs in again', async () => {
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
  it('KNOWN BUG KB-13: a panel that never answers is never reported; a new poll piles up every second', async () => {
    const { panel, events, errors, tick } = await startListener(ZONES);
    panel.respondWith(POLL, { hang: true });

    for (let poll = 1; poll <= 4; poll += 1) await tick();

    expect(panel.requestsTo(POLL)).toHaveLength(4);
    expect(events).toEqual([]);

    await panel.stop();
    await waitFor(() => errors.length === 4, { message: 'the dropped connections to surface' });
    expect(events).toEqual([['error'], ['error'], ['error'], ['error']]);
  });

  it('KNOWN BUG KB-13: a slow response that arrives after a newer one overwrites the newer state until the next poll', async () => {
    const { panel, events, tick } = await startListener(ZONES);
    panel.setStatus({ statuszone: [1, 0], useraccess: [1, 0] });
    const slow = holdNextResponse(panel, POLL);
    await tick();
    panel.setStatus({ statuszone: [0, 0], useraccess: [1, 0] });
    await tick();
    expect(panel.requestsTo(POLL)).toHaveLength(2);
    expect(events).toEqual([['armedChanged', false]]);

    slow.release();
    await waitFor(() => events.length === 2, { message: 'the late response to be applied' });
    expect(events).toEqual([['armedChanged', false], ['sensorChanged', '0', true]]);

    await tick();
    expect(events).toEqual([['armedChanged', false], ['sensorChanged', '0', true], ['sensorChanged', '0', false]]);
  });
});

describe('exceptions inside a poll', () => {
  it('KNOWN BUG KB-27: with no error listener a failed poll rejects the timer callback', async () => {
    const { panel, logs, statusListener } = await boot();
    const pollOnce = captureIntervals();
    statusListener(ZONES);
    await injectFailure(panel, POLL, { status: 500 });

    await expect(pollOnce()).rejects.toMatchObject({ message: 'Request failed with status code 500' });

    expect(logs.error).toHaveLength(1);
  });

  it('KNOWN BUG KB-27: a poll that fails after stop() rejects the timer callback', async () => {
    const { panel, statusListener } = await boot();
    const pollOnce = captureIntervals();
    const listener = statusListener(ZONES);
    panel.respondWith(POLL, { hang: true }, { times: 1 });
    const outcome = expect(pollOnce()).rejects.toMatchObject({ code: 'ECONNRESET' });
    await waitFor(() => panel.requestsTo(POLL).length === 1, { message: 'the poll' });

    listener.stop();
    await panel.stop();

    await outcome;
  });

  it('KNOWN BUG KB-27: a throwing listener aborts the poll, so the same change is announced again next time', async () => {
    const { panel, statusListener } = await boot();
    const pollOnce = captureIntervals();
    const listener = statusListener(ZONES);
    const events = [];
    let failNext = true;
    listener.on('armedChanged', (armed) => {
      events.push(['armedChanged', armed]);
      if (failNext) {
        failNext = false;
        throw new Error('listener failed');
      }
    });
    listener.on('sensorChanged', (index, open) => events.push(['sensorChanged', index, open]));
    panel.setStatus({ statuszone: [1, 0], useraccess: [2, 0] });

    await expect(pollOnce()).rejects.toThrow('listener failed');
    expect(events).toEqual([['armedChanged', true]]);

    await pollOnce();
    expect(events).toEqual([['armedChanged', true], ['armedChanged', true], ['sensorChanged', '0', true]]);
  });

  it('KNOWN BUG KB-27: a throwing sensor listener silences the later sensors of that poll until the next one', async () => {
    const { panel, statusListener } = await boot();
    const pollOnce = captureIntervals();
    const listener = statusListener(ZONES);
    const events = [];
    let failNext = true;
    listener.on('armedChanged', (armed) => events.push(['armedChanged', armed]));
    listener.on('sensorChanged', (index, open) => {
      events.push(['sensorChanged', index, open]);
      if (failNext) {
        failNext = false;
        throw new Error('listener failed');
      }
    });
    panel.setStatus({ statuszone: [1, 1], useraccess: [2, 0] });

    await expect(pollOnce()).rejects.toThrow('listener failed');
    expect(events).toEqual([['armedChanged', true], ['sensorChanged', '0', true]]);

    await pollOnce();
    expect(events).toEqual([
      ['armedChanged', true], ['sensorChanged', '0', true],
      ['armedChanged', true], ['sensorChanged', '0', true], ['sensorChanged', '1', true],
    ]);
  });
});

describe('with the real login()', () => {
  it('KNOWN BUG KB-2: a disabled zone before an enabled one shifts which status slot a sensor reads', async () => {
    const { panel, watch, tick } = await bootLoggedIn({ zones: [[1, 'Door'], [0, ' '], [1, 'Hall']] });
    const { zoneTuples } = await require('../../src/api/login.js').login();
    expect(zoneTuples).toEqual([[1, 'Door'], [1, 'Hall']]);
    const { events } = watch(zoneTuples);

    panel.setStatus({ statuszone: [0, 0, 1, ...Array(29).fill(0)], useraccess: [1, 0] });
    await tick();
    expect(events).toEqual([['armedChanged', false]]);

    panel.setStatus({ statuszone: [0, 1, 0, ...Array(29).fill(0)] });
    await tick();
    expect(events).toEqual([['armedChanged', false], ['sensorChanged', '1', true]]);
  });
});
