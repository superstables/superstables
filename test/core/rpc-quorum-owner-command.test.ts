// The words an agent reads when the owner's settings cannot be used must not carry the owner-only command that the settings module appends.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "superstables-owner-words-"));
vi.mock("node:os", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:os")>()), userInfo: () => ({ homedir: home }) }));

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("endpointSetErrorWords with the real unreadable-settings error", () => {
  it("keeps the file and the problem, and leaves out the owner's command", async () => {
    const { readOwnerSettings, SETTINGS_COMMAND } = await import("../../src/core/owner-settings.js");
    const { agreementWords, endpointSetErrorWords } = await import("../../src/core/rpc-quorum.mjs");
    mkdirSync(join(home, ".superstables", "owner"), { recursive: true, mode: 0o700 });
    chmodSync(join(home, ".superstables"), 0o700);
    chmodSync(join(home, ".superstables", "owner"), 0o700);
    const file = join(home, ".superstables", "owner", "settings.json");
    writeFileSync(file, "not json", { mode: 0o600 });
    let error = "";
    try { readOwnerSettings(); } catch (err) { error = (err as Error).message; }
    expect(error).toContain(`${SETTINGS_COMMAND} show`);

    const words = endpointSetErrorWords(error, "SUPERSTABLES_SOLANA_RPC");
    expect(words).toContain(`the owner settings at ${file} cannot be used:`);
    expect(words).not.toContain(SETTINGS_COMMAND);
    expect(words).not.toMatch(/owner checks the file/);
    expect(words).toMatch(/^the RPC check could not run: .*; stop and ask the owner to check the settings$/);
    expect(agreementWords({ agreed: false, why: "unreadable", reason: error } as never)).toBe(words);
  });
});
