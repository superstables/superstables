// Test-only: the approval worker's backstop (budget/cli.mjs, WORKER_ID block) fires minutes after the worker starts. In the
// dispatcher process of an approval worker, a timer of fifteen minutes or more fires after BACKSTOP_TEST_MS instead. Nothing
// else is changed: not other processes (the rail script), not shorter timers. Production has no such switch.
if (process.env.SUPERSTABLES_BUDGET_APPROVAL_ID && /budget\/cli\.mjs$/.test(process.argv[1] ?? "")) {
  const original = globalThis.setTimeout;
  const ms = Number(process.env.BACKSTOP_TEST_MS ?? 5000);
  globalThis.setTimeout = (fn, delay, ...args) => original(fn, typeof delay === "number" && delay >= 900_000 ? ms : delay, ...args);
}
