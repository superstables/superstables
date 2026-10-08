// Keep platform overrides inside test workers so Vite loads its native host dependencies.
import { mergeConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import base from '../../vitest.config.ts';

const preloads = [];
if (process.env.BUDGET_TEST_MACOS === '1') preloads.push(fileURLToPath(new URL('./budget-macos-identity.mjs', import.meta.url)));
if (process.env.BUDGET_TEST_SANDBOX === '1') preloads.push(fileURLToPath(new URL('./budget-blocked-identity.mjs', import.meta.url)));
export default mergeConfig(base, {
  test: {
    setupFiles: preloads,
    // Child tsx processes still need the real host's esbuild binary under a simulated platform.
    env: { ...(process.env.BUDGET_TEST_MACOS === '1' ? { ESBUILD_BINARY_PATH: fileURLToPath(new URL(`../../node_modules/@esbuild/${process.platform}-${process.arch}/bin/esbuild`, import.meta.url)) } : {}), NODE_OPTIONS: [process.env.NODE_OPTIONS ?? '', ...preloads.map(path => `--import=${path}`)].join(' ').trim() },
  },
});
