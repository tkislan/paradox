import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: [...configDefaults.exclude, 'tests/.mutants/**'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      reportsDirectory: 'tests/coverage',
      reporter: [['text', { skipFull: false }], 'html', 'json-summary'],
    },
  },
});
