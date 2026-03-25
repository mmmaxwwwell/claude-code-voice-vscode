import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default', './scripts/vitest-json-reporter.mjs'],
  },
});
