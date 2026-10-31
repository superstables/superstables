/** Let an RPC node or facilitator catch up; fake-chain tests can replace only these settle pauses. */
export function rpcPause(ms) {
  const set = process.env.SUPERSTABLES_TEST_RPC_WAIT_MS ? Number(process.env.SUPERSTABLES_TEST_RPC_WAIT_MS) : NaN;
  return new Promise((resolve) => setTimeout(resolve, Number.isFinite(set) && set >= 0 ? set : ms));
}
