import { describe, expect, it, vi } from 'vitest';
import { waitFor } from '../support.js';
import { deferred, install, runUntilSignalled } from '../helpers/signal.js';

describe('setupSignalHandler', () => {
  it('KNOWN BUG KB-42: a second signal runs the shutdown callback again', async () => {
    const shutdowns = [];
    const callback = vi.fn(() => {
      const shutdown = deferred();
      shutdowns.push(shutdown);
      return shutdown.promise;
    });
    const { exit, exitCodes } = install(callback);

    process.emit('SIGINT');
    process.emit('SIGTERM');
    process.emit('SIGTERM');

    expect(callback).toHaveBeenCalledTimes(3);
    shutdowns[1].resolve();
    await waitFor(() => exit.mock.calls.length === 1, { message: 'the first exit' });
    shutdowns[0].resolve();
    shutdowns[2].resolve();
    await waitFor(() => exit.mock.calls.length === 3, { message: 'all three exits' });
    expect(exitCodes()).toEqual([143, 130, 143]);
  });

  it('KNOWN BUG KB-43: a callback that throws instead of rejecting escapes the listener and never exits', () => {
    const failure = new Error('stop() blew up');
    const { exit, logged } = install(() => { throw failure; });

    expect(() => process.emit('SIGTERM')).toThrow(failure);
    expect(logged.log).toEqual([['Process received a SIGTERM signal']]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('KNOWN BUG KB-43: a callback that returns a non-promise makes the listener throw a TypeError', () => {
    const { exit } = install(() => undefined);

    expect(() => process.emit('SIGHUP')).toThrow(TypeError);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('with real signals', () => {
  it.each([
    ['throws', '(() => { throw new Error("stop() blew up"); })()', 'Error: stop() blew up'],
    ['returns a non-promise', 'undefined', 'TypeError'],
  ])('KNOWN BUG KB-43: a callback that %s crashes the process with exit code 1 instead of 143', async (_what, shutdown, stderrText) => {
    const result = await runUntilSignalled(shutdown, 'SIGTERM');

    expect(result.code).toBe(1);
    expect(result.killedBy).toBeNull();
    expect(result.stderr).toContain(stderrText);
  });
});
