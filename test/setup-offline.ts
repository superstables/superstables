// Every test runs without the network, unless SUPERSTABLES_LIVE=1 (npm run test:live).
//
// - A `pay` that settles reads the chain (src/core/settlement.ts), and the budget rails read theirs. SUPERSTABLES_RPC_URL,
//   B4_RPC, SUPERSTABLES_TEMPO_RPC and SUPERSTABLES_SOLANA_RPC are forced to an address on this computer where nothing
//   listens, whatever the environment says, unless a test points at a fake chain.
// - fetch reaches this computer only (test/fetch-guard.mjs), here and, through NODE_OPTIONS, in every node process a
//   test starts.
import { fileURLToPath } from "node:url";

if (!process.env.SUPERSTABLES_LIVE) {
  // Every RPC the client and the budget rails read, forced to an address on this computer where nothing listens,
  // whatever the environment said. A test that needs a chain starts a fake one and passes its address itself.
  for (const name of ["SUPERSTABLES_RPC_URL", "SUPERSTABLES_TEMPO_RPC", "SUPERSTABLES_SOLANA_RPC"]) {
    process.env[name] = "http://127.0.0.1:9/";
  }
  // B4_RPC is cleared, not forced: the evm rail tests replace fetch for the chain's own default RPC URL (a fake node
  // loaded in-process or with --import), so the rail must keep its default; an inherited value must not leak in.
  delete process.env.B4_RPC;
  const guard = fileURLToPath(new URL("./fetch-guard.mjs", import.meta.url));
  await import("./fetch-guard.mjs");
  const option = `--import=${guard}`;
  if (!(process.env.NODE_OPTIONS ?? "").includes(option)) {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} ${option}`.trim();
  }
}
