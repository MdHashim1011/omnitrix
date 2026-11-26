import { afterEach } from 'vitest';

// Every test makes its own engines in its own data folder. An engine left open keeps ticking after its test,
// and the data folder it reads is whichever one the current test set, so it would start its leftover jobs on
// a later test's accounts and take their seats. Close them all before the next test begins.
afterEach(async () => {
  // Imported here, not at the top: a setup file runs before the test file, and loading the engine that early
  // would load its real modules before a test file's vi.mock could replace them.
  const { Engine } = await import('../src/engine.js');
  await Engine.closeAll();
});
