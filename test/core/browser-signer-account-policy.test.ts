// The browser signer is the gate before an approval link exists, and it reads the policy itself, late, from the
// agent's environment. The account's own ~/.superstables/policy.yaml must hold there too, whatever SUPERSTABLES_POLICY
// or SUPERSTABLES_HOME say: a refusal here means nobody is asked and no page is served.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usdcRequirement } from "../../src/core/chain.js";
import { BrowserWalletSigner } from "../../src/core/signer/browser.js";
import { SignRefused, type Eip3009SignRequest } from "../../src/core/signer/types.js";

const SELLER = privateKeyToAccount(generatePrivateKey()).address;
const NAMES = ["SUPERSTABLES_POLICY", "SUPERSTABLES_HOME", "SUPERSTABLES_TEST_ACCOUNT_HOME"] as const;

describe("the browser signer and the account's own policy", () => {
  let dir: string;
  let account: string;
  let accountFile: string;
  const saved: Record<string, string | undefined> = {};
  const signers: BrowserWalletSigner[] = [];

  beforeEach(() => {
    for (const name of NAMES) saved[name] = process.env[name];
    dir = mkdtempSync(join(tmpdir(), "superstables-account-policy-test-"));
    account = join(dir, "account");
    accountFile = join(account, ".superstables", "policy.yaml");
    mkdirSync(join(account, ".superstables"), { recursive: true });
    // The agent's environment: a policy with high caps, in a home of its own.
    const selected = join(dir, "selected.yaml");
    writeFileSync(selected, "caps:\n  per_call: 100 USDC\n  per_day: 100 USDC\n");
    process.env.SUPERSTABLES_POLICY = selected;
    process.env.SUPERSTABLES_HOME = join(dir, "agent-home");
    process.env.SUPERSTABLES_TEST_ACCOUNT_HOME = account;
  });

  afterEach(async () => {
    while (signers.length > 0) await signers.pop()?.close();
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // No policy option: the signer reads the policy itself, as it does for the CLI.
  const signer = () => {
    const s = new BrowserWalletSigner({ port: 0, home: join(dir, "signer-home"), timeoutMs: 2000, balance: false });
    signers.push(s);
    return s;
  };
  const request = (): Eip3009SignRequest => ({ kind: "eip3009", requirements: usdcRequirement(0.01, SELLER), x402Version: 2 });
  const refusal = async (s: BrowserWalletSigner): Promise<SignRefused> => {
    const err = await s.sign(request()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SignRefused);
    return err as SignRefused;
  };

  it("refuses on the account's kill switch, with no link served, whatever the selected policy allows", async () => {
    writeFileSync(accountFile, "kill_switch: true\n");
    const s = signer();
    const err = await refusal(s);
    expect(err.code).toBe("policy");
    expect(err.message).toBe(`kill_switch is on (in ${accountFile})`);
    expect(s.url).toBe("");
  });

  it("reads the account's file late: written after the signer was built", async () => {
    const s = signer();
    writeFileSync(accountFile, "kill_switch: true\n");
    const err = await refusal(s);
    expect(err.code).toBe("policy");
    expect(err.message).toBe(`kill_switch is on (in ${accountFile})`);
    expect(s.url).toBe("");
  });

  it("says in its status that the account's file applies as well", async () => {
    const s = signer();
    expect((await s.status()).also).toBeUndefined();
    writeFileSync(accountFile, "caps:\n  per_call: 0.02 USDC\nkill_switch: true\n");
    const status = await s.status();
    expect(status.policy.killSwitch).toBe(false);
    expect(status.also).toMatchObject({ file: accountFile, policy: { perCall: "0.02 USDC", killSwitch: true } });
  });
});
