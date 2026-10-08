import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  BUILD_DIR, captureConsole, isolateProcessListeners, loadBridge, loadSpec, onCleanup, spyProcessExit, waitFor,
} from '../support.js';

export const { signals } = loadSpec('util');

export const SIGNAL_NAMES = signals.map(({ signal }) => signal);

export function deferred() {
  const handle = {};
  handle.promise = new Promise((resolve, reject) => {
    handle.resolve = resolve;
    handle.reject = reject;
  });
  return handle;
}

export function install(callback) {
  isolateProcessListeners();
  const logged = captureConsole();
  const exit = spyProcessExit();
  loadBridge().load('signal.js').setupSignalHandler(callback);
  const exitCodes = () => exit.mock.calls.map((args) => args[0]);
  return { logged, exit, exitCodes };
}

const childScript = (shutdown) => `
  const { setupSignalHandler } = require(${JSON.stringify(path.join(BUILD_DIR, 'signal.js'))});
  setupSignalHandler(() => ${shutdown});
  console.log('ready');
  setInterval(() => {}, 1000);
`;

/** Runs the bridge's signal handler in a real child process, sends it `signal`, and reports how it ended. */
export async function runUntilSignalled(shutdown, signal) {
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
