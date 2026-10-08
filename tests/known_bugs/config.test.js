import { describe, expect, it } from 'vitest';
import { cases, loadKnownBugSpec } from '../support.js';
import { loadConfig } from '../helpers/config.js';

const spec = loadKnownBugSpec('config');

describe('config', () => {
  describe('with a missing variable', () => {
    it.each(cases(spec.missing))('%s', (_title, { unset, error }) => {
      expect(() => loadConfig({ unset })).toThrow(new Error(error));
    });
  });
});
