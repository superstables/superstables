import { defineConfig } from "vitest/config";

// Test files that start the CLI or other processes and take ten seconds or more on the CI runner.
// `npm run test:fast` (CI on every push to main) skips them; `npm test` and the CI full workflow
// (the release gate, and nightly) run everything. A new test file is fast until it is listed here.
const SLOW = [
  "test/budget/approvals-token.test.ts",
  "test/budget/chain-guard.test.ts",
  "test/budget/cli-hosted-rails.test.ts",
  "test/budget/cli-hosted.test.ts",
  "test/budget/cli-once.test.ts",
  "test/budget/cli.test.ts",
  "test/budget/guidance.test.ts",
  "test/budget/hosted-cancel.test.ts",
  "test/budget/hosted.test.ts",
  "test/budget/journal-durability.test.ts",
  "test/budget/journal-unreadable.test.ts",
  "test/budget/link-gate.test.ts",
  "test/budget/lock-macos-side-effects.test.ts",
  "test/budget/lock-recovery.test.ts",
  "test/budget/operation-races.test.ts",
  "test/budget/read-caps-cli.test.ts",
  "test/budget/setup-owner.test.ts",
  "test/budget/tempo-push.test.ts",
  "test/budget/tempo-rpc.test.ts",
  "test/cli/cli.test.ts",
  "test/core/browser-signer.test.ts",
  "test/core/wallet-public-rpc.test.ts",
];

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup-offline.ts"],
    exclude: [
      ...(process.env.SUPERSTABLES_LIVE ? [] : ["test/live/**"]),
      ...(process.env.SUPERSTABLES_TEST_TIER === "fast" ? SLOW : []),
    ],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
