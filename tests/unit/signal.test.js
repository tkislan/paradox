import { describe, expect, it, vi } from 'vitest';
import { loadBridge, settle, waitFor } from '../support.js';
import { SIGNAL_NAMES, deferred, install, runUntilSignalled, signals } from '../helpers/signal.js';

describe('SIGNALS', () => {
  it('maps the handled signal names to their numbers', () => {
    const { SIGNALS } = loadBridge().load('signal.js');

    expect(SIGNALS).toStrictEqual(Object.fromEntries(signals.map(({ signal, number }) => [signal, number])));
  });
});

describe('setupSignalHandler', () => {
  it('adds one listener each for SIGHUP, SIGINT and SIGTERM and for no other signal', () => {
    const others = ['SIGQUIT', 'SIGUSR2', 'SIGPIPE', 'SIGALRM'];
    const countsBefore = Object.fromEntries([...SIGNAL_NAMES, ...others].map((name) => [name, process.listenerCount(name)]));

    install(() => Promise.resolve());

    for (const name of SIGNAL_NAMES) expect(process.listenerCount(name)).toBe(countsBefore[name] + 1);
    for (const name of others) expect(process.listenerCount(name)).toBe(countsBefore[name]);
  });

  it('does nothing until a signal arrives', async () => {
    const callback = vi.fn(() => Promise.resolve());
    const { exit, logged } = install(callback);

    await settle();

    expect(callback).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(logged.log).toEqual([]);
  });

  describe.each(signals)('on $signal', ({ signal, exit_code: exitCode }) => {
    it(`runs the callback once, logs the signal and exits with ${exitCode} once the callback resolved`, async () => {
      const callback = vi.fn(() => Promise.resolve('ignored result'));
      const { exit, logged } = install(callback);

      process.emit(signal);

      expect(logged.log).toEqual([[`Process received a ${signal} signal`]]);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0]).toEqual([]);
      await waitFor(() => exit.mock.calls.length > 0, { message: 'process.exit' });
      expect(exit.mock.calls).toEqual([[exitCode]]);
      expect(logged.error).toEqual([]);
    });

    it(`logs the error and still exits with ${exitCode} when the callback rejects`, async () => {
      const failure = new Error('shutdown failed');
      const { exit, logged } = install(() => Promise.reject(failure));

      process.emit(signal);

      await waitFor(() => exit.mock.calls.length > 0, { message: 'process.exit' });
      expect(exit.mock.calls).toEqual([[exitCode]]);
      expect(logged.error).toHaveLength(1);
      expect(logged.error[0]).toHaveLength(1);
      expect(logged.error[0][0]).toBe(failure);
    });
  });

  it('does not exit before the callback has settled, and logs a rejection before exiting', async () => {
    const shutdown = deferred();
    const { exit, logged } = install(() => shutdown.promise);

    process.emit('SIGTERM');
    await settle();

    expect(exit).not.toHaveBeenCalled();

    shutdown.reject(new Error('late failure'));
    await waitFor(() => exit.mock.calls.length > 0, { message: 'process.exit' });

    expect(console.error.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
    expect(logged.error).toHaveLength(1);
  });

  it('exits with the same code when the callback rejects with something that is not an Error', async () => {
    const { exit, logged } = install(() => Promise.reject('plain text'));

    process.emit('SIGINT');

    await waitFor(() => exit.mock.calls.length > 0, { message: 'process.exit' });
    expect(exit.mock.calls).toEqual([[130]]);
    expect(logged.error).toEqual([['plain text']]);
  });
});

describe('with real signals', () => {
  // A real child process and real OS signals; every test above only simulates them with process.emit.
  it.each(signals)('$signal ends the process with exit code $exit_code after the callback resolved', async ({ signal, exit_code: exitCode }) => {
    const result = await runUntilSignalled('new Promise((resolve) => setTimeout(resolve, 50))', signal);

    expect(result.code).toBe(exitCode);
    expect(result.killedBy).toBeNull();
    expect(result.stdout).toBe(`ready\nProcess received a ${signal} signal\n`);
  });

  it('SIGTERM still exits with 143, after printing the error, when the callback rejects', async () => {
    const result = await runUntilSignalled('Promise.reject(new Error("cleanup failed"))', 'SIGTERM');

    expect(result.code).toBe(143);
    expect(result.stderr).toContain('cleanup failed');
  });
});
