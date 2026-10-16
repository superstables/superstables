// The order of `superstables budget rotate`, kept free of processes and files so a test can drive it with fake steps. The
// dispatcher (cli.mjs) passes steps that run the existing commands (recover, revoke, reconcile, setup) as child processes.
//
// The old address is retired before anything is sent: nothing in this client can re-arm it while the rotation revokes. Then,
// on every chain, the old key's authority is ended and its funds returned; only then is the key file moved aside, each chain's
// public file cleared of it, and a new key set up on the same chains. After every step the record is written, so a rotation that
// stops can be run again and continues where it stopped, and never repeats an owner action it has recorded.
//
//   evm     planChain per chain, retire, recoverChain per chain, swapKey, clearChain per chain, setupChain per chain
//   solana  planChain, retire, revoke, reconcile per open operation, sweep, swapKey, clearChain, setupChain
//
// Every step returns { code, result } (the child's exit code and its RESULT, or { code: 0 } for the steps that have none).
const same = (rail, a, b) => (rail === "solana" ? a === b : String(a).toLowerCase() === String(b).toLowerCase());
const FINAL_OP = new Set(["settled", "failed", "not_found"]);

const text = (s) => (typeof s === "string" ? s : "");

/**
 * @param {object} p
 * @param {"evm"|"solana"} p.rail
 * @param {string} p.currentAgent   the address of the key file now
 * @param {object|null} p.existing  an unfinished record for this rail (with its `path`), or null
 * @param {string[]} p.chains       the chains to rotate: those whose public file names the old agent, and those a record holds
 * @param {object} p.steps
 * @param {boolean} [p.plan]        print the plan, send nothing
 * @param {boolean} [p.keyMoved]    the key file is already aside (an earlier run moved it and stopped): nothing is left to plan or recover
 * @param {() => Date} [p.now]
 * @param {(line: string) => void} [p.log]
 * @returns {Promise<{ code: number, fields: Record<string, any> }>}
 */
export async function rotate({ rail, currentAgent, existing, chains, steps, plan = false, keyMoved = false, now = () => new Date(), log = () => {} }) {
  const resumed = Boolean(existing);
  // a record before its swap belongs to the key file as it is; after the swap the key file is the new one
  if (existing && !existing.swappedAt && !same(rail, existing.oldAgent, currentAgent)) {
    return {
      code: 3,
      fields: { state: "refused_precheck", reason: `an earlier rotation of the ${rail} key ${existing.oldAgent} was not finished (${existing.path}), and the key file now holds ${currentAgent}`, next: `finish that rotation (restore the key file it started with and run rotate again), or move ${existing.path} away if you mean to abandon it` },
    };
  }
  const oldAgent = existing ? existing.oldAgent : currentAgent;
  const record = existing ?? { version: 1, rail, oldAgent, startedAt: now().toISOString(), chains: {} };
  for (const c of chains) record.chains[c] ??= {};
  const keys = Object.keys(record.chains);
  /** each chain's plan from this run: what is open now, not what was open when an earlier run stopped */
  const plans = {};
  const save = () => steps.writeRecord(record);
  const stopped = (code, c, why, step) => ({
    code,
    fields: {
      state: "incomplete", oldAgent, retired: true, chains: summary(record), reason: `${step}${c ? ` on ${c}` : ""} did not finish: ${why}`,
      next: `fix what the output above says, then run superstables budget rotate --rail ${rail} again; it continues where it stopped`,
    },
  });

  // 1. plan, before anything is sent (nothing is planned once the key file has been moved: only clear and set up are left)
  if (!record.swappedAt && !keyMoved) {
    for (const c of keys) {
      const r = await steps.planChain(c);
      if (r.code !== 0) return stopped(r.code, c, text(r.result?.reason) || `the plan exited ${r.code}`, "the plan");
      const unreadable = r.result?.plan?.unreadable ?? [];
      if (unreadable.length) {
        return { code: 5, fields: { state: "unknown", oldAgent, retired: false, reason: `${unreadable.length} journal file(s) on ${c} cannot be read, so what the old agent may still move is not known: ${unreadable.slice(0, 3).map((u) => `${u.file}: ${u.why}`).join("; ")}`, next: "the owner checks each journal file named above, then runs rotate again. Nothing was sent" } };
      }
      if (r.hosted) record.chains[c].hosted = r.hosted;
      plans[c] = r.result?.plan ?? {};
    }
  }
  if (plan) return { code: 0, fields: { state: "planned", oldAgent, retired: false, chains: summary(record), next: `superstables budget rotate --rail ${rail} (the owner approves each step as it comes)` } };

  // 2. retire the old address first
  // (on every run, not only the first: an entry removed from the list between two runs is put back before anything is sent)
  const retired = await steps.retire();
  if (retired.code !== 0) return { code: retired.code, fields: { state: "failed", oldAgent, retired: false, reason: text(retired.result?.reason) || "the old address could not be retired", next: "nothing was sent; fix the retired-keys list, then run rotate again" } };
  if (!record.retiredAt) {
    record.retiredAt = now().toISOString();
    save();
  }

  // 3. end the old key's authority and return its funds
  if (!record.swappedAt) {
    if (rail === "evm") {
      for (const c of keys) {
        const entry = record.chains[c];
        // a chain recorded as recovered is recovered again unless the chain reads the allowance at 0
        if (entry.recoveredAt && (await steps.readStopped(c))) continue;
        const r = await steps.recoverChain(c);
        if (r.code !== 0) return stopped(r.code, c, text(r.result?.reason) || text(r.result?.next) || `exit ${r.code}`, "recover");
        entry.recoveredAt = now().toISOString();
        if (r.result?.tx) entry.tx = r.result.tx;
        save();
      }
    } else {
      const c = keys[0];
      const entry = record.chains[c];
      if (!(entry.revokedAt && (await steps.readStopped(c)))) {
        const r = await steps.revoke(c);
        if (r.code !== 0) return stopped(r.code, c, text(r.result?.reason) || `exit ${r.code}`, "revoke");
        entry.revokedAt = now().toISOString();
        if (r.result?.tx) entry.tx = r.result.tx;
        save();
      }
      // the operations still open on the chain are decided before the agent's funds move
      for (const op of plans[c]?.openOps ?? []) {
        const r = await steps.reconcile(op);
        const state = r.result?.state;
        if (!FINAL_OP.has(state)) return stopped(5, c, `operation ${op} is ${state ?? "undecided"}`, "reconcile");
      }
      if (!entry.sweptAt) {
        const r = await steps.sweep(c);
        if (r.code !== 0) return stopped(r.code, c, text(r.result?.reason) || `exit ${r.code}`, "the sweep");
        entry.sweptAt = now().toISOString();
        if (r.result?.tx) entry.sweepTx = r.result.tx;
        save();
      }
    }

    // 4. the key file moves aside
    const r = await steps.swapKey();
    if (r.code !== 0) return { code: r.code, fields: { state: "incomplete", oldAgent, retired: true, chains: summary(record), reason: text(r.result?.reason) || "the old key file could not be moved aside", next: "fix what the output above says, then run rotate again" } };
    record.swappedAt = now().toISOString();
    save();
  }

  // 5. each chain forgets the old agent
  for (const c of keys) {
    if (record.chains[c].clearedAt) continue;
    const r = await steps.clearChain(c);
    if (r.code !== 0) return stopped(r.code, c, text(r.result?.reason) || `exit ${r.code}`, "clearing the old agent");
    record.chains[c].clearedAt = now().toISOString();
    save();
  }

  // 6. the new key, on the same chains, with the same owner
  for (const c of keys) {
    if (record.chains[c].setUpAt) continue;
    const r = await steps.setupChain(c, record.chains[c]);
    if (r.code !== 0) return stopped(r.code, c, text(r.result?.reason) || `exit ${r.code}`, "setup");
    record.chains[c].setUpAt = now().toISOString();
    if (typeof r.result?.agent === "string") record.newAgent = r.result.agent;
    save();
  }

  // 7. finish
  record.finishedAt = now().toISOString();
  save();
  // an old key that lived in the OS keychain stays there, like a retired key file: what is left at the retired address
  // (gas, a late deposit) can still be moved by hand
  const hosted = [...new Set(keys.map((c) => record.chains[c].hosted).filter(Boolean))];
  const grants = keys.map((c) => `superstables budget grant --rail ${rail}${rail === "evm" ? ` --chain ${c}` : ""} --amount A`);
  return {
    code: 0,
    fields: {
      state: "rotated", oldAgent, newAgent: record.newAgent, retired: true, chains: summary(record), resumed,
      next: `grant the new agent: ${grants.join("; ")}${hosted.length ? `. On ${hosted.join(", ")}: remove agent ${oldAgent} from the account page` : ""}`,
    },
  };
}

/** What the RESULT says per chain. */
function summary(record) {
  return Object.entries(record.chains).map(([chain, e]) => ({ chain, recovered: Boolean(e.recoveredAt || e.revokedAt), setUp: Boolean(e.setUpAt), hosted: e.hosted ?? null }));
}
