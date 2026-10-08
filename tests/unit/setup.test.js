import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Placeholder that proves the wiring: vitest runs, global_setup.js compiled src/ with Babel into tests/.build,
// and the compiled output loads. Replace it with real tests.
describe('test setup', () => {
  it('loads the compiled bridge code', () => {
    const { retry } = createRequire(import.meta.url)('../.build/util.js');

    expect(retry).toBeTypeOf('function');
  });
});
