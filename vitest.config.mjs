import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: [...configDefaults.exclude, 'tests/.mutants/**'],
    globalSetup: ['tests/global_setup.js'],
    restoreMocks: true,
    // A test may wait up to a minute for a free broker (mosquitto.js), and its cleanup talks to the broker too.
    hookTimeout: 90000,
    coverage: {
      provider: 'v8',
      // Babel output of src/; source maps point the report back at src/*.js.
      include: ['tests/.build/**/*.js'],
      reportsDirectory: 'tests/coverage',
      reporter: [['text', { skipFull: false }], 'html', 'json-summary'],
      // Only dead code in src/ is uncovered (see README); a drop below this means a behavior lost its tests.
      thresholds: { lines: 98, statements: 98, functions: 96, branches: 97 },
    },
  },
});
