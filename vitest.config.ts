import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // each file sets OMNITRIX_HOME; run files one by one so they never share a data folder
    fileParallelism: false,
    testTimeout: 20_000,
    // closes the engines each test made, so none of them acts on a later test's data folder
    setupFiles: ['test/setup.ts'],
  },
});
