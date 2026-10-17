// `superstables owner settings`: the owner's own command for the trust anchors in src/core/owner-settings.js, the approval
// site and the RPCs that owner actions use. `show` is read only. Every change runs only in the owner's own terminal, after
// a typed `yes`; an agent has no terminal to type into. (An agent could drive a pseudo-terminal: this is a speed bump, as
// `superstables budget unlock` is, not a lock.)

import { createInterface } from "node:readline";
import type { Command } from "commander";
import { Option } from "commander";
import { accountPolicyPath, retiredListPath } from "../core/home.js";
import { signOwnerSettings } from "./owner-settings-sign.js";
import {
  DEFAULT_SITE, OWNER_SETTINGS_UNREADABLE, RPC_CHAIN_KEYS, SETTINGS_COMMAND, SIGN_COMMAND, ownerRpcUrlProblem, ownerSettingsPath,
  readOwnerSettings, sameRpcUrl, shownUrl, signedSettings, writeOwnerSettings,
} from "../core/owner-settings.js";
import type { OwnerSettings, SignedSettings } from "../core/owner-settings.js";
import { CliError, EXIT, badInput } from "./outcome.js";
import { explain } from "./help.js";

const ALIASES: Record<string, string> = { moderato: "tempo-moderato", devnet: "solana-devnet" };
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const USE_ON_DEV = "Use it on a development machine only.";
const WARNINGS: Record<string, string> = {
  site: `Any program on this computer can then serve the approval pages budget commands send the owner to. ${USE_ON_DEV}`,
  rpc: `An RPC variable that names this computer then counts as yours for owner actions: any program on this computer can answer as the chain. ${USE_ON_DEV}`,
  sellers: `A seller on this computer can then be paid on a chain that is not a testnet (this build has none). ${USE_ON_DEV}`,
};

export interface ChangeOptions { ownNode?: boolean; quorum?: string | number; clear?: boolean }
export type Change = { next: OwnerSettings; before: string; after: string; warning?: string } | { error: string };

const onOff = (b: boolean) => (b ? "on" : "off");
const siteWords = (s: OwnerSettings) => (s.site.origin === DEFAULT_SITE ? `${DEFAULT_SITE} (built-in)` : `${s.site.origin} (owner setting)`);
const rpcWords = (r?: { urls: string[]; ownNode: boolean; quorum: number }) =>
  r ? `${r.urls.map(shownUrl).join(", ")}${r.ownNode ? ", the first is your own node" : ""}, quorum ${r.quorum}` : "built-in";

/** The chain key the owner typed (a key of RPC_CHAIN_KEYS, or the budget's word for tempo and solana), or undefined. */
function chainKeyOf(word: string | undefined): string | undefined {
  const key = word === undefined ? undefined : (ALIASES[word] ?? word);
  return key !== undefined && (RPC_CHAIN_KEYS as readonly string[]).includes(key) ? key : undefined;
}

/**
 * The settings after `action` with `args`, with the before and after lines to show the owner. Pure: no terminal, no file.
 * { error } is a mistake in the command (exit 2). Any signature is not carried over (the change no longer matches it).
 */
export function applyChange(current: OwnerSettings, action: string, args: string[], opts: ChangeOptions = {}): Change {
  const next: OwnerSettings = structuredClone(current);
  delete next.signature;
  const onOffArg = (word: string | undefined) => (word === "on" ? true : word === "off" ? false : undefined);
  switch (action) {
    case "allow-staging": {
      const v = onOffArg(args[0]);
      if (v === undefined || args.length !== 1) return { error: "allow-staging takes on or off" };
      next.site.allowStaging = v;
      return { next, before: `staging site: ${onOff(current.site.allowStaging)}`, after: `staging site: ${onOff(v)}` };
    }
    case "allow-loopback": {
      const what = args[0];
      const v = onOffArg(args[1]);
      if (!["site", "rpc", "sellers"].includes(what ?? "") || v === undefined || args.length !== 2) return { error: "allow-loopback takes site, rpc or sellers, then on or off" };
      const field = what === "site" ? next.site : what === "rpc" ? next.rpcEnv : next.sellers;
      const was = what === "site" ? current.site.allowLoopback : what === "rpc" ? current.rpcEnv.allowLoopback : current.sellers.allowLoopback;
      if (what === "site" && !v && next.site.origin !== DEFAULT_SITE && LOOPBACK_HOSTS.has(new URL(next.site.origin).hostname)) return { error: "the approval site is on this computer: set another with site <origin> first" };
      field.allowLoopback = v;
      return { next, before: `${what} on this computer: ${onOff(was)}`, after: `${what} on this computer: ${onOff(v)}`, ...(v ? { warning: WARNINGS[what] } : {}) };
    }
    case "site": {
      if (opts.clear) {
        if (args.length) return { error: "site --clear takes no origin" };
        next.site.origin = DEFAULT_SITE;
      } else {
        if (args.length !== 1) return { error: "site takes one origin, such as https://example.com, or --clear" };
        let u: URL;
        try { u = new URL(args[0]); } catch { return { error: `"${args[0].slice(0, 80)}" is not a URL` }; }
        const loopback = LOOPBACK_HOSTS.has(u.hostname);
        if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return { error: "the site must be an https origin (plain http only on 127.0.0.1, localhost or [::1])" };
        if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return { error: "the site is an origin only, with no path, query, fragment or credentials" };
        if (loopback && !current.site.allowLoopback) return { error: `${u.origin} is on this computer: run ${SETTINGS_COMMAND} allow-loopback site on first` };
        next.site.origin = u.origin === "https://superstables.com" ? DEFAULT_SITE : u.origin;
      }
      return { next, before: `approval site: ${siteWords(current)}`, after: `approval site: ${siteWords(next)}` };
    }
    case "rpc": {
      const key = chainKeyOf(args[0]);
      if (key === undefined) return { error: `rpc takes a chain: ${RPC_CHAIN_KEYS.join(", ")} (moderato and devnet also work)` };
      const was = current.rpc[key];
      if (opts.clear) {
        if (args.length !== 1) return { error: "rpc <chain> --clear takes no URL" };
        delete next.rpc[key];
      } else {
        const urls = args.slice(1);
        if (urls.length < 1 || urls.length > 5) return { error: "rpc <chain> takes 1 to 5 URLs" };
        for (const u of urls) {
          const p = ownerRpcUrlProblem(u);
          if (p) return { error: `${shownUrl(u)}: ${p}` };
        }
        if (urls.some((u, i) => urls.findIndex((o) => sameRpcUrl(o, u)) !== i)) return { error: "the same URL is listed twice" };
        let quorum: number | undefined;
        if (opts.quorum !== undefined) {
          quorum = Number(opts.quorum);
          if (!Number.isInteger(quorum) || quorum < 1 || quorum > urls.length) return { error: `--quorum is a whole number from 1 to the number of URLs (${urls.length})` };
        }
        const ownNode = opts.ownNode === true;
        next.rpc[key] = { urls: urls.map((u) => u.trim()), ownNode, quorum: ownNode ? (quorum ?? 1) : Math.max(2, quorum ?? 2) };
        if (quorum !== undefined && !ownNode && quorum < 2) return { error: "a quorum of 1 needs --own-node: one RPC you do not run cannot vouch for itself" };
      }
      return { next, before: `rpc ${key}: ${rpcWords(was)}`, after: `rpc ${key}: ${rpcWords(next.rpc[key])}` };
    }
    default:
      return { error: `unknown action "${action.slice(0, 40)}": use show, sign, site, allow-staging, allow-loopback or rpc` };
  }
}

/** Why a change cannot be typed here: stdin must be a terminal. "" when it can. `sign` uses it too. */
export function ownerTerminalProblem(): string {
  return process.stdin.isTTY ? "" : "changing the owner settings needs the owner's own terminal (stdin is not a terminal)";
}

/** The signature line of `show`: who signed, and whether the policy still matches. */
export function signatureLine(s: OwnerSettings, signed: SignedSettings | undefined): string {
  if (!s.signature) return "signature: none";
  if (!signed) return "signature: none";
  if (!signed.valid) return `signature: present but not valid: ${signed.why ?? "unknown"} (sign again)`;
  const when = signed.signedAt ?? "";
  return `signature: signed by ${signed.signer} on ${when.slice(0, 10)}; ${signed.policyMatches ? "policy matches" : "policy changed since signing (sign again)"}`;
}

function showLines(s: OwnerSettings, signed?: SignedSettings): string[] {
  const lines = [
    `settings file: ${s.path}${s.present ? "" : " (missing: built-in defaults apply)"}`,
    `approval site: ${siteWords(s)}`,
    `staging: ${s.site.allowStaging ? "allowed" : "not allowed"}`,
    `this computer: site ${onOff(s.site.allowLoopback)}, rpc variables ${onOff(s.rpcEnv.allowLoopback)}, sellers ${onOff(s.sellers.allowLoopback)}`,
  ];
  const chains = Object.keys(s.rpc);
  if (chains.length) for (const k of chains) lines.push(`rpc ${k}: ${rpcWords(s.rpc[k])}`);
  else lines.push("rpc: built-in for every chain");
  lines.push(signatureLine(s, signed));
  return lines;
}

function current(): OwnerSettings {
  try {
    return readOwnerSettings();
  } catch (err) {
    if ((err as { code?: string }).code === OWNER_SETTINGS_UNREADABLE) throw new CliError((err as Error).message, EXIT.failed);
    throw err;
  }
}

async function typedYes(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  try {
    process.stderr.write("Type yes to write this change: ");
    const lines = rl[Symbol.asyncIterator]();
    const answer = await lines.next();
    return !answer.done && String(answer.value).trim() === "yes";
  } finally {
    rl.close();
  }
}

export function registerOwnerCommand(program: Command): void {
  const owner = explain(
    program.command("owner").description("the owner's own settings: the approval site and the RPCs owner actions trust"),
    {
      notes: [
        "The settings are a file in the account's own home (~/.superstables/owner/settings.json). Only the commands below, run in the " +
          "owner's own terminal, write it. SUPERSTABLES_SITE, --site and the RPC variables count for owner actions only when they name what the settings allow.",
      ],
      money: "no.",
      who: "the owner. An agent may run `owner settings show`, and never a change.",
      examples: ["superstables owner settings show"],
      prints: "see `owner settings --help`.",
      exits: "0 done, 1 the settings file cannot be used, 2 bad input, 3 refused",
    },
  );
  explain(
    owner
      .command("settings")
      .description("show or change the approval site and the RPCs owner actions trust")
      .argument("[action]", "show (default), sign, site, allow-staging, allow-loopback or rpc")
      .argument("[args...]", "the action's arguments")
      .addOption(new Option("--own-node", "rpc: the first URL is your own node (a quorum of 1 is then enough)"))
      .addOption(new Option("--quorum <n>", "rpc: how many of the URLs must agree (1 to the number of URLs)"))
      .addOption(new Option("--clear", "site: back to https://www.superstables.com; rpc <chain>: back to the built-in RPC"))
      .addOption(new Option("--json", "show: print the settings as JSON (RPC hosts only)"))
      .addOption(new Option("--rail <rail>", "sign: the wallet family that signs, evm (default) or solana").choices(["evm", "solana"]))
      .addOption(new Option("--no-open", "sign: print the link and do not open the browser"))
      .action(async (action: string | undefined, args: string[], options: ChangeOptions & { json?: boolean; rail?: "evm" | "solana"; open?: boolean }) => {
        if (action === "sign") {
          if (args.length) throw badInput("superstables owner settings: sign takes no arguments (--rail evm|solana)");
          const refusal = ownerTerminalProblem();
          if (refusal) throw new CliError(`superstables owner settings: refused: ${refusal}. Nothing was signed.`, EXIT.refused);
          const done = await signOwnerSettings({ rail: options.rail ?? "evm", ...(options.open === false ? { open: () => undefined } : {}) });
          console.log(`Signed by ${done.signer}. Wrote the signature to ${done.path}.`);
          return;
        }
        if (action === undefined || action === "show") {
          const s = current();
          const signed = s.signature ? await signedSettings({ policyPath: accountPolicyPath(), retiredPath: retiredListPath() }).catch(() => undefined) : undefined;
          if (options.json) {
            console.log(JSON.stringify({
              path: s.path, present: s.present, site: s.site,
              rpc: Object.fromEntries(Object.entries(s.rpc).map(([k, r]) => [k, { hosts: r.urls.map(shownUrl), ownNode: r.ownNode, quorum: r.quorum }])),
              rpcEnv: s.rpcEnv, sellers: s.sellers, signature: s.signature !== undefined,
              ...(signed ? { signedBy: signed.signer, signedAt: signed.signedAt, signatureValid: signed.valid, policyMatches: signed.policyMatches } : {}),
            }, null, 2));
            return;
          }
          for (const line of showLines(s, signed)) console.log(line);
          if (process.env.SUPERSTABLES_ALLOW_SITE?.trim()) console.log("note: SUPERSTABLES_ALLOW_SITE is set in this environment; it is no longer read");
          return;
        }
        const problem = ownerTerminalProblem();
        if (problem) throw new CliError(`superstables owner settings: refused: ${problem}. Nothing was written.`, EXIT.refused);
        const before = current();
        const change = applyChange(before, action, args, options);
        if ("error" in change) throw badInput(`superstables owner settings: ${change.error}`);
        console.error(`change: ${change.before} -> ${change.after}`);
        if (before.signature) console.error(`warning: this breaks your settings signature, and with it the pin on your spend policy. Run ${SIGN_COMMAND} afterwards to sign again.`);
        if (!(await typedYes())) throw new CliError("Confirmation did not match. Nothing was written.", EXIT.refused);
        writeOwnerSettings(change.next);
        console.log(`Wrote ${ownerSettingsPath()}.`);
        if (before.signature) console.log(`The signature on the old settings no longer covers them, so it was removed. Run ${SIGN_COMMAND} to sign again.`);
        if (change.warning) console.log(change.warning);
      }),
    {
      notes: [
        "Actions:\n  show                                  the settings in force (read only; the default)\n" +
          "  site <origin> | site --clear          the approval site (default https://www.superstables.com)\n" +
          "  allow-staging on|off                  allow https://staging.superstables.com\n" +
          "  allow-loopback site|rpc|sellers on|off  development only: a site, an RPC variable or a seller on this computer\n" +
          "  rpc <chain> <url...> [--own-node] [--quorum N] | rpc <chain> --clear   the RPCs owner actions and verdicts use\n" +
          "  sign [--rail evm|solana]              your wallet signs these settings, your spend policy, your retired agent keys and the enabled chains",
        "A change asks for a typed yes and runs only when stdin is a terminal. RPC URLs are never printed whole: they can carry an access key. " +
          "`sign` opens a page on 127.0.0.1 where your own wallet signs: signed settings apply only to approvals made with that wallet, and a policy file that differs from the signed one is refused until you sign again.",
      ],
      money: "no.",
      who: "the owner, in their own terminal. An agent runs `show` only and never a change or a signature.",
      examples: ["superstables owner settings show", "superstables owner settings allow-staging on", "superstables owner settings rpc base-sepolia https://rpc.example/KEY", "superstables owner settings sign"],
      prints: "show: the settings, one per line (--json: one JSON object). A change: the before and after lines, then the path written. sign: the link, the rows to sign, then the signer.",
      exits: "0 done, 1 the settings file cannot be used, 2 bad input, 3 refused (no terminal, or the answer was not yes)",
    },
  );
}

