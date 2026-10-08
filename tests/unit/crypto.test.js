import { describe, expect, it } from 'vitest';
import { loadBridge, loadSpec, setBridgeEnv } from '../support.js';

const spec = loadSpec('crypto');

describe('hex_md5', () => {
  it.each(spec.hex_md5)('$name', ({ input, expected }) => {
    const { hex_md5 } = loadBridge().load('paradox.js');

    expect(hex_md5(input)).toBe(expected);
  });
});

describe('keeplowbyte', () => {
  it.each(spec.keeplowbyte)('$name', ({ input, expected }) => {
    const { keeplowbyte } = loadBridge().load('paradox.js');

    expect(keeplowbyte(input)).toBe(expected);
  });
});

describe('rc4 (firmware variant)', () => {
  it.each(spec.rc4)('$name', ({ key, text, expected }) => {
    const { rc4 } = loadBridge().load('paradox.js');

    expect(rc4(key, text)).toBe(expected);
  });
});

describe('rc4 (firmware variant) is not classic RC4', () => {
  it.each(spec.rc4.filter((c) => c.not_classic_rc4))('$name', ({ key, text, not_classic_rc4: classic }) => {
    const { rc4 } = loadBridge().load('paradox.js');

    expect(rc4(key, text)).not.toBe(classic);
  });
});

describe('encryptCredentials', () => {
  it.each(spec.credentials)('$name', ({ session, username, password, u, p }) => {
    setBridgeEnv({ USERNAME: username, PASSWORD: password });
    const { encryptCredentials } = loadBridge().load('api/login.js');

    expect(encryptCredentials(session)).toEqual([u, p]);
  });
});
