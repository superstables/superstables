// One `pay` as its own process, for the cap tests: a PaymentEngine over the records directory given, paying the quote
// given, with a signer that holds the owner's decision. It prints one JSON line when its signer is asked ("asked") and
// one when the attempt ends ("final"), and rejects on the "decide" line on stdin.
//
//   node --import tsx test/helpers/pay-process.ts <records dir> <quote id> <per-day cap>
import { createInterface } from "node:readline";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { PaymentEngine } from "../../src/core/pay.js";
import { Records } from "../../src/core/records.js";
import { SignRefused, type Signer } from "../../src/core/signer/types.js";

const [dir, quoteId, cap] = process.argv.slice(2);
let decide: () => void = () => {};
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "decide") decide();
});
const signer: Signer = {
  kind: "browser",
  address: async () => `0x${"11".repeat(20)}`,
  async sign(_req, hooks) {
    hooks?.onPending?.("w1", "http://127.0.0.1:1/approve");
    console.log(JSON.stringify({ asked: true }));
    await new Promise<void>((resolve) => (decide = resolve));
    throw new SignRefused("denied", "denied by the owner in the wallet");
  },
};
const engine = new PaymentEngine({
  records: new Records(dir),
  policy: { ...DEFAULT_POLICY, perDay: { amount: Number(cap), asset: "USDC" } },
  signer,
});
const final = await engine.waitForAttempt(engine.startPayment(quoteId).id, 60_000);
console.log(JSON.stringify({ final: { state: final.state, refusal: final.refusal, reason: final.reason } }));
process.exit(0);
