// The order of `superstables budget rotate`, kept free of processes and files so a test can drive it with fake steps. The
// dispatcher (cli.mjs) passes steps that run the existing commands (recover, revoke, reconcile, setup) as child processes.
//
// The old address is retired before anything is sent: nothing in this client can re-arm it while the rotation revokes. Then,
// on every chain, the old key's authority is ended and its funds returned; only then is the key file moved aside, each chain's
// public file cleared of it, and a new key set up on the same chains. After every step the record is written, so a rotation that
// stops can be run again and continues where it stopped, and does not send a transaction it has recorded again (a recover that stopped before it finished is run again, and the owner approves its revoke again).
//
//   evm     planChain per chain, retire, recoverChain per chain, swapKey, clearChain per chain, setupChain per chain
//   solana  planChain, retire, revoke, reconcile per open operation, sweep, swapKey, clearChain, setupChain
//
// Every step returns { code, result } (the child's exit code and its RESULT, or { code: 0 } for the steps that have none).
//
// A chain counts as recovered only on a positive, final, agreed verdict that the old agent has no authority left there: the
// revoke's own report (`result.revocation.final === true`) when it ran, or `readStopped` when a record from an earlier run is
// polled. A revoke that is merely in a block (landed), not final, or unreadable leaves the rotation incomplete: nothing is swapped,
// cleared or set up, the old key and the records stay, the transactions are kept in the record, and the next run polls them
// instead of sending them again. Only an allowance or delegate that reads live again (a reorganisation) is revoked again.
//   readStopped(chain, entry) -> { final, live, tx? } final: the latest revoke this machine sent is final and the chain agrees nothing is left
//                                                  (tx: that revoke, which a later revoke by hand makes differ from the recorded one);
//                                                  live: the chain shows authority still standing
//   confirmSweep(chain, tx) -> { code, result }    solana: whether a sweep's recorded signatures are finalized (state final, pending,
//                                                  failed or not_found); sweep reports final: true only for finalized transfers
const same = (rail, a, b) => (rail === "solana" ? a === b : String(a).toLowerCase() === String(b).toLowerCase());
const FINAL_OP = new Set(["settled", "failed", "not_found"]);

const text = (s) => (typeof s === "string" ? s : "");

/**
 * What a status read says about the old agent's authority: final only when the allowance (evm) or delegate (solana) reads 0 and the
 * chain agrees, at a final block or slot at or after the revoke, that nothing is left (`revoked`), and the revoke the public file
 * records (the latest this machine sent, which may be a later one by hand) is final. live: the read shows authority standing. Anything unread is neither.
 */
export function stoppedFinal(now, revocation, rail, oldAgent) {
  if (!now?.ok || now.remaining === null || now.remaining === undefined) return { final: false, live: false };
  // the read has to be of the rotation's old agent: a public file edited to name another agent says nothing about it
  if (typeof now.agent !== "string" || !(rail === "solana" ? now.agent === oldAgent : now.agent.toLowerCase() === String(oldAgent).toLowerCase())) return { final: false, live: false };
  if (Number(now.remaining) !== 0) return { final: false, live: Number.isFinite(Number(now.remaining)) };
  // the owner had no USDC account, and the owner's endpoints agreed so at finalized commitment: nothing was ever sent to record
  if (revocation?.evidence === "no_token_account") return { final: true, live: false };
  const last = now.lastOwnerAction;
  const bound = revocation?.ownerTx ?? revocation?.selfTx ?? revocation?.tx ?? null;
  // the public file names the latest revoke this machine sent (revoke and recover write it, never an older one): when that revoke
  // is final and the endpoints agree at a final block or slot at or after it that nothing is left, the authority is gone
  const proven = now.revoked === true && (last ? last.action === "revoke" && last.final === true : !bound);
  return { final: proven, live: false, tx: proven && typeof last?.tx === "string" ? last.tx : null };
}

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

  /** A revoke or sweep that is in a block but not final, or whose finality cannot be read: not a failure, and not done. */
  const notFinal = (chains, what, why) => ({
    code: 5,
    fields: {
      state: "incomplete", oldAgent, retired: true, chains: summary(record), reason: `${what} on ${[].concat(chains).join(" and ")} is not final: ${why}`,
      next: `${[].concat(chains).map((c) => `superstables budget status --rail ${rail}${rail === "evm" ? ` --chain ${c}` : ""}`).join(" and ")} shows when it is final. Then run superstables budget rotate --rail ${rail} again: it checks the transactions it recorded and does not send them again. Nothing was replaced`,
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
      // a chain whose revoke is not final yet does not hold back the others: each chain's revoke is sent in this run, because the
      // old authority stays live on a chain until its revoke is sent. Only the swap waits, so the run ends after the loop.
      const waiting = [];
      for (const c of keys) {
        const entry = record.chains[c];
        // a recover that already ran (or a chain recorded as recovered) is not sent again while the chain can still show its
        // revoke: it is checked against the chain, and only a revoke that reads live again is sent again
        if (entry.recoverRanAt || entry.recoveredAt) {
          const s = await steps.readStopped(c, entry);
          if (s.final) {
            let changed = noteProof(entry, s);
            if (!entry.recoveredAt) { entry.recoveredAt = now().toISOString(); changed = true; }
            if (changed) save();
            continue;
          }
          if (!s.live) { waiting.push([c, entry.revocation ? "the chain has not made it final yet, or its answers could not be read" : "no recorded revoke is final and agreed on the chain"]); continue; }
          delete entry.recoveredAt;
          delete entry.recoverRanAt;
          delete entry.revocation;
        }
        const r = await steps.recoverChain(c);
        if (r.result?.revocation) entry.revocation = r.result.revocation;
        if (r.code !== 0) { if (entry.revocation) save(); return stopped(r.code, c, text(r.result?.reason) || text(r.result?.next) || `exit ${r.code}`, "recover"); }
        entry.recoverRanAt = now().toISOString();
        if (r.result?.tx) entry.tx = r.result.tx;
        if (r.result?.revocation?.final === true) entry.recoveredAt = entry.recoverRanAt;
        save();
        if (!entry.recoveredAt) waiting.push([c, r.result?.revocation ? "it is in a block, and the chain has not made it final yet" : "recover reported no proof that it is final"]);
      }
      if (waiting.length) return notFinal(waiting.map(([c]) => c), "the revoke", waiting.map(([c, why]) => (waiting.length > 1 ? `${c}: ${why}` : why)).join("; "));
    } else {
      const c = keys[0];
      const entry = record.chains[c];
      // the revoke: proven final before (and still read as such), or landed and polled, or sent
      let revoked = false;
      if (entry.revokedAt || entry.revocation?.tx) {
        const s = await steps.readStopped(c, entry);
        if (s.final) {
          let changed = noteProof(entry, s);
          if (!entry.revokedAt) { entry.revokedAt = now().toISOString(); changed = true; }
          if (changed) save();
          revoked = true;
        } else if (!s.live) return notFinal(c, "the revoke", "the chain has not made it final yet, or its answers could not be read");
        else { delete entry.revokedAt; delete entry.revocation; }
      }
      if (!revoked) {
        const r = await steps.revoke(c);
        if (r.result?.revocation) entry.revocation = r.result.revocation;
        if (r.code !== 0) { if (entry.revocation) save(); return stopped(r.code, c, text(r.result?.reason) || `exit ${r.code}`, "revoke"); }
        if (r.result?.revocation?.final === true) entry.revokedAt = now().toISOString();
        save();
        if (!entry.revokedAt) return notFinal(c, "the revoke", r.result?.revocation ? "it is in a block, and the chain has not made it final yet" : "the revoke reported no proof that it is final");
      }
      // the operations still open on the chain are decided before the agent's funds move
      for (const op of plans[c]?.openOps ?? []) {
        const r = await steps.reconcile(op);
        const state = r.result?.state;
        if (!FINAL_OP.has(state)) return stopped(5, c, `operation ${op} is ${state ?? "undecided"}`, "reconcile");
      }
      if (!entry.sweptAt) {
        // transfers an earlier run sent are read from the chain, not sent again; one that never landed is swept again
        const sigs = sweepSignatures(entry.sweepTx);
        let final = false;
        if (sigs.length) {
          const k = await steps.confirmSweep(c, entry.sweepTx);
          const state = k.code === 0 ? k.result?.state : undefined;
          if (k.code === 0 && k.result?.final === true) final = true;
          else if (state === "not_found" || state === "failed") { entry.sweepEarlier = [...(entry.sweepEarlier ?? []), ...sigs]; delete entry.sweepTx; save(); } // it moved nothing (no endpoint has it, or it failed on chain): the sweep reads the balances again, and the old signatures stay as evidence
          else return notFinal(c, "the sweep", state === "pending" ? "its transfers are in a block, and the chain has not made them final yet" : text(k.result?.reason) || "its transfers could not be read");
        }
        if (!final) {
          const r = await steps.sweep(c);
          if (r.result?.tx) entry.sweepTx = merged(entry.sweepTx, r.result.tx);
          if (r.code !== 0) { if (entry.sweepTx) save(); return stopped(r.code, c, text(r.result?.reason) || `exit ${r.code}`, "the sweep"); }
          final = r.result?.final === true;
          if (final && sweepSignatures(r.result?.tx).length === 0) entry.sweepSentNothing = true;
          if (!final) { save(); return notFinal(c, "the sweep", r.result?.final === false ? "its transfers are in a block, and the chain has not made them final yet" : "it reported no proof that its transfers are final"); }
        }
        entry.sweptAt = now().toISOString();
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
  const nothingSent = keys.filter((c) => record.chains[c].sweepSentNothing);
  return {
    code: 0,
    fields: {
      state: "rotated", oldAgent, newAgent: record.newAgent, retired: true, chains: summary(record), resumed,
      ...(nothingSent.length ? { reason: `the sweep on ${nothingSent.join(", ")} sent nothing: the old agent held no USDC and too little SOL to return` } : {}),
      next: `grant the new agent: ${grants.join("; ")}${hosted.length ? `. On ${hosted.join(", ")}: remove agent ${oldAgent} from the account page` : ""}`,
    },
  };
}

/** The transaction that made the revoke final, when it is not the one the record names (a later revoke by hand). */
function noteProof(entry, s) {
  const rev = entry.revocation;
  if (!rev || typeof s.tx !== "string" || rev.provenBy === s.tx) return false;
  if ([rev.selfTx, rev.ownerTx, rev.tx].some((t) => typeof t === "string" && t.toLowerCase() === s.tx.toLowerCase())) return false;
  rev.provenBy = s.tx;
  return true;
}

/** What the RESULT says per chain. A chain is recovered once its revoke is final (and, on solana, its sweep). */
function summary(record) {
  return Object.entries(record.chains).map(([chain, e]) => ({
    chain, recovered: record.rail === "solana" ? Boolean(e.revokedAt && e.sweptAt) : Boolean(e.recoveredAt), setUp: Boolean(e.setUpAt), hosted: e.hosted ?? null,
    ...(e.revocation ? { revocation: e.revocation } : {}),
  }));
}

/** The transaction signatures a sweep reported, as a list (the sweep reports { usdc, sol }; an older record may hold a string). */
export function sweepSignatures(tx) {
  if (typeof tx === "string") return [tx];
  return tx && typeof tx === "object" ? Object.values(tx).filter((v) => typeof v === "string") : [];
}
/** An earlier run's signatures, kept, with what a later run sent added (a later run that sends nothing leaves them as they are). */
const merged = (old, now) => (now && typeof now === "object" ? { ...(old && typeof old === "object" ? old : {}), ...Object.fromEntries(Object.entries(now).filter(([, v]) => v)) } : typeof now === "string" ? { ...(old && typeof old === "object" ? old : {}), sent: now } : old);
