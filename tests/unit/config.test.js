import { describe, expect, it } from 'vitest';
import { cases } from '../support.js';
import { loadConfig, spec } from '../helpers/config.js';

describe('config', () => {
  describe('with a missing variable', () => {
    it.each(cases(spec.missing))('%s', (_title, { unset, error }) => {
      expect(() => loadConfig({ unset })).toThrow(new Error(error));
    });
  });

  describe('with every variable set', () => {
    it.each(cases(spec.accepted))('%s', (_title, { set, expected }) => {
      expect(loadConfig({ set })).toStrictEqual(expected);
    });

    it('reads the environment once, when the module is loaded', () => {
      const config = loadConfig();

      process.env.HOSTNAME = 'changed.example';
      delete process.env.PORT;

      expect(config.HOSTNAME).toBe(spec.valid_env.HOSTNAME);
      expect(config.PORT).toBe(spec.valid_env.PORT);
    });
  });
});
