import { describe, expect, it } from 'vitest';
import { loadBridge, loadSpec, rowTitle, setBridgeEnv } from '../support.js';

const spec = loadSpec('config');

const cases = (rows) => rows.map((row) => [rowTitle(row), row]);

function loadConfig({ unset = [], set = {} } = {}) {
  const unsetEnv = Object.fromEntries(unset.map((key) => [key, undefined]));
  setBridgeEnv({ ...spec.valid_env, ...set, ...unsetEnv });
  return loadBridge().load('config.js');
}

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
