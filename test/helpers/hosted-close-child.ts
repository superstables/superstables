// A command that closes its hosted approval and exits at once: `await close(); process.exit(0)`. The parent test reads what
// the approvals log and a later `wait` make of it. Arguments: the fake site's URL. SUPERSTABLES_HOME is the parent's.
import { readFileSync } from "node:fs";
import { HostedApprovals, type HostedRecord } from "../../budget/hosted.js";
import { evmOwner } from "./fake-site.js";

const approvals = await import("../../budget/approvals.mjs");
const { ownerApprovalsLog } = await import("../../budget/paths.mjs");
let hosted: HostedRecord | undefined;
const id = approvals.newApprovalId();
const c = new HostedApprovals({ site: process.argv[2], rail: "evm", chain: "base-sepolia", agentKey: `0x${"11".repeat(32)}`, pollWaitS: 0, minPollMs: 10_000, auditPath: ownerApprovalsLog(), onRecord: (r) => (hosted = r) });
const h = await c.request({
  kind: "evm-transaction", action: "grant", account: evmOwner("22"), timeoutMs: 60_000,
  transaction: { to: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", data: "0x095ea7b3", value: "0x0" },
  terms: { title: "Grant a spending budget", summary: "test", rows: [], enforced: [], notEnforced: [], notes: [] },
});
approvals.saveApproval({ id, command: "grant", rail: "evm", chain: "base-sepolia", state: "waiting", url: h.url, createdAt: new Date().toISOString(), hosted });
await new Promise((r) => setTimeout(r, 100));
await c.close();
console.log(JSON.stringify({ id, closed: true, loggedSending: readFileSync(ownerApprovalsLog(), "utf8").includes('"sending":true') }));
process.exit(0);
