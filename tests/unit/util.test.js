import { describe, expect, it, vi } from 'vitest';
import {
  captureConsole, loadBridge, loadSpec, rowTitle, settle, specText, spyProcessExit, useFakeClock, waitFor,
} from '../support.js';

const spec = loadSpec('util');

const loadUtil = () => loadBridge().load('util.js');
const cases = (rows) => rows.map((row) => [rowTitle(row), row]);

describe('sleep', () => {
  it('resolves with undefined exactly when the delay has elapsed', async () => {
    const clock = useFakeClock();
    const { sleep } = loadUtil();
    let outcome = 'pending';
    sleep(1000).then((value) => { outcome = { value }; });

    await clock.advance(999);
    expect(outcome).toBe('pending');

    await clock.advance(1);
    expect(outcome).toStrictEqual({ value: undefined });
  });

  it('keeps a separate delay per call', async () => {
    const clock = useFakeClock();
    const { sleep } = loadUtil();
    const done = [];
    sleep(1000).then(() => done.push('long'));
    sleep(250).then(() => done.push('short'));

    await clock.advance(250);
    expect(done).toEqual(['short']);

    await clock.advance(750);
    expect(done).toEqual(['short', 'long']);
  });

  it('resolves on the next timer tick for a zero delay', async () => {
    const clock = useFakeClock();
    const { sleep } = loadUtil();
    let done = false;
    sleep(0).then(() => { done = true; });
    expect(done).toBe(false);

    await clock.advance(0);

    expect(done).toBe(true);
  });
});

describe('deepArrayEqual', () => {
  it.each(cases(spec.deepArrayEqual))('%s', (_title, { a, b, expected }) => {
    const { deepArrayEqual } = loadUtil();

    expect(deepArrayEqual(a, b)).toBe(expected);
  });

  it('treats undefined like a missing array, in either position and in both', () => {
    const { deepArrayEqual } = loadUtil();

    expect(deepArrayEqual(undefined, [1])).toBe(false);
    expect(deepArrayEqual([1], undefined)).toBe(false);
    expect(deepArrayEqual(undefined, undefined)).toBe(false);
    expect(deepArrayEqual()).toBe(false);
  });

  it('arrays of different length are unequal even when the extra elements are undefined', () => {
    const { deepArrayEqual } = loadUtil();

    expect(deepArrayEqual([1, undefined], [1])).toBe(false);
    expect(deepArrayEqual([1], [1, undefined])).toBe(false);
  });

  it('KNOWN BUG KB-6: nested arrays are equal only when they are the very same object', () => {
    const { deepArrayEqual } = loadUtil();
    const inner = [1];

    expect(deepArrayEqual([inner], [inner])).toBe(true);
    expect(deepArrayEqual([inner], [[1]])).toBe(false);
  });

  it('KNOWN BUG KB-6: NaN elements are never equal, not even in the same array', () => {
    const { deepArrayEqual } = loadUtil();
    const withNaN = [1, NaN];

    expect(deepArrayEqual(withNaN, withNaN)).toBe(false);
    expect(deepArrayEqual([NaN], [NaN])).toBe(false);
  });
});

describe('getJsValue', () => {
  it.each(cases(spec.getJsValue))('%s', (_title, { content, pattern, expected }) => {
    const { getJsValue } = loadUtil();

    // toEqual, not toStrictEqual: the array is built in the vm's own realm.
    expect(getJsValue(specText(content), new RegExp(pattern))).toEqual(expected);
  });

  describe('when the regexp does not match', () => {
    it.each(cases(spec.getJsValue_errors))('%s', (_title, { content, pattern, error }) => {
      captureConsole();
      const { getJsValue } = loadUtil();

      expect(() => getJsValue(specText(content), new RegExp(pattern))).toThrow(new Error(error));
    });

    it('logs the searched content and the regexp, then throws', () => {
      const logged = captureConsole();
      const { getJsValue } = loadUtil();

      expect(() => getJsValue('<html>hello</html>', /(z)/gi)).toThrow();
      expect(logged.error).toEqual([['<html>hello</html>'], ['/(z)/gi']]);
    });
  });

  describe('the matched text is JavaScript run in a fresh, empty context', () => {
    it.each(['process', 'require', 'module', 'Buffer', 'setTimeout'])('%s is not defined there', (name) => {
      const { getJsValue } = loadUtil();

      expect(getJsValue(`x=typeof ${name}`, /x=(.*)/)).toBe('undefined');
    });

    it('cannot call into the host process', () => {
      const exit = spyProcessExit();
      const { getJsValue } = loadUtil();

      expect(() => getJsValue('x=process.exit(7)', /x=(.*)/))
        .toThrow(expect.objectContaining({ name: 'ReferenceError', message: 'process is not defined' }));
      expect(exit).not.toHaveBeenCalled();
    });

    // A plain {} sandbox would make this resolve to the host's Function, and process would be reachable.
    it('has no prototype chain into the host, so this.constructor.constructor cannot reach process', () => {
      const { getJsValue } = loadUtil();

      expect(getJsValue('x=this.constructor.constructor("return typeof process")()', /x=(.*)/)).toBe('undefined');
    });

    it('does not keep state between calls or leak into the host', () => {
      const { getJsValue } = loadUtil();

      getJsValue('x=leaked=5', /x=(.*)/);

      expect(getJsValue('x=typeof leaked', /x=(.*)/)).toBe('undefined');
      expect(globalThis.leaked).toBeUndefined();
    });

    it('rethrows syntax errors from the matched text', () => {
      const { getJsValue } = loadUtil();

      expect(() => getJsValue('x=foo(', /x=(.*)/)).toThrow(expect.objectContaining({ name: 'SyntaxError' }));
    });

    it('rethrows runtime errors from the matched text', () => {
      const { getJsValue } = loadUtil();

      expect(() => getJsValue('x=foo', /x=(.*)/))
        .toThrow(expect.objectContaining({ name: 'ReferenceError', message: 'foo is not defined' }));
    });
  });

  it('evaluates to undefined when the regexp has no capture group, or the group is empty or unmatched', () => {
    const { getJsValue } = loadUtil();

    expect(getJsValue('ab', /ab/)).toBeUndefined();
    expect(getJsValue('x=', /x=(.*)/)).toBeUndefined();
    expect(getJsValue('x', /(y)?x/)).toBeUndefined();
  });

  it('KNOWN BUG KB-23: `new Array(7)` is seven empty slots, not [7]', () => {
    const { getJsValue } = loadUtil();

    const value = getJsValue('x=new Array(7)', /x=(.*)/);

    expect(value).toHaveLength(7);
    expect(Object.keys(value)).toEqual([]);
    expect(getJsValue('x=new Array("7")', /x=(.*)/)).toEqual(['7']);
    expect(getJsValue('x=new Array(7,8)', /x=(.*)/)).toEqual([7, 8]);
  });

  it('a global regexp resumes from its lastIndex, so repeated calls walk through the matches', () => {
    captureConsole();
    const { getJsValue } = loadUtil();
    const pattern = /x=(\d)/g;
    const page = 'x=1 x=2 x=3';

    expect(getJsValue(page, pattern)).toBe(1);
    expect(getJsValue(page, pattern)).toBe(2);
    expect(getJsValue(page, pattern)).toBe(3);
    expect(() => getJsValue(page, pattern)).toThrow(new Error('Regex didn\'t match the value'));
    expect(getJsValue(page, pattern)).toBe(1);
  });
});

describe('iterateTuples', () => {
  it.each(cases(spec.iterateTuples))('%s', (_title, { list, expected }) => {
    const { iterateTuples } = loadUtil();

    expect(Array.from(iterateTuples(list))).toEqual(expected);
  });

  it.each(cases(spec.iterateTuples_errors))('rejects %s', (_title, { list, error }) => {
    const { iterateTuples } = loadUtil();

    expect(() => Array.from(iterateTuples(list))).toThrow(new Error(error));
  });

  it('checks the length when iteration starts, not when the generator is created', () => {
    const { iterateTuples } = loadUtil();

    const generator = iterateTuples([1, 'a', 2]);

    expect(() => generator.next()).toThrow(new Error('Invalid list length, should be divisible by tuple size'));
  });

  it('accepts the array getJsValue returns, as login does', () => {
    const { getJsValue, iterateTuples } = loadUtil();
    const zones = getJsValue('z=new Array(1,"Door",0," ",1,"Hall",1,"Attic")', /z=(.*)/);

    expect(Array.from(iterateTuples(zones))).toEqual([[1, 'Door'], [0, ' ']]);
  });
});

describe('retry', () => {
  function scripted(attempts) {
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

  it.each(cases(spec.retry))('%s', async (_title, { max_retries: max, wait_ms: wait, attempts, expected }) => {
    const { retry } = loadUtil();
    const f = scripted(attempts);

    const outcome = await retry(max, wait, f).then(
      (returns) => ({ calls: f.calls, returns }),
      (error) => ({ calls: f.calls, throws: error.message }),
    );

    expect(outcome).toStrictEqual(expected);
  });

  it('passes the extra arguments to every attempt', async () => {
    const { retry } = loadUtil();
    const f = vi.fn().mockRejectedValueOnce(new Error('e1')).mockResolvedValue('ok');

    await retry(3, 0, f, 'a', 7);

    expect(f.mock.calls).toEqual([['a', 7], ['a', 7]]);
  });

  it('retries a function that throws synchronously and accepts a plain return value', async () => {
    const { retry } = loadUtil();
    const f = vi.fn()
      .mockImplementationOnce(() => { throw new Error('sync'); })
      .mockReturnValue('plain');

    expect(await retry(1, 0, f)).toBe('plain');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('gives every call its own retry budget', async () => {
    const { retry } = loadUtil();
    const failsTwice = vi.fn().mockRejectedValueOnce(new Error('e1')).mockRejectedValueOnce(new Error('e2')).mockResolvedValue('first');
    const failsOnce = vi.fn().mockRejectedValueOnce(new Error('e1')).mockResolvedValue('second');

    expect(await retry(2, 0, failsTwice)).toBe('first');
    expect(await retry(2, 0, failsOnce)).toBe('second');
  });

  it('rethrows the very error object of the last attempt', async () => {
    const { retry } = loadUtil();
    const first = new Error('first');
    const last = new Error('last');
    const f = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(last);

    const outcome = await retry(1, 0, f).catch((error) => ({ error }));

    expect(outcome.error).toBe(last);
  });

  it.each([
    ['a string', 'boom'],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { code: 7 }],
  ])('passes a non-Error rejection through unchanged: %s', async (_what, reason) => {
    const { retry } = loadUtil();
    const f = vi.fn().mockRejectedValue(reason);

    const outcome = await retry(1, 0, f).then(() => ({ resolved: true }), (error) => ({ rejected: error }));

    expect(outcome).toHaveProperty('rejected');
    expect(outcome.rejected).toBe(reason);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('starts the next attempt only after the previous one has failed', async () => {
    const { retry } = loadUtil();
    const rejectAttempt = [];
    const f = vi.fn(() => new Promise((_resolve, reject) => { rejectAttempt.push(reject); }));
    const outcome = retry(2, 0, f).catch((error) => error);

    await settle();
    expect(f).toHaveBeenCalledTimes(1);

    rejectAttempt[0](new Error('e1'));
    await waitFor(() => f.mock.calls.length === 2, { message: 'the second attempt' });
    await settle();
    expect(f).toHaveBeenCalledTimes(2);

    rejectAttempt[1](new Error('e2'));
    await waitFor(() => f.mock.calls.length === 3, { message: 'the third attempt' });
    rejectAttempt[2](new Error('e3'));
    expect((await outcome).message).toBe('e3');
  });

  it('KNOWN BUG KB-5: retries run back to back, the wait time is never used', async () => {
    useFakeClock();
    const { retry } = loadUtil();
    const pendingTimersAtCall = [];
    const f = vi.fn(async () => {
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

describe('objectEntries', () => {
  it.each(spec.objectEntries)('$name', ({ object, expected }) => {
    const { objectEntries } = loadUtil();

    expect(objectEntries(object)).toEqual(expected);
  });

  it('lists integer-like keys first in ascending order, then the rest in insertion order', () => {
    const { objectEntries } = loadUtil();

    expect(objectEntries({ b: 'x', 2: 'y', a: 'z', 1: 'w' })).toEqual([['1', 'w'], ['2', 'y'], ['b', 'x'], ['a', 'z']]);
  });

  it('lists only own enumerable string keys', () => {
    const { objectEntries } = loadUtil();
    const object = Object.create({ inherited: 1 });
    object.own = 2;
    Object.defineProperty(object, 'hidden', { value: 3, enumerable: false });
    object[Symbol('s')] = 4;

    expect(objectEntries(object)).toEqual([['own', 2]]);
  });

  it('hands out the values themselves, not copies', () => {
    const { objectEntries } = loadUtil();
    const value = { nested: true };

    expect(objectEntries({ k: value })[0][1]).toBe(value);
  });
});
