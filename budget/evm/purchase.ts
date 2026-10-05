// purchase: one x402 `exact` purchase under a plain ERC-20 approve (B4), on the chain picked in chains.ts. Used by buy.ts (CLI).
// Chain-specific behavior is marked "CHAIN:" below.
//   1. GET the seller (free) -> 402 with the price.
//   2. Prechecks (rule 4), all before anything is signed or sent: token, decimals, precision, price vs --max,
//      recipient vs --pay-to, authorization lifetime, then (unless `precheck: false`) the budget expiry, the allowance,
//      the owner's balance and the agent's own balance (must be 0, and have the gas for the pull and for the cancel and return a
//      failure would need, at the current fee).
//   3. Journal the intent (rule 5), then the agent pulls exactly the price: USDC.transferFrom(owner, agent, price).
//      THIS PURCHASE'S OWN pull must land before it may pay.
//   4. The official x402 client signs the EIP-3009 authorization with from = agent (normal EOA signature).
//      The signer re-checks the exact message (recipient, amount, token, payer, lifetime) before it signs.
//   5. The settlement is read back from the chain (the operation's own authorization nonce), not from the seller.
//   6. If the pull landed and the payment did not settle: never re-pay. Cancel the open authorization on chain, then
//      return the price to the owner (USDC.transfer), after a fresh chain read. See ops.ts makeSafe.
import { encodeFunctionData, isAddress, parseUnits, type Address } from "viem";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import { refusedChainWords } from "../next-steps.mjs";
import {
  SYM, oneLine,
  sendJournaled, NETWORK, USDC, USDC_DECIMALS, CFG, GAS, cmd, erc20Abi, usdc, usdcBalance, allowanceOf, chainReason, publicClient, sleep,
  agentGas, gasWords, fundAgentNext, GasShort, ChainRefused,
  type AgentCtx, type Wallet, type GasNeed, type GasOp,
} from "./lib.ts";
import {
  newJournal, readJournal, writeJournal, reconcileJournal, readSettlement, readPull, makeSafe, otherOpWithTx, addFee, exitCodeFor, REUSABLE, PENDING,
  type Journal, type OpState,
} from "./ops.ts";

const MAX_AUTH_LIFETIME_S = 3600; // an authorization that can be settled later than this is refused
/** The most of the seller's answer that is kept (buy saves it next to the journal). A longer answer is cut here and flagged. */
export const MAX_RESPONSE_BYTES = 1_000_000;

/** Reads at most `cap` bytes of a response body and stops reading after that, so a huge answer never sits in memory. */
async function readCapped(r: Response, cap: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!r.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = r.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (size + chunk.length > cap) {
        parts.push(chunk.subarray(0, cap - size));
        size = cap;
        truncated = true;
        break;
      }
      parts.push(chunk);
      size += chunk.length;
    }
  } catch {}
  if (truncated) reader.cancel().catch(() => {});
  return { bytes: Buffer.concat(parts, size), truncated };
}

/** The rule 4 checks on one payment option. Returns the reason to refuse, or null. Pure. */
export function checkAccept(a: any, o: { max: bigint; payTo?: string }): string | null {
  const asset = String(a.asset ?? "");
  if (asset.toLowerCase() !== USDC.toLowerCase()) return `token ${asset || "(none)"} is not ${CFG.label} ${SYM} ${USDC}`;
  const dec = a.extra?.decimals;
  if (dec !== undefined && Number(dec) !== USDC_DECIMALS) return `seller says the token has ${dec} decimals; ${CFG.label} ${SYM} has ${USDC_DECIMALS}`;
  // CHAIN: the EIP-712 domain differs per chain ("USD Coin" on Base mainnet, "USDC" on Base Sepolia and Arc). The signature is built
  // from the seller's extra.name / extra.version, so refuse an option whose domain is not the token's own. This also skips Circle
  // Gateway entries (extra.name "GatewayWalletBatched": a batched payment that needs a Gateway deposit, not EIP-3009).
  const nm = a.extra?.name, ver = a.extra?.version;
  if (nm === "GatewayWalletBatched") return `option is a Circle Gateway batched payment (extra.name GatewayWalletBatched), not a plain EIP-3009 payment`;
  if (nm !== CFG.domain.name || String(ver) !== CFG.domain.version) return `seller's EIP-712 domain (${nm}/${ver}) is not ${CFG.label} ${SYM}'s (${CFG.domain.name}/${CFG.domain.version}); the signature would not verify`;
  const method = a.extra?.assetTransferMethod;
  if (method !== undefined && method !== "eip3009") return `seller wants assetTransferMethod ${method}; only eip3009 is supported`;
  const raw = String(a.amount ?? a.maxAmountRequired ?? "");
  if (!/^\d+$/.test(raw)) return `amount "${raw}" is not a whole number of ${SYM} base units (more precision than ${USDC_DECIMALS} decimals, or not a number)`;
  const price = BigInt(raw);
  if (price === 0n) return "price is zero";
  if (price > o.max) return `price ${usdc(price)} ${SYM} exceeds --max ${usdc(o.max)} ${SYM}`;
  if (!isAddress(String(a.payTo ?? ""))) return `recipient "${a.payTo}" is not an address`;
  if (o.payTo && String(a.payTo).toLowerCase() !== o.payTo.toLowerCase()) return `recipient ${a.payTo} is not the expected --pay-to ${o.payTo}`;
  const timeout = Number(a.maxTimeoutSeconds ?? 0);
  if (timeout > MAX_AUTH_LIFETIME_S) return `authorization lifetime ${timeout}s is longer than ${MAX_AUTH_LIFETIME_S}s`;
  return null;
}

export type PurchaseOpts = {
  url: string;
  c: AgentCtx;
  op: string;
  max: bigint;
  payTo?: string;
  /** agent wallet used for every transaction (a nonce manager gives parallel pulls distinct nonces) */
  agent?: Wallet;
  /** run the allowance / balance / expiry / agent-balance prechecks before the pull. The chain-refusal check turns it off so the chain does the refusing. */
  precheck?: boolean;
  /** stop after the prechecks: print the quote, sign and send nothing */
  quoteOnly?: boolean;
  /** give up on the paid request after this many ms (the chain is read after that; the payment is never retried) */
  httpTimeoutMs?: number;
  tag?: string;
};

export type PurchaseResult = {
  state: OpState;
  ok: boolean; // settled on chain AND delivered
  journal: Journal;
  price?: bigint;
  payTo?: string;
  pulled: bigint;
  pullTx?: string;
  pullRefusal?: string; // chain error when this purchase's pull did not land
  pullRevertTx?: string; // mined-revert hash, when the refusal came from a mined transaction
  signedPayment: boolean;
  status?: number;
  settle?: any;
  settleTx?: string;
  sellerError?: string;
  body?: string; // a one-line preview for the log
  response?: { bytes: Buffer; truncated: boolean; contentType?: string }; // what the seller answered (up to MAX_RESPONSE_BYTES): buy saves it
  error?: string;
  exitCode: number; // ops.ts exitCodeFor: 0 settled and delivered (or quoted); 1 failed / refused by the chain; 3 refused before signing; 4 paid, not delivered; 5 unknown
};

class Stop extends Error {
  constructor(public kind: "precheck" | "chain" | "quote" | "reconciled", public reason: string, public next?: string) { super(reason); }
}
/** What one purchase may cost the agent in gas: the pull, and the cancel and return a failure after it would need. */
export const PURCHASE_GAS: GasOp[] = ["pull", "cancel", "return"];
/** The refusal for an agent short on gas (exit 3, nothing signed). */
const gasStop = (g: GasNeed) =>
  new Stop("precheck", `REFUSED: ${gasWords(g, "this purchase", ", including what a refund would cost")}. Nothing was signed or pulled.`, `${fundAgentNext(g)} (the owner approves it in their wallet), then buy again`);

export { exitCodeFor };

export async function purchase(o: PurchaseOpts): Promise<PurchaseResult> {
  const { c, url, max } = o;
  // one line per call: reasons can quote the seller's 402 (asset, payTo, domain name)
  const log = (s: string) => console.log(oneLine(o.tag ? `[${o.tag}] ${s}` : s, 2000));
  const agent = o.agent ?? c.wallet;
  const precheck = o.precheck ?? true;
  const httpTimeoutMs = o.httpTimeoutMs ?? 60_000;

  const j = newJournal({ op: o.op, url, owner: c.owner, agent: agent.account.address, token: USDC, max: usdc(max), expectPayTo: o.payTo });
  const res: PurchaseResult = { state: "quoted", ok: false, journal: j, pulled: 0n, signedPayment: false, exitCode: 0 };
  const finish = (state: OpState, reason?: string, next?: string): PurchaseResult => {
    j.state = state;
    if (reason) j.reason = oneLine(reason, 1000);
    if (next) j.next = oneLine(next, 1000);
    writeJournal(j);
    res.state = state;
    res.ok = state === "settled" && j.delivered === true;
    res.exitCode = exitCodeFor(state, j.delivered);
    return res;
  };
  /** After the pull landed: read the chain, make the pulled price safe, fill the result from the journal. Never pays. */
  const settleFromChain = async (why: string): Promise<PurchaseResult> => {
    log(why);
    const after = await makeSafe(j, agent, { log });
    res.pulled = parseUnits(after.pulled ?? "0", USDC_DECIMALS);
    res.signedPayment = after.signed;
    res.settleTx = after.settleTx;
    res.state = after.state;
    res.ok = after.state === "settled" && after.delivered === true;
    res.exitCode = exitCodeFor(after.state, after.delivered);
    return res;
  };

  // An operation id that already did something is never run again (rule 5).
  const prior = readJournal(o.op);
  if (prior && !REUSABLE.includes(prior.state)) {
    const why = PENDING.includes(prior.state)
      ? `operation ${o.op} is ${prior.state}: run "${cmd("reconcile.ts", `--op ${o.op}`)}" and read the chain before doing anything else`
      : `operation ${o.op} already ended as ${prior.state}: use a new --op for a new purchase`;
    log(`REFUSED: ${why}`);
    return { ...res, state: "refused_precheck", journal: { ...j, state: "refused_precheck", reason: why, next: PENDING.includes(prior.state) ? `run reconcile --op ${o.op}` : "use a new --op" }, exitCode: 3 };
  }

  let chosen: any = null;
  let stop: Stop | null = null;
  const signer = {
    address: agent.account.address,
    async signTypedData(m: any) {
      // last gate before a signature exists: the message must be exactly the quote that passed the prechecks
      const msg = m.message ?? {};
      const bad =
        !chosen ? "no validated quote" :
        Number(m.domain?.chainId ?? 0) !== CFG.chainId ? `signing domain chainId is not ${CFG.chainId}` :
        String(m.domain?.verifyingContract ?? "").toLowerCase() !== USDC.toLowerCase() ? "signing domain is not " + CFG.label + ` ${SYM}` :
        String(msg.from ?? "").toLowerCase() !== agent.account.address.toLowerCase() ? "payer is not the agent" :
        String(msg.to ?? "").toLowerCase() !== String(chosen.payTo).toLowerCase() ? "authorization recipient differs from the validated quote" :
        BigInt(msg.value ?? -1) !== BigInt(chosen.amount ?? chosen.maxAmountRequired) ? "authorization amount differs from the validated quote" :
        Number(msg.validBefore ?? 0) > Math.floor(Date.now() / 1000) + MAX_AUTH_LIFETIME_S + 60 ? "authorization would stay valid too long" :
        null;
      if (bad || res.pulled === 0n) {
        stop = new Stop("precheck", bad ? `signer refused: ${bad}` : "signer refused: this purchase's own pull has not landed");
        throw stop;
      }
      // journal the authorization BEFORE the signature exists outside this process
      j.auth = { nonce: msg.nonce, validBefore: Number(msg.validBefore), validAfter: Number(msg.validAfter ?? 0), value: String(msg.value), to: msg.to, from: msg.from };
      j.signed = true;
      writeJournal(j);
      res.signedPayment = true;
      return agent.account.signTypedData(m);
    },
  };
  const core = new x402Client().register(NETWORK as `${string}:${string}`, new ExactEvmScheme(signer as any));
  // x402 v1 sellers name the chain the old way ("base-sepolia") and have their own table and scheme class. register() takes
  // no version argument: a v1 name registered there is never matched, and every v1 seller was refused.
  for (const legacy of CFG.legacyNetworks) core.registerV1(legacy, new ExactEvmSchemeV1(signer as any));
  // only the option that passed the prechecks can be selected
  core.registerPolicy((_v: number, reqs: any[]) => (chosen ? reqs.filter((r) => r.asset === chosen.asset && r.payTo === chosen.payTo && String(r.amount ?? r.maxAmountRequired) === String(chosen.amount ?? chosen.maxAmountRequired) && r.network === chosen.network && r.scheme === chosen.scheme) : []));
  // CHAIN: the SDK signs only "default assets" (a table inside @x402/evm 2.27.0 that does not list Arc's USDC yet) or assets named in
  // spendControls.allowedAssets. Without this entry the client refuses Arc AFTER the pull has landed (seen on Arc Testnet: the pull was
  // returned, gas wasted). So the chain's USDC is allowed explicitly, capped at --max. The same call is dry-run before the pull below.
  // The v1 names get the same entry and the same --max cap.
  core.setSpendControls({ allowedAssets: [NETWORK, ...CFG.legacyNetworks].map((network) => ({ network: network as `${string}:${string}`, asset: USDC, maxAmountPerPayment: String(max) })) });
  const http = new x402HTTPClient(core);

  let hookCalls = 0;
  http.onPaymentRequired(async ({ paymentRequired }: any) => {
    try {
      if (++hookCalls > 1) throw new Stop("precheck", "the seller asked for payment a second time; not paying twice");
      const opts: any[] = (paymentRequired.accepts ?? []).filter((x: any) => (x.network === NETWORK || CFG.legacyNetworks.includes(x.network)) && x.scheme === "exact");
      if (!opts.length) throw new Stop("precheck", `seller has no usable exact ${CFG.label} option`);
      const reasons: string[] = [];
      let pick: any = null;
      for (const x of opts) {
        const why = checkAccept(x, { max, payTo: o.payTo });
        if (!why) { pick = x; break; }
        reasons.push(why);
      }
      if (!pick) throw new Stop("precheck", reasons[0]);
      const price = BigInt(pick.amount ?? pick.maxAmountRequired);
      res.price = price;
      res.payTo = pick.payTo;
      j.price = usdc(price);
      j.payTo = pick.payTo;
      log(`seller asks ${usdc(price)} ${SYM}, payTo ${pick.payTo}`);
      const onchainDecimals = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "decimals" }).catch(() => null);
      if (onchainDecimals !== USDC_DECIMALS) throw new Stop("precheck", `could not confirm ${SYM} has ${USDC_DECIMALS} decimals on chain (read ${onchainDecimals})`);
      chosen = pick;
      // Ask the x402 client itself, BEFORE the pull, whether it will sign this exact option (spend controls, registered scheme, policy).
      // Its refusal after a landed pull would cost gas and force a return.
      try {
        const sel: any = (core as any).selectPaymentRequirements(paymentRequired.x402Version, paymentRequired.accepts);
        if (!sel || sel.asset !== pick.asset || sel.payTo !== pick.payTo || sel.network !== pick.network || String(sel.amount ?? sel.maxAmountRequired) !== String(pick.amount ?? pick.maxAmountRequired)) throw new Error("the client would select a different option than the one that passed the prechecks");
      } catch (e: any) {
        throw new Stop("precheck", `the x402 client would not sign this option (${String(e?.message ?? e).split("\n")[0]}); nothing was pulled`);
      }
      if (o.quoteOnly) throw new Stop("quote", `quote only: ${usdc(price)} ${SYM} to ${pick.payTo}`);
      if (precheck) {
        const now = Math.floor(Date.now() / 1000);
        if (c.expiry && now > c.expiry) throw new Stop("precheck", `REFUSED: the budget expired at ${new Date(c.expiry * 1000).toISOString()} (public state file; the chain does not enforce it). The owner should revoke. No pull was made.`);
        const allowance = await allowanceOf(c.owner, agent.account.address);
        log(`allowance ${usdc(allowance)} ${SYM}`);
        if (allowance === 0n) throw new Stop("precheck", "REFUSED AT THE PULL: the allowance is 0 (revoked, spent or never set). No transferFrom was sent.");
        if (price > allowance) throw new Stop("precheck", `REFUSED AT THE PULL: price ${usdc(price)} exceeds the allowance ${usdc(allowance)}. No transferFrom was sent.`);
        const ownerBal = await usdcBalance(c.owner);
        if (price > ownerBal) throw new Stop("precheck", `REFUSED AT THE PULL: price ${usdc(price)} exceeds the owner's ${SYM} balance ${usdc(ownerBal)} (the allowance is ${usdc(allowance)}). No transferFrom was sent.`);
        const held = await usdcBalance(agent.account.address);
        // CHAIN: where USDC is also the gas token (Arc) the agent always holds its gas reserve, so 0 is the wrong test. It may hold
        // up to reserveMax; more than that is treated as stranded funds.
        // Money in the agent key between purchases is a seller refund (PayAI Echo refunds the payer, which is the agent) or funds an
        // earlier purchase stranded. Refuse, and tell the owner the one command that returns it.
        if (GAS.isUsdc ? held > GAS.reserveMax! : held > 0n) {
          const recover = `superstables budget recover --rail evm --chain ${CFG.key}`;
          throw new Stop("precheck",
            `REFUSED: the agent key already holds ${usdc(held)} ${SYM}${GAS.isUsdc ? ` (more than the ${usdc(GAS.reserveMax!)} ${SYM} gas reserve it should hold)` : ""}: a seller refund or funds stranded by an earlier purchase arrived there. Nothing was signed or pulled.`,
            `owner: run "${recover}" to return the ${usdc(held)} ${SYM} to the owner (the agent key sends it back; the owner approves in their wallet only if something is left for them to do), then buy again with a new --op`);
        }
        // The pull, and what a failure after it would need (cancel the authorization, return the price), at the current fee.
        const g = await agentGas(agent.account.address, PURCHASE_GAS);
        if (!g.ok) throw gasStop(g);
      }
      j.agentUsdcBefore = usdc(await usdcBalance(agent.account.address));
      // intent, before anything is sent
      j.state = "submitted";
      j.next = `run reconcile --op ${o.op}`;
      writeJournal(j);
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [c.owner, agent.account.address, price] });
      try {
        const sent = await sendJournaled(agent, USDC, data, `${o.tag ? `[${o.tag}] ` : ""}pull ${usdc(price)} ${SYM} owner -> agent (transferFrom)`, ({ hash, nonce }) => {
          j.pullTx = hash;
          j.pullNonce = nonce;
          writeJournal(j);
        }, { op: "pull", then: ["cancel", "return"] });
        j.pullBlock = String(sent.blockNumber);
        j.pullStatus = "success";
        addFee(j, sent.feeWei);
      } catch (e: any) {
        let why: string;
        if (e?.txHash) {
          // mined and reverted: the chain refused this pull
          res.pullRevertTx = e.txHash;
          j.pullStatus = "reverted";
          if (e.feeWei) addFee(j, e.feeWei);
          why = `mined revert ${e.txHash}: ${await replayRevert(agent.account.address, data, e.blockNumber)}`;
        } else if (j.pullTx) {
          // failed after the hash was recorded (broadcast or wait): the transaction may or may not be in the pool.
          // Read the chain instead of guessing.
          const twin = otherOpWithTx("pullTx", j.pullTx, o.op);
          const rec = twin ? { verdict: "not_found" as const } : await reconcileJournal(j, { quiet: true });
          if (twin) j.notes.push(`the signed pull ${j.pullTx} is byte-identical to the one operation ${twin} recorded (same nonce in two processes); it belongs to ${twin}, not to this operation`);
          if (rec.verdict !== "not_found") {
            throw (stop = new Stop("reconciled", `the pull ${j.pullTx} failed to report (${chainReason(e)}); the chain says: ${j.reason ?? j.state}`));
          }
          j.notes.push(`pull ${j.pullTx} was signed but never reached the chain (${chainReason(e)})`);
          delete j.pullTx;
          delete j.pullNonce;
          res.pullRefusal = twin
            ? `not sent: byte-identical to operation ${twin}'s pull (the same agent nonce in two processes; run one process per agent key)`
            : `the network did not accept the transaction: ${chainReason(e)}`;
          throw new Stop("chain", `PULL NOT SENT: ${res.pullRefusal}`);
        } else if (e instanceof GasShort) {
          throw gasStop(e.g); // the fee rose after the precheck: nothing was signed
        } else if (e instanceof ChainRefused) {
          why = e.reason; // the pull reverts with enough gas (or with the token's revert data): nothing was signed
        } else {
          // an RPC error while preparing: nothing was signed, and the chain has refused nothing
          throw new Stop("precheck", `PULL NOT SENT: could not prepare the pull (${chainReason(e)}). Nothing was signed.`, "try again; if it keeps failing, check the RPC (superstables budget doctor)");
        }
        res.pullRefusal = why;
        throw new Stop("chain", `REFUSED ON CHAIN at the pull: ${why}`);
      }
      // The pull is only good if the chain shows exactly the price leaving the owner.
      // A provisional canonical pull can fund the original payment; permanent conclusions wait for reconcile finality.
      const seen = await readPull(j, { final: false });
      if (!seen.found || seen.moved !== price) {
        throw (stop = new Stop("reconciled", `the pull landed but the chain shows ${seen.found ? usdc(seen.moved ?? 0n) : "no"} ${SYM} moving from the owner instead of ${usdc(price)}; not paying`));
      }
      res.pulled = price; // set only after the pull landed: this purchase may now pay
      res.pullTx = j.pullTx;
      j.pulled = usdc(price);
      writeJournal(j);
      await sleep(4000); // give the seller's facilitator RPC time to see the new balance
    } catch (e: any) {
      if (e instanceof Stop) stop = e;
      throw e;
    }
  });

  // one deadline per request: a seller that never answers must not hang the purchase. No redirects: the paid retry
  // carries PAYMENT-SIGNATURE, which fetch would take to whatever host a redirect names.
  const timedFetch: typeof fetch = (input: any, init?: any) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(httpTimeoutMs) });
  const pay = wrapFetchWithPayment(timedFetch, http);
  let r: Response;
  try {
    r = await pay(url);
  } catch (e: any) {
    const st = stop as Stop | null;
    res.error = String(e.message ?? e).split("\n")[0];
    if (st?.kind === "quote") { log(st.reason); return finish("quoted", st.reason, "buy again without --quote-only to purchase"); }
    if (st?.kind === "precheck" && !j.pullTx) { log(st.reason); return finish("refused_precheck", st.reason, st.next ?? "nothing was signed or sent"); }
    if (st?.kind === "chain") { log(st.reason); return finish("refused_chain", st.reason, refusedChainWords(j.pullTx).next); }
    if (st?.kind === "reconciled" || j.pullTx) {
      // something went wrong after the pull was sent (or the chain could not confirm it): read the chain, never re-pay
      if (st?.kind === "reconciled" && !j.pulled && j.state !== "settled") { j.reason = st.reason; writeJournal(j); }
      return settleFromChain(`error after the pull was sent (${st?.reason ?? res.error}); reading the chain, never re-paying`);
    }
    log(res.error);
    return finish("refused_precheck", `seller unreachable or no usable challenge: ${res.error}`, "nothing was signed or sent");
  }

  const hdr = r.headers.get("payment-response") ?? r.headers.get("x-payment-response");
  if (hdr) try { res.settle = decodePaymentResponseHeader(hdr); } catch {}
  res.status = r.status;
  const got = await readCapped(r, MAX_RESPONSE_BYTES);
  res.response = { ...got, contentType: r.headers.get("content-type") ?? undefined };
  res.body = oneLine(got.bytes.subarray(0, 4096).toString("utf8").replace(/\s+/g, " "), 160);
  res.settleTx = res.settle?.transaction;
  if (!res.settle && r.status === 402) {
    const pr = r.headers.get("payment-required");
    if (pr) try { res.sellerError = oneLine(JSON.parse(Buffer.from(pr, "base64").toString()).error); } catch {}
    // a v1 seller says why in its 402 body
    else try { const b = JSON.parse(got.bytes.toString("utf8")); if (b?.x402Version === 1 && typeof b.error === "string") res.sellerError = oneLine(b.error); } catch {}
  }
  j.httpStatus = r.status;
  j.delivered = r.ok;

  if (!j.pullTx) {
    // the seller never asked for payment: nothing was pulled or signed
    return finish("refused_precheck", `seller did not ask for payment (HTTP ${r.status})`, "nothing was signed or sent");
  }

  // The seller's word is not evidence. Read the chain (own authorization nonce). RPC lag: a few short retries.
  let s = await readSettlement(j);
  for (let i = 0; !s.used && !s.canceled && i < 5 && (res.settle?.success || r.ok); i++) { await sleep(3000); s = await readSettlement(j); }
  if (s.used && s.settleTx) {
    const rec = await reconcileJournal(j, { quiet: true });
    res.settleTx = rec.j.settleTx;
    res.state = rec.j.state;
    res.ok = rec.j.state === "settled" && j.delivered === true;
    res.exitCode = exitCodeFor(rec.j.state, j.delivered);
    j.delivered = r.ok; // reconcile does not touch delivery; keep what the seller answered
    writeJournal(j);
    return res;
  }
  if (r.ok) {
    // The seller delivered but the chain does not show the payment yet. Do not cancel it (that would take the goods without paying):
    // the authorization stays valid until validBefore. Reconcile after that.
    const rec = await reconcileJournal(j, { quiet: !!o.tag });
    res.state = rec.j.state;
    res.settleTx = rec.j.settleTx;
    res.exitCode = exitCodeFor(rec.j.state, j.delivered);
    return res;
  }
  // The seller did not deliver and the chain shows no settlement: cancel the open authorization, then return the price.
  return settleFromChain(`seller answered HTTP ${r.status}; the chain does not show this purchase's authorization as used. Reading the chain (never re-paying).`);
}

/** After a mined revert, replay the same call at the block that mined it to read the reason. */
export async function replayRevert(from: Address, data: `0x${string}`, blockNumber: bigint): Promise<string> {
  try {
    await publicClient.call({ account: from, to: USDC, data, blockNumber });
    return "replay did not revert";
  } catch (e: any) {
    return chainReason(e);
  }
}
