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
    // A test may wait up to a minute for a free broker (mosquitto.js), and its cleanup talks to the broker too.
    hookTimeout: 90000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      reportsDirectory: 'tests/coverage',
      reporter: [['text', { skipFull: false }], 'html', 'json-summary'],
      // Only dead code in src/ is uncovered (see README); a drop below this means a behavior lost its tests.
      thresholds: { lines: 98, statements: 98, functions: 96, branches: 97 },
    },
  },
});
