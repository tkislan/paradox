import { inspect } from 'node:util';
import { expect } from 'vitest';

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
  const result = { state: 'pending' };
  promise.then(
    (value) => Object.assign(result, { state: 'resolved', value }),
    (error) => Object.assign(result, { state: 'rejected', error }),
  );
  return result;
}

/** Fails if the hashed panel credentials show up anywhere in `value`, however deeply nested. */
export function expectNoCredentials(value, { u, p }: { u: string; p: string }) {
  const text = inspect(value, { depth: null });

  expect(text).not.toContain(u);
  expect(text).not.toContain(p);
}
