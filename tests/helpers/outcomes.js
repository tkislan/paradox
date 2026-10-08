export async function rejection(promise) {
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
