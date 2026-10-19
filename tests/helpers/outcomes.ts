import { inspect } from 'node:util';
import { expect } from 'vitest';
import type { PanelResult } from '../mock_paradox.ts';
import { settle, useFakeClock, waitFor } from '../support.ts';
import { ignoreNextConnection } from './panel_faults.ts';

/** The reason `promise` rejects with, whatever was thrown. */
export async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

/** Observes a promise without awaiting it, so fake-clock tests can assert "still pending" at a given instant. */
export function track(promise) {
  const result: { state: string; value?: unknown; error?: any } = { state: 'pending' };
  promise.then(
    (value) => Object.assign(result, { state: 'resolved', value }),
    (error) => Object.assign(result, { state: 'rejected', error }),
  );
  return result;
}

/**
 * Calls `call` on a fake clock while the panel answers every request to `pathname` with `fault` (by default it never
 * answers), and checks that the call rejects 20000 ms after it was made, not a millisecond earlier, having sent that
 * one request, and that the connection to the panel is then closed.
 */
export async function expectTimeout(panel, pathname: string, call: () => Promise<unknown>, fault: PanelResult = { hang: true }) {
  panel.respondWith(pathname, fault);
  const clock = useFakeClock();
  const outcome = track(call());
  await waitFor(() => panel.requestsTo(pathname).length === 1, { message: `the request to ${pathname}` });

  await clock.advance(19999);
  await settle();
  expect(outcome.state).toBe('pending');

  await clock.advance(1);
  await waitFor(() => outcome.state !== 'pending', { message: 'the call to time out' });
  expect(outcome.state).toBe('rejected');
  expect(outcome.error.message).toBe('timeout of 20000ms exceeded');
  expect(panel.requests).toHaveLength(1);
  await waitFor(() => panel.sockets.size === 0, { message: 'the panel connection to close' });
}

/**
 * Calls `call` on a fake clock while its connection to the panel never opens, and checks that the call rejects 2000 ms
 * after it was made, not a millisecond earlier, with the panel having seen no request, and that the stuck connection
 * is then closed.
 */
export async function expectConnectTimeout(panel, call: () => Promise<unknown>) {
  const connect = ignoreNextConnection();
  const clock = useFakeClock();
  const outcome = track(call());
  await waitFor(() => connect.mock.calls.length === 1, { message: 'the connection attempt' });

  await clock.advance(1999);
  await settle();
  expect(outcome.state).toBe('pending');

  await clock.advance(1);
  await waitFor(() => outcome.state !== 'pending', { message: 'the call to time out' });
  expect(outcome.state).toBe('rejected');
  expect(outcome.error).toMatchObject({ message: 'connect timeout of 2000ms exceeded', code: 'ETIMEDOUT' });
  expect(panel.requests).toHaveLength(0);
  expect(connect.mock.contexts[0]).toHaveProperty('destroyed', true);
}

/** Fails if the hashed panel credentials show up anywhere in `value`, however deeply nested. */
export function expectNoCredentials(value, { u, p }: { u: string; p: string }) {
  const text = inspect(value, { depth: null, maxArrayLength: Infinity, maxStringLength: Infinity, showHidden: true });

  expect(text).not.toContain(u);
  expect(text).not.toContain(p);
}
