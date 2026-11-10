import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // each file sets OMNITRIX_HOME; run files one by one so they never share a data folder
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
