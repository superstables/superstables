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
    env: { NODE_OPTIONS: [process.env.NODE_OPTIONS ?? '', ...preloads.map(path => `--import=${path}`)].join(' ').trim() },
  },
});
