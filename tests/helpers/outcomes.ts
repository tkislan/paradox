import { inspect } from 'node:util';
import { expect } from 'vitest';
import { settle, useFakeClock, waitFor } from '../support.ts';

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
 * Calls `call` on a fake clock while the panel leaves every request to `pathname` unanswered, and checks that the call
 * rejects 10000 ms after it was made, not a millisecond earlier, having sent that one request.
 */
export async function expectTimeout(panel, pathname: string, call: () => Promise<unknown>) {
  panel.respondWith(pathname, { hang: true });
  const clock = useFakeClock();
  const outcome = track(call());
  await waitFor(() => panel.requestsTo(pathname).length === 1, { message: `the request to ${pathname}` });

  await clock.advance(9999);
  await settle();
  expect(outcome.state).toBe('pending');

  await clock.advance(1);
  await waitFor(() => outcome.state !== 'pending', { message: 'the call to time out' });
  expect(outcome.state).toBe('rejected');
  expect(outcome.error.message).toBe('timeout of 10000ms exceeded');
  expect(panel.requests).toHaveLength(1);
}

/** Fails if the hashed panel credentials show up anywhere in `value`, however deeply nested. */
export function expectNoCredentials(value, { u, p }: { u: string; p: string }) {
  const text = inspect(value, { depth: null });

  expect(text).not.toContain(u);
  expect(text).not.toContain(p);
}
