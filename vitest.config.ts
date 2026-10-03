import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup-offline.ts"],
    exclude: process.env.SUPERSTABLES_LIVE ? [] : ["test/live/**"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
