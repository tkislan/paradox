import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { hex_md5, keeplowbyte, rc4 } from '../../src/paradox.js';
import { loadSpec, setBridgeEnv } from '../support.ts';
import { CryptoSpec } from '../spec/schemas.ts';

const require = createRequire(import.meta.url);

const spec = loadSpec('crypto', CryptoSpec);

describe('hex_md5', () => {
  it.each(spec.hex_md5)('$name', ({ input, expected }) => {

    expect(hex_md5(input)).toBe(expected);
  });
});

describe('keeplowbyte', () => {
  it.each(spec.keeplowbyte)('$name', ({ input, expected }) => {

    expect(keeplowbyte(input)).toBe(expected);
  });
});

describe('rc4 (firmware variant)', () => {
  it.each(spec.rc4)('$name', ({ key, text, expected }) => {

    expect(rc4(key, text)).toBe(expected);
  });
});

describe('rc4 (firmware variant) is not classic RC4', () => {
  it.each(spec.rc4.filter((c) => c.not_classic_rc4))('$name', ({ key, text, not_classic_rc4: classic }) => {

    expect(rc4(key, text)).not.toBe(classic);
  });
});

describe('encryptCredentials', () => {
  it.each(spec.credentials)('$name', ({ session, username, password, u, p }) => {
    setBridgeEnv({ USERNAME: username, PASSWORD: password });
    const { encryptCredentials } = require('../../src/api/login.js');

    expect(encryptCredentials(session)).toEqual([u, p]);
  });
});
