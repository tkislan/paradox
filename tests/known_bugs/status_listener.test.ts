import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  captureConsole, loadKnownBugSpec, setBridgeEnv, useFakeClock, withTitle,
} from '../support.ts';
import { ZONES, boot, expectPollEvents } from '../helpers/status_listener.ts';
import { KnownBugStatusMachineSpec } from '../spec/schemas.ts';

const require = createRequire(import.meta.url);

const spec = loadKnownBugSpec('status_machine', KnownBugStatusMachineSpec);

describe('poll scenarios (spec/known_bugs/status_machine.json)', () => {
  const groups = ['first_poll', 'armed_codes'] as const;

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

    statusListener([[1, 'A'], [0, ' '], [1, 'B']]);

    const startup = emit.mock.calls.filter(([name]) => name === 'armedChanged' || name === 'sensorChanged');
    expect(startup).toEqual([
      ['armedChanged', null],
      ['sensorChanged', '0', false],
      ['sensorChanged', '2', false],
    ]);
  });
});

describe('exceptions inside a poll', () => {
  it('KNOWN BUG KB-27: a throwing listener aborts the poll, so the same change is announced again next time', async () => {
    const { panel, statusListener, tick } = await boot();
    const listener = statusListener(ZONES);
    const events: unknown[][] = [];
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

    await tick();
    expect(events).toEqual([['armedChanged', true]]);

    await tick();
    expect(events).toEqual([['armedChanged', true], ['armedChanged', true], ['sensorChanged', '0', true]]);
  });

  it('KNOWN BUG KB-27: a throwing sensor listener silences the later sensors of that poll until the next one', async () => {
    const { panel, statusListener, tick } = await boot();
    const listener = statusListener(ZONES);
    const events: unknown[][] = [];
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

    await tick();
    expect(events).toEqual([['armedChanged', true], ['sensorChanged', '0', true]]);

    await tick();
    expect(events).toEqual([
      ['armedChanged', true], ['sensorChanged', '0', true],
      ['armedChanged', true], ['sensorChanged', '0', true], ['sensorChanged', '1', true],
    ]);
  });
});
