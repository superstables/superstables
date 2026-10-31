/** How long to let an RPC node or facilitator catch up, or to back off before asking it again. Fake-chain tests can set only these
 * waits with SUPERSTABLES_TEST_RPC_WAIT_MS (a finite number >= 0); anything else leaves the length the rail wrote. */
export function rpcWaitMs(ms) {
  const set = process.env.SUPERSTABLES_TEST_RPC_WAIT_MS ? Number(process.env.SUPERSTABLES_TEST_RPC_WAIT_MS) : NaN;
  return Number.isFinite(set) && set >= 0 ? set : ms;
}

/** Let an RPC node or facilitator catch up; fake-chain tests can replace only these settle pauses. */
export function rpcPause(ms) {
  return new Promise((resolve) => setTimeout(resolve, rpcWaitMs(ms)));
}
