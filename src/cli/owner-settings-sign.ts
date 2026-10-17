// `superstables owner settings sign`: the owner's wallet signs the settings, the spend policy, the retired agent keys and the
// chains enabled for signing (src/core/owner-settings.js, "Signed settings"). A page on 127.0.0.1 asks the owner's browser
// wallet; the server checks the signature before anything is written, and the file is written only from what it checked, with the
// hashes recomputed once more. An agent has no terminal to type into and no wallet: the command runs only in the owner's own.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { accountPolicyPath, retiredListPath } from "../core/home.js";
import {
  SETTINGS_COMMAND, SIGN_COMMAND, readOwnerSettings, requirePolicyFile, settingsPayload, settingsSignedAt, signatureRecord, signedSettings, writeOwnerSettings,
} from "../core/owner-settings.js";
import { OwnerApprovalServer, type OwnerChain, type OwnerTerms } from "../core/signer/owner-approval-server.js";
import { CliError, EXIT } from "./outcome.js";

export type SignRail = "evm" | "solana";

const EVM_CHAIN: OwnerChain = {
  chainId: 84532,
  chainName: "None: this signs a message, it sends nothing",
  rpcUrl: "https://sepolia.base.org",
  explorer: "https://sepolia.basescan.org",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  testnet: true,
};
const SOLANA_CHAIN: OwnerChain = {
  family: "solana",
  chainId: 0,
  chainName: "None: this signs a message, it sends nothing",
  rpcUrl: "https://api.devnet.solana.com",
  explorer: "https://explorer.solana.com",
  walletChain: "solana:devnet",
  nativeCurrency: { name: "Solana", symbol: "SOL", decimals: 9 },
  testnet: true,
};

export interface SignOptions {
  rail: SignRail;
  /** How long the page stays open. */
  timeoutMs?: number;
  /** Opens the page; the default opens the owner's browser. */
  open?: (url: string) => void;
  /** Where the link and the rows are said. Default stderr. */
  say?: (line: string) => void;
  /** 0 (the default) picks a free port. */
  port?: number;
  /** How long the finished page stays up. */
  lingerMs?: number;
  /** Test hook: the chains enabled for signing (this build offers none to the owner). */
  enabledChains?: string[];
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // no browser: the link is printed
  }
}

function retiredCount(path: string): string {
  try {
    const list = JSON.parse(readFileSync(path, "utf8")) as { retired?: unknown[] };
    const n = Array.isArray(list.retired) ? list.retired.length : 0;
    return `${n} retired`;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "none retired" : "list not readable";
  }
}

/** The terms the page shows: every row is derived from the files now on disk, never from anything an agent typed. */
function termsFor(rail: SignRail, payload: ReturnType<typeof settingsPayload>, policyPath: string, retiredPath: string): OwnerTerms {
  const shortHash = (h: string) => h;
  return {
    title: "Sign your settings",
    summary: "Your wallet signs the approval site, your RPC settings, your spend policy, your retired agent keys and the chains enabled for signing. Signed settings apply only to payments and approvals made with this wallet.",
    rows: [
      { label: "Site", value: payload.site, mono: true },
      { label: "Enabled chains", value: payload.enabledChains.length ? payload.enabledChains.join(", ") : "none: this build signs on testnets only" },
      { label: "Policy", value: `${policyPath}\n${shortHash(payload.policyHash)}`, mono: true },
      { label: "Retired agents", value: `${retiredCount(retiredPath)}\n${shortHash(payload.retiredHash)}`, mono: true },
      { label: "Settings", value: `${shortHash(payload.settingsHash)}\nCovers your approval site, RPC endpoints and development switches.`, mono: true },
    ],
    enforced: [],
    notEnforced: [],
    walletShows: rail === "evm"
      ? [
          "site: the approval site above, as text.",
          "enabledChains: the chains above, as text, or none.",
          "policy: the hash of your policy file.",
          "retiredAgents: the hash of your retired agent keys.",
          "settings: the hash of your settings, which covers your approval site, RPC endpoints and development switches.",
          "signedAt: the time you sign, as a number of seconds.",
        ]
      : [
          "Seven lines of text: the title, then Site, Chains enabled for signing, Policy, Retired agents, Settings and Signed at.",
          "The hashes are those above. Signing sends nothing and costs nothing.",
        ],
    notes: [
      "This signature grants no spending permission and has no network fee.",
      `If you change your policy file, your settings or your retired agent keys afterwards, run ${SIGN_COMMAND} again. Until then payments with this wallet are refused when the policy file differs.`,
    ],
  };
}

/** Runs the signing page and writes the signature. Throws CliError on any refusal; nothing is written unless the wallet signed. */
export async function signOwnerSettings(options: SignOptions): Promise<{ signer: string; signedAt: string; path: string }> {
  const policyPath = accountPolicyPath();
  const retiredPath = retiredListPath();
  const before = readOwnerSettings();
  let payload;
  try {
    requirePolicyFile(policyPath);
    payload = settingsPayload(before, { policyPath, retiredPath, enabledChains: options.enabledChains ?? [] });
  } catch (err) {
    throw new CliError(`${SETTINGS_COMMAND} sign: refused: ${(err as Error).message}. Nothing was signed.`, EXIT.refused);
  }
  const signedAt = settingsSignedAt();
  const say = options.say ?? ((line: string) => process.stderr.write(`${line}\n`));
  const server = new OwnerApprovalServer({ port: options.port ?? 0 });
  await server.start();
  try {
    const terms = termsFor(options.rail, payload, policyPath, retiredPath);
    const handle = server.request({
      kind: "settings",
      chain: options.rail === "solana" ? SOLANA_CHAIN : EVM_CHAIN,
      terms,
      settingsSigning: { payload, signedAt },
      timeoutMs: options.timeoutMs ?? 600_000,
    });
    say(`Open this page in the browser with your ${options.rail === "solana" ? "Solana" : "EVM"} wallet, and sign your settings there:\n\n  ${handle.url}\n`);
    for (const row of terms.rows) say(`  ${row.label}: ${row.value.replace(/\n/g, " ")}`);
    (options.open ?? openBrowser)(handle.url);
    const outcome = await handle.settled;
    if (outcome.status !== "connected" || !outcome.signature) {
      const why = outcome.status === "rejected" || outcome.status === "expired" ? outcome.reason : "no signature came back";
      throw new CliError(`${SETTINGS_COMMAND} sign: ${outcome.status === "expired" ? "the page expired" : "the signing was not completed"}: ${why}. Nothing was written.`, EXIT.refused);
    }
    // The files may have changed while the page was open: what was signed must still be what is on disk.
    const now = readOwnerSettings();
    let again;
    try {
      again = settingsPayload(now, { policyPath, retiredPath, enabledChains: options.enabledChains ?? [] });
    } catch (err) {
      handle.finish({ outcome: "failed", message: "The files changed while this page was open. Nothing was written." });
      throw new CliError(`${SETTINGS_COMMAND} sign: refused: ${(err as Error).message}. Nothing was written.`, EXIT.refused);
    }
    if (JSON.stringify(again) !== JSON.stringify(payload)) {
      handle.finish({ outcome: "failed", message: "Your settings, policy or retired agent keys changed while this page was open, so the signature no longer covers them. Nothing was written. Run the command again." });
      throw new CliError(`${SETTINGS_COMMAND} sign: refused: the settings, the policy file or the retired agent keys changed while the page was open. Nothing was written; run it again.`, EXIT.refused);
    }
    const signature = signatureRecord({
      scheme: options.rail === "solana" ? "ed25519" : "eip712",
      signer: outcome.address,
      signedAt,
      payload,
      value: outcome.signature,
    });
    writeOwnerSettings({ ...now, signature });
    // Read it back the way every other reader will.
    const check = await signedSettings({ policyPath, retiredPath });
    if (!check?.valid || !check.policyMatches) {
      handle.finish({ outcome: "failed", message: "The signature was written but does not read back as valid. Run the command again." });
      throw new CliError(`${SETTINGS_COMMAND} sign: the written signature does not verify (${check?.why ?? "unknown"}). Run it again.`, EXIT.failed);
    }
    handle.finish({ outcome: "confirmed", message: `Your settings are signed by ${outcome.address}.` });
    await new Promise((resolve) => setTimeout(resolve, options.lingerMs ?? 3_000));
    return { signer: outcome.address, signedAt, path: now.path };
  } finally {
    await server.close();
  }
}
