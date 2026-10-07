import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  BUILD_DIR, captureConsole, isolateProcessListeners, loadBridge, loadSpec, onCleanup, settle, spyProcessExit, waitFor,
} from '../support.js';

const { signals } = loadSpec('util');
const SIGNAL_NAMES = signals.map(({ signal }) => signal);

function deferred() {
  const handle = {};
  handle.promise = new Promise((resolve, reject) => {
    handle.resolve = resolve;
    handle.reject = reject;
  });
  return handle;
}

function install(callback) {
  isolateProcessListeners();
  const logged = captureConsole();
  const exit = spyProcessExit();
  loadBridge().load('signal.js').setupSignalHandler(callback);
  const exitCodes = () => exit.mock.calls.map((args) => args[0]);
  return { logged, exit, exitCodes };
}

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
  // A real child process and real OS signals; every test above only simulates them with process.emit.
  const childScript = (shutdown) => `
    const { setupSignalHandler } = require(${JSON.stringify(path.join(BUILD_DIR, 'signal.js'))});
    setupSignalHandler(() => ${shutdown});
    console.log('ready');
    setInterval(() => {}, 1000);
  `;

  async function runUntilSignalled(shutdown, signal) {
    const child = spawn(process.execPath, ['-e', childScript(shutdown)], { stdio: ['ignore', 'pipe', 'pipe'] });
    onCleanup(() => child.kill('SIGKILL'));
    const output = { stdout: '', stderr: '' };
    child.stdout.on('data', (chunk) => { output.stdout += chunk; });
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });
    const exited = new Promise((resolve) => child.once('close', (code, killedBy) => resolve({ code, killedBy })));

    await waitFor(() => output.stdout.includes('ready'), { message: 'the child to install its handler' });
    child.kill(signal);
    const result = await exited;
    return { ...result, ...output };
  }

  it.each(signals)('$signal ends the process with exit code $exit_code after the callback resolved', async ({ signal, exit_code: exitCode }) => {
    const result = await runUntilSignalled('new Promise((resolve) => setTimeout(resolve, 50))', signal);

    expect(result.code).toBe(exitCode);
    expect(result.killedBy).toBeNull();
    expect(result.stdout).toBe(`ready\nProcess received a ${signal} signal\n`);
  });

  it.each([
    ['throws', '(() => { throw new Error("stop() blew up"); })()', 'Error: stop() blew up'],
    ['returns a non-promise', 'undefined', 'TypeError'],
  ])('KNOWN BUG KB-43: a callback that %s crashes the process with exit code 1 instead of 143', async (_what, shutdown, stderrText) => {
    const result = await runUntilSignalled(shutdown, 'SIGTERM');

    expect(result.code).toBe(1);
    expect(result.killedBy).toBeNull();
    expect(result.stderr).toContain(stderrText);
  });

  it('SIGTERM still exits with 143, after printing the error, when the callback rejects', async () => {
    const result = await runUntilSignalled('Promise.reject(new Error("cleanup failed"))', 'SIGTERM');

    expect(result.code).toBe(143);
    expect(result.stderr).toContain('cleanup failed');
  });
});
