// The build hooks (scripts/prepare.mjs). A tarball must hold only what a build from the sources produced, so `prepack`
// refuses where it cannot build; `prepare` must never fail an install that has no build tools. These run the script in
// a folder without node_modules, which is the case that needs care, and never build.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scripts = new URL("../../scripts/", import.meta.url).pathname;
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A package folder with the hook script, no build tools, and a file planted in dist/. */
function packageWithoutTools() {
  const root = mkdtempSync(join(tmpdir(), "superstables-prepare-"));
  temps.push(root);
  mkdirSync(join(root, "scripts"));
  for (const f of ["prepare.mjs", "package-root.mjs"]) copyFileSync(join(scripts, f), join(root, "scripts", f));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "probe", type: "module" }));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "leaked-secret.txt"), "x");
  return root;
}

function run(root: string, args: string[], npmCommand?: string) {
  const env = { ...process.env };
  delete env.npm_command;
  if (npmCommand) env.npm_command = npmCommand;
  return spawnSync(process.execPath, [join(root, "scripts", "prepare.mjs"), ...args], { cwd: root, env, encoding: "utf8" });
}

describe("the build hooks", () => {
  it("prepack refuses to pack when it cannot rebuild dist/", () => {
    const root = packageWithoutTools();
    const result = run(root, ["--pack"], "pack");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refusing to pack/);
  });

  it("prepare does not fail an install without build tools, and keeps dist/", () => {
    const root = packageWithoutTools();
    const result = run(root, [], "install");
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/skipped the build/);
    expect(existsSync(join(root, "dist", "leaked-secret.txt"))).toBe(true);
  });

  it("prepare leaves a pack or publish to prepack, which has just built", () => {
    for (const command of ["pack", "publish"]) {
      const result = run(packageWithoutTools(), [], command);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    }
  });
});
