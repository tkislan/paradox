import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const SRC_DIR = fileURLToPath(new URL('./src/', import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
    // Tests import src/ through Node itself, as the code under test requires its own modules: with vitest's loader
    // in between, one file would be loaded both ways and v8 coverage loses lines when merging the two.
    server: { deps: { external: [new RegExp(`^${RegExp.escape(SRC_DIR)}`)] } },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      reportsDirectory: 'tests/coverage',
      reporter: [['text', { skipFull: false }], 'html', 'json-summary'],
      // Uncovered are dead code and what the suite leaves out on purpose (see README); a drop below this means a
      // behavior lost its tests.
      thresholds: { lines: 94, statements: 93, functions: 82, branches: 95 },
    },
  },
});
