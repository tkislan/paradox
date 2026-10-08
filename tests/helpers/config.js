import { loadBridge, loadSpec, setBridgeEnv } from '../support.js';

export const spec = loadSpec('config');

export function loadConfig({ unset = [], set = {} } = {}) {
  const unsetEnv = Object.fromEntries(unset.map((key) => [key, undefined]));
  setBridgeEnv({ ...spec.valid_env, ...set, ...unsetEnv });
  return loadBridge().load('config.js');
}
