// Two questions the build scripts ask about the package folder before they trust what is in it.
//
// isOwnGitCheckout: is this folder the top of its own git checkout? git searches parent folders for a repository,
// so in a folder that is not a checkout (an export, an unpacked tarball) placed inside some other repository, `git
// status` and `git ls-files` answer for that other repository and say nothing true about the package's files. Only a
// repository whose top level is the package folder itself counts.
//
// trackedFiles: the files of a folder in the package that git tracks, for builds that must ship tracked files only.
//
// cleanDist: remove dist/ entirely before a build, so the package holds what this build produced and nothing an
// earlier build, or a person, left in dist/ (dist/ is ignored by git, so nothing else would notice).
//
// cleanBuild: `npm run build` into an empty dist/, then make the package's commands executable again (a fresh
// dist/cli/main.js is written without the execute bit, which an earlier install had set on the old file).

import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * True when `root` is the top level of a git checkout, false otherwise (no git, not a checkout, or a folder inside a
 * parent repository).
 *
 * @param {string} root the package folder
 * @returns {boolean}
 */
export function isOwnGitCheckout(root) {
  let top;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return false;
  }
  try {
    return realpathSync(top) === realpathSync(root);
  } catch {
    return false;
  }
}

/**
 * Removes `<root>/dist`, whatever it holds.
 *
 * @param {string} root the package folder
 */
export function cleanDist(root) {
  rmSync(join(root, "dist"), { recursive: true, force: true });
}

/**
 * Builds dist/ from the sources into an empty dist/: tsc, then the budget build, as `npm run build` does. Needs the
 * dev packages (typescript, esbuild). The files named in package.json's `bin` are made executable.
 *
 * @param {string} root the package folder
 */
export function cleanBuild(root) {
  const require = createRequire(join(root, "package.json"));
  cleanDist(root);
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
  execFileSync(process.execPath, [join(root, "scripts", "budget-build.mjs")], { cwd: root, stdio: "inherit" });
  makeBinsExecutable(root);
}

/**
 * Sets the execute bit on every file package.json's `bin` names.
 *
 * @param {string} root the package folder
 */
export function makeBinsExecutable(root) {
  const { bin } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const file of Object.values(typeof bin === "string" ? { bin } : (bin ?? {}))) chmodSync(join(root, file), 0o755);
}

/**
 * The files git tracks under `<root>/<folder>`, relative to that folder, with forward slashes.
 *
 * In the package's own checkout git answers. Anywhere else (an export, even one inside some other repository, whose
 * index says nothing about these files) there is no git to ask, and this refuses unless the caller sets
 * SUPERSTABLES_SKILL_FROM_ARCHIVE=1 and names the commit in SUPERSTABLES_BUILD_COMMIT. That is a promise by the caller
 * that `root` is an unmodified `git archive` export of that commit, which holds exactly the commit's files, so every
 * file present counts as tracked. The build cannot check the promise: a file added to the export afterwards would be
 * included. Only the release script sets it, on an export it has just made.
 *
 * @param {string} root the package folder
 * @param {string} folder a folder inside it, such as skills/superstables-payments
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function trackedFiles(root, folder, env = process.env) {
  const dir = join(root, folder);
  if (isOwnGitCheckout(root)) {
    return execFileSync("git", ["ls-files", "-z", "--", "."], { cwd: dir, encoding: "utf8" }).split("\0").filter(Boolean);
  }
  if (env.SUPERSTABLES_SKILL_FROM_ARCHIVE !== "1") {
    throw new Error(
      `${root} is not the top of its own git checkout, so git cannot list the tracked files in ${folder}, and SUPERSTABLES_SKILL_FROM_ARCHIVE is not set. Set it only on an unmodified git archive export; otherwise a file left in the folder could ship.`,
    );
  }
  if (!/^[0-9a-f]{7,40}$/.test(env.SUPERSTABLES_BUILD_COMMIT ?? "")) {
    throw new Error(
      `SUPERSTABLES_SKILL_FROM_ARCHIVE=1 says this folder is a git archive export of a commit; name that commit in SUPERSTABLES_BUILD_COMMIT (got "${env.SUPERSTABLES_BUILD_COMMIT ?? ""}")`,
    );
  }
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath === dir ? "" : e.parentPath.slice(dir.length + 1), e.name).split("\\").join("/"));
}
