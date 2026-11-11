import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newerRelease, updateNotice } from "../../src/cli/update-notice.js";

beforeEach(() => {
  vi.stubEnv("SUPERSTABLES_DOCTOR_OFFLINE", "0");
  vi.stubEnv("SUPERSTABLES_NO_UPDATE_CHECK", "0");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("update notice", () => {
  it("compares release versions and ignores invalid and prerelease latest versions", () => {
    expect(newerRelease("2.3.4", "2.4.0")).toBe(true);
    expect(newerRelease("2.3.4-dev.3+abc", "2.3.4")).toBe(true);
    expect(newerRelease("2.3.4", "2.3.4")).toBe(false);
    expect(newerRelease("1.10.0", "1.9.0")).toBe(false);
    expect(newerRelease("2.3.4", "2.4.0-beta")).toBe(false);
    expect(newerRelease("unknown", "1.3.0")).toBe(false);
  });

  it("reports a newer release from the registry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: "99.0.0" }))));
    expect(await updateNotice()).toContain("99.0.0");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not contact the registry when opted out or offline", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("SUPERSTABLES_NO_UPDATE_CHECK", "1");
    expect(await updateNotice()).toBeUndefined();
    vi.stubEnv("SUPERSTABLES_NO_UPDATE_CHECK", "0");
    vi.stubEnv("SUPERSTABLES_DOCTOR_OFFLINE", "1");
    expect(await updateNotice()).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stays silent on network errors and malformed responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(new Response("bad json")));
    expect(await updateNotice()).toBeUndefined();
    expect(await updateNotice()).toBeUndefined();
  });
});


describe("doctor output", () => {
  it("checks only interactive human output, never JSON output", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "superstables-update-test-"));
    try {
      const hook = join(dir, "hook.mjs");
      const marker = join(dir, "contacted");
      writeFileSync(hook, `
        import fs from "node:fs";
        Object.defineProperty(process.stdout, "isTTY", { value: true });
        global.fetch = async (url) => {
          if (String(url).startsWith("https://registry.npmjs.org/")) {
            fs.writeFileSync(process.env.UPDATE_MARKER, "contacted");
            return new Response(JSON.stringify({ version: "99.0.0" }));
          }
          return new Response("unavailable", { status: 503 });
        };
      `);
      const run = (json: boolean) => spawnSync(process.execPath, ["--import", hook, "--import", "tsx", resolve(root, "src/cli/main.ts"), "doctor", ...(json ? ["--json"] : [])], {
        cwd: root, encoding: "utf8", env: { ...process.env, SUPERSTABLES_HOME: join(dir, "home"), UPDATE_MARKER: marker, SUPERSTABLES_DOCTOR_OFFLINE: "0", SUPERSTABLES_NO_UPDATE_CHECK: "0" },
      });
      const machine = run(true);
      expect(JSON.parse(machine.stdout).version).toBe(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
      expect(existsSync(marker)).toBe(false);
      const human = run(false);
      expect(human.stdout).toContain("A newer Superstables client (99.0.0)");
      expect(readFileSync(marker, "utf8")).toBe("contacted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
