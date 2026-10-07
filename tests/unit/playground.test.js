import { describe, expect, it } from 'vitest';
import { captureConsole, loadBridge, loadSpec, setBridgeEnv } from '../support.js';

const playgroundRow = loadSpec('crypto').credentials.find(({ name }) => name === 'playground session');

describe('playground', () => {
  it('prints the credentials for its fixed session value as one [u, p] array and nothing else', () => {
    const logged = captureConsole();
    setBridgeEnv({ USERNAME: playgroundRow.username, PASSWORD: playgroundRow.password });

    loadBridge().load('playground.js');

    expect(logged.log).toEqual([[[playgroundRow.u, playgroundRow.p]]]);
    expect(logged.warn).toEqual([]);
    expect(logged.error).toEqual([]);
  });
});
