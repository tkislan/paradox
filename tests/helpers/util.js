import { expect } from 'vitest';
import { loadBridge, specText } from '../support.js';

export const loadUtil = () => loadBridge().load('util.js');

export function expectDeepArrayEqual({ a, b, expected }) {
  const { deepArrayEqual } = loadUtil();

  expect(deepArrayEqual(a, b)).toBe(expected);
}

export function expectJsValue({ content, pattern, expected }) {
  const { getJsValue } = loadUtil();

  // toEqual, not toStrictEqual: the array is built in the vm's own realm.
  expect(getJsValue(specText(content), new RegExp(pattern))).toEqual(expected);
}

export function expectTuples({ list, expected }) {
  const { iterateTuples } = loadUtil();

  expect(Array.from(iterateTuples(list))).toEqual(expected);
}

/** A stand-in for an async function whose successive calls throw or return as `attempts` says, counting calls in `.calls`. */
export function scripted(attempts) {
  const f = async () => {
    const attempt = attempts[f.calls];
    f.calls += 1;
    if (!attempt) throw new Error('script exhausted');
    if ('throws' in attempt) throw new Error(attempt.throws);
    return attempt.returns;
  };
  f.calls = 0;
  return f;
}
