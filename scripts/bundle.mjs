#!/usr/bin/env node
// Builds the Claude Desktop bundle: a single .mcpb file holding the MCP server, its compiled
// JavaScript and its production dependencies.
//
// `--dev` stamps the staged manifest and package.json with a version derived from the commit
// (`0.1.0-dev.14+gabc1234`), so that two development builds of the same release are never
// called the same thing and a desktop host cannot silently keep an older one. The repository's
// own files are never touched; only the staged copies, which are what ships.
//
// The bundle is staged rather than packed in place, for one reason: what ships must be exactly
// what the manifest promises. The staging directory gets the manifest, a package.json stripped
// down to runtime dependencies, dist/, the README and the licence — and then its own
// node_modules, installed with --omit=dev so no test or build tooling travels to a user's
// machine. Nothing is copied that the server does not need at run time; src/, test/ and the
// lockfile stay behind.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSelfContained } from "./budget-build.mjs";
import { devVersion, revisionOf } from "./dev-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const stageDir = join(buildDir, "mcpb");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// The version everything staged below carries. Without --dev it is the released one, unchanged.
const dev = process.argv.slice(2).includes("--dev");
const version = dev ? devVersion(pkg.version, revisionOf(root)) : pkg.version;
if (dev) console.log(`Development build: ${version} (the repository's own files are left alone)`);

/** Runs a command, letting its output through, and fails the script if it fails. */
function run(command, args, cwd = root) {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

// Dependencies that only `superstables budget` loads. The MCP server never imports these; they stay
// out of the bundle. Each rail adds its own. `npm run build` also writes dist/budget/, the standalone
// budget build with these packages bundled in; it is for the skill zip (scripts/skill.mjs) and stays
// out of this bundle too.
const BUDGET_BUILD = "budget";
const BUDGET_ONLY_DEPENDENCIES = ["@x402/fetch", "mppx", "@solana/web3.js", "bs58"];

// 1. Compile. The bundle ships JavaScript; tsc is the only thing that produces it.
run("npm", ["run", "build"]);

// dist/budget must import only node: built-ins and its own files (it does not ship here, but the
// skill zip carries it with no node_modules).
checkSelfContained(join(root, "dist", BUDGET_BUILD));

// A package left out of the bundle must not be imported by anything that ships: that bundle would
// pack and validate, then fail on the user's machine at the first import.
const shipsInBundle = (file) => file.split(/[\\/]/)[0] !== BUDGET_BUILD;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const excludedImport = new RegExp(
  `(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)["'](${BUDGET_ONLY_DEPENDENCIES.map(escapeRe).join("|")})(?:/[^"']*)?["']`,
);
for (const file of readdirSync(join(root, "dist"), { recursive: true })) {
  if (!/\.[cm]?js$/.test(file) || !shipsInBundle(file)) continue;
  const hit = readFileSync(join(root, "dist", file), "utf8").match(excludedImport);
  if (hit) {
    throw new Error(`dist/${file} imports ${hit[1]}, which the bundle leaves out (BUDGET_ONLY_DEPENDENCIES in scripts/bundle.mjs)`);
  }
}

const entryPoint = join(root, "dist", "mcp", "main.js");
if (!existsSync(entryPoint)) {
  throw new Error(
    `the build produced no ${relative(root, entryPoint)}; the MCP server entry point must exist before a bundle can be packed`,
  );
}

// 2. Stage. A fresh directory every time, so a file deleted from the tree cannot survive in a bundle.
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// The manifest is the source of truth for everything but the version, which belongs to package.json.
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));
manifest.version = version;
writeFileSync(join(stageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// A package.json with dependencies and nothing else: this copy exists so `npm install` can
// resolve the server's runtime imports, not so anyone can build or test from it. The
// budget-only dependencies are left out.
writeFileSync(
  join(stageDir, "package.json"),
  `${JSON.stringify(
    {
      name: pkg.name,
      // What `clientVersion()` reads at run time: the staged copy is the package.json that
      // ships inside the bundle, so a stamped build reports itself as one.
      version,
      description: pkg.description,
      license: pkg.license,
      type: pkg.type,
      main: "dist/mcp/main.js",
      engines: pkg.engines,
      dependencies: Object.fromEntries(
        Object.entries(pkg.dependencies).filter(([name]) => !BUDGET_ONLY_DEPENDENCIES.includes(name)),
      ),
    },
    null,
    2,
  )}\n`,
);

cpSync(join(root, "dist"), join(stageDir, "dist"), {
  recursive: true,
  filter: (from) => shipsInBundle(relative(join(root, "dist"), from) || "."),
});
if (existsSync(join(stageDir, "dist", BUDGET_BUILD))) throw new Error(`dist/${BUDGET_BUILD} was staged into the bundle`);
for (const file of ["README.md", "LICENSE", "policy.example.yaml"]) {
  if (existsSync(join(root, file))) cpSync(join(root, file), join(stageDir, file));
}

// 3. Install the runtime dependencies into the staging directory. --ignore-scripts because a
//    bundle must never run a dependency's install hook on the machine that packs it.
run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stageDir);

// 4. Validate the manifest that will actually ship, then pack.
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
run(npx, ["mcpb", "validate", join(stageDir, "manifest.json")]);

const output = join(buildDir, `superstables-${version}.mcpb`);
rmSync(output, { force: true });
run(npx, ["mcpb", "pack", stageDir, output]);

const bytes = statSync(output).size;
console.log(`\nBundle: ${output}`);
console.log(`Size:   ${(bytes / 1024 / 1024).toFixed(2)} MB (${bytes.toLocaleString("en-US")} bytes)`);
