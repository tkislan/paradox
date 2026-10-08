import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: [...configDefaults.exclude, 'tests/.mutants/**'],
    globalSetup: ['tests/global_setup.js'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      // Babel output of src/; source maps point the report back at src/*.js.
      include: ['tests/.build/**/*.js'],
      reportsDirectory: 'tests/coverage',
      reporter: [['text', { skipFull: false }], 'html', 'json-summary'],
    },
  },
});
