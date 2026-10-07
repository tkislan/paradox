import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { FakePanel } from '../mock_paradox.js';
import {
  captureConsole, loadBridge, loadSpec, onCleanup, setBridgeEnv, settle, useFakeClock, waitFor, withTitle,
} from '../support.js';
import { drain, holdNextResponse, injectFailure, servePage } from './status_listener_support.js';

const spec = loadSpec('status_machine');
const golden = loadSpec('crypto').credentials[0];

const POLL = '/statuslive.html';
const POLL_LINE = 'GET /statuslive.html';
const ZONES = [[1, 'A'], [1, 'B']];

/**
 * A fake panel, a fake clock and a freshly loaded status_listener.js. `watch(zones)` starts a
 * listener and records what it emits; `tick(n)` advances 1000 ms and waits for the n polls it triggers.
 */
async function boot(panelOptions = {}, env = {}) {
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
function captureIntervals() {
  const spy = vi.spyOn(globalThis, 'setInterval');
  // Must be undone before useFakeClock's own cleanup, or the restored spy would put the fake timer back.
  onCleanup(() => spy.mockRestore());
  return () => spy.mock.calls.at(-1)[0]();
}

async function startListener(zones, panelOptions) {
  const env = await boot(panelOptions);
  return { ...env, ...env.watch(zones) };
}

/** A panel that answers data pages only after the real login() has run against it. */
function bootLoggedIn(panelOptions = {}) {
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

async function applyPoll(panel, poll) {
  if (poll.fail) return injectFailure(panel, POLL, poll.fail);
  if (poll.page) servePage(panel, POLL, poll.page);
  else panel.setStatus(poll);
  return async () => {};
}

describe('poll scenarios (spec/status_machine.json)', () => {
  const groups = ['first_poll', 'armed_codes', 'sensor_codes', 'transitions', 'zone_indexing', 'failures'];

  describe.each(groups)('%s', (group) => {
    it.each(withTitle(spec[group]))('$title', async ({ zones, polls, expected_events }) => {
      const { panel, events, tick } = await startListener(zones);

      for (const poll of polls) {
        const restore = await applyPoll(panel, poll);
        await tick();
        await restore();
      }

      await settle();
      expect(events).toEqual(expected_events);
      expect([...new Set(panel.requestLines)]).toEqual([POLL_LINE]);
    });
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

  it('KNOWN BUG KB-4: the constructor emits the assumed initial state before anyone can listen', async () => {
    captureConsole();
    setBridgeEnv();
    useFakeClock();
    const { statusListener } = loadBridge().load('status_listener.js');
    const emit = vi.spyOn(EventEmitter.prototype, 'emit');

    statusListener([[1, 'A'], [1, 'B']]);

    const startup = emit.mock.calls.filter(([name]) => name === 'armedChanged' || name === 'sensorChanged');
    expect(startup).toEqual([
      ['armedChanged', null],
      ['sensorChanged', '0', false],
      ['sensorChanged', '1', false],
    ]);
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

  it('KNOWN BUG KB-12: once the session has expired every poll fails and nothing logs in again', async () => {
    const { panel, bridge, watch, tick } = await bootLoggedIn();
    const { zoneTuples } = await bridge.load('api/login.js').login();
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
    const { panel, bridge, watch, tick } = await bootLoggedIn({ zones: [[1, 'Door'], [0, ' '], [1, 'Hall']] });
    const { zoneTuples } = await bridge.load('api/login.js').login();
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
