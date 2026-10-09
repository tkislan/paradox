import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Placeholder that proves the wiring: vitest runs and src/ loads as it is. Replace it with real tests.
describe('test setup', () => {
  it('loads the compiled bridge code', () => {
    const { retry } = createRequire(import.meta.url)('../../src/util.js');

    expect(retry).toBeTypeOf('function');
  });
});
