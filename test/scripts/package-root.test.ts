// What the build scripts trust about the package folder: whether git speaks for it, which files count as tracked, and
// that a build starts from an empty dist/. Each case here is one a package or a skill zip could otherwise leak through.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanDist, isOwnGitCheckout, makeBinsExecutable, trackedFiles } from "../../scripts/package-root.mjs";
import { gitStatus } from "../../scripts/publish-check.mjs";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd, stdio: "ignore" });

const temps: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "superstables-package-root-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text = "x") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** A package folder with one skill file. */
function pkg(root: string) {
  write(join(root, "package.json"), "{}");
  write(join(root, "skills", "s", "SKILL.md"));
  return root;
}

describe("the package folder", () => {
  it("is its own checkout only at the top of its own repository", () => {
    const repo = pkg(temp());
    git(repo, "init", "-q");
    expect(isOwnGitCheckout(repo)).toBe(true);
    expect(isOwnGitCheckout(join(repo, "skills"))).toBe(false);
    expect(isOwnGitCheckout(temp())).toBe(false);
  });

  it("is not a checkout when it is an export inside some other repository", () => {
    // An ignored folder beneath an unrelated repository: git would answer for the parent.
    const parent = temp();
    git(parent, "init", "-q");
    write(join(parent, ".gitignore"), "export/\n");
    git(parent, "add", ".gitignore");
    git(parent, "commit", "-q", "-m", "init");
    const exported = pkg(join(parent, "export"));

    expect(isOwnGitCheckout(exported)).toBe(false);
    // The publish check sees no checkout, rather than the parent's clean status.
    expect(gitStatus(exported)).toBeNull();
    // The skill build refuses without the archive promise, rather than using the parent's index.
    expect(() => trackedFiles(exported, join("skills", "s"), {})).toThrow(/not the top of its own git checkout/);
  });

  it("lists only tracked files in a checkout", () => {
    const repo = pkg(temp());
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    write(join(repo, "skills", "s", "key.txt"));
    expect(trackedFiles(repo, join("skills", "s"), {})).toEqual(["SKILL.md"]);
  });

  it("takes every file of an archive export only when the caller says so and names the commit", () => {
    const exported = pkg(temp());
    write(join(exported, "skills", "s", "references", "a.md"));
    const folder = join("skills", "s");

    expect(() => trackedFiles(exported, folder, {})).toThrow(/SUPERSTABLES_SKILL_FROM_ARCHIVE is not set/);
    expect(() => trackedFiles(exported, folder, { SUPERSTABLES_SKILL_FROM_ARCHIVE: "1" })).toThrow(/SUPERSTABLES_BUILD_COMMIT/);
    expect(() => trackedFiles(exported, folder, { SUPERSTABLES_SKILL_FROM_ARCHIVE: "1", SUPERSTABLES_BUILD_COMMIT: "main" })).toThrow(
      /SUPERSTABLES_BUILD_COMMIT/,
    );
    expect(trackedFiles(exported, folder, { SUPERSTABLES_SKILL_FROM_ARCHIVE: "1", SUPERSTABLES_BUILD_COMMIT: "0123456789" }).sort()).toEqual([
      "SKILL.md",
      "references/a.md",
    ]);
  });

  it("starts a build from an empty dist/, so a stray file there cannot ship", () => {
    const root = temp();
    write(join(root, "dist", "leaked-secret.txt"));
    write(join(root, "dist", "budget", "cli.mjs"));
    cleanDist(root);
    expect(existsSync(join(root, "dist"))).toBe(false);
    cleanDist(root); // and does nothing when there is no dist/
  });

  it("makes the package's commands executable after a build from an empty dist/", () => {
    // A fresh dist/cli/main.js has no execute bit; a checkout that runs the command from its .bin would get
    // "Permission denied".
    const root = temp();
    write(join(root, "package.json"), JSON.stringify({ bin: { superstables: "./dist/cli/main.js" } }));
    write(join(root, "dist", "cli", "main.js"));
    makeBinsExecutable(root);
    expect(statSync(join(root, "dist", "cli", "main.js")).mode & 0o111).toBe(0o111);
  });
});
