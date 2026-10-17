import { describe, expect, it } from 'vitest';
import { deepArrayEqual } from '../../src/util.js';
import { cases, loadKnownBugSpec } from '../support.ts';
import { expectDeepArrayEqual } from '../helpers/util.ts';
import { KnownBugUtilSpec } from '../spec/schemas.ts';

const spec = loadKnownBugSpec('util', KnownBugUtilSpec);

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
