import { describe, expect, it, vi } from 'vitest';
import { deepArrayEqual, getJsValue, retry } from '../../src/util.js';
import { cases, loadKnownBugSpec, useFakeClock, waitFor } from '../support.ts';
import { expectDeepArrayEqual, expectJsValue, expectTuples } from '../helpers/util.ts';

const spec = loadKnownBugSpec('util');

describe('deepArrayEqual', () => {
  it.each(cases(spec.deepArrayEqual))('%s', (_title, row) => expectDeepArrayEqual(row));

  it('KNOWN BUG KB-6: nested arrays are equal only when they are the very same object', () => {
    const inner = [1];

    expect(deepArrayEqual([inner], [inner])).toBe(true);
    expect(deepArrayEqual([inner], [[1]])).toBe(false);
  });

  it('KNOWN BUG KB-6: NaN elements are never equal, not even in the same array', () => {
    const withNaN = [1, NaN];

    expect(deepArrayEqual(withNaN, withNaN)).toBe(false);
    expect(deepArrayEqual([NaN], [NaN])).toBe(false);
  });
});

describe('getJsValue', () => {
  it.each(cases(spec.getJsValue))('%s', (_title, row) => expectJsValue(row));

  it('KNOWN BUG KB-23: `new Array(7)` is seven empty slots, not [7]', () => {

    const value = getJsValue('x=new Array(7)', /x=(.*)/);

    expect(value).toHaveLength(7);
    expect(Object.keys(value)).toEqual([]);
    expect(getJsValue('x=new Array("7")', /x=(.*)/)).toEqual(['7']);
    expect(getJsValue('x=new Array(7,8)', /x=(.*)/)).toEqual([7, 8]);
  });
});

describe('iterateTuples', () => {
  it.each(cases(spec.iterateTuples))('%s', (_title, row) => expectTuples(row));
});

describe('retry', () => {
  it('KNOWN BUG KB-5: retries run back to back, the wait time is never used', async () => {
    useFakeClock();
    const pendingTimersAtCall: number[] = [];
    // retry() resolves with f's value, although its JSDoc types f as returning Promise<void>.
    const f = vi.fn(async (): Promise<any> => {
      pendingTimersAtCall.push(vi.getTimerCount());
      if (f.mock.calls.length < 4) throw new Error('not yet');
      return 'ok';
    });
    let result;
    retry(10, 1000, f).then((value) => { result = value; });

    // The fake clock never advances: a retry that slept 1000 ms between attempts could not finish.
    await waitFor(() => result, { timeout: 500, message: 'retry to finish without any waiting' });

    expect(result).toBe('ok');
    expect(f).toHaveBeenCalledTimes(4);
    expect(pendingTimersAtCall).toEqual([0, 0, 0, 0]);
  });
});
