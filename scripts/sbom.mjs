// A CycloneDX 1.5 software bill of materials (JSON) of what the client ships, written by the builds:
//   dist/sbom.cdx.json                                         the npm package (scripts/budget-build.mjs)
//   superstables-payments/scripts/sbom.cdx.json in the skill zip (scripts/cli-build.mjs)
//
// Each component is one name@version with its licence, the npm tarball it came from and that tarball's SHA-512, and
// two kinds of property: `superstables:delivery` (installed: an install of the client adds it; bundled: dist/budget or
// the skill carries it inside its own files) and `superstables:path` (every node_modules location it has in this
// checkout, which is what `npm audit` calls a node: scripts/bundle-audit.mjs matches advisories against them).
//
// npm 9 has no `npm sbom`, and the bundled packages are not in any installed tree, so the build writes the file itself.
// The output depends on no clock, machine or folder: the timestamp is the build's builtAt (the commit's time), there is
// no serial number, and every list is sorted. Two builds of one commit write the same bytes.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Every package an install of the client adds, from package-lock.json: its production entries, which leaves out the dev
 * packages and the optional peers of ws (bufferutil, utf-8-validate) that a consumer's install does not fetch.
 *
 * @param {string} root the package folder, with node_modules installed (the licences are read from there)
 * @returns {{ name: string, version: string, paths: string[], licence: string | null, tarball: string | null, integrity: string | null }[]}
 */
export function installedFromLock(root) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages ?? {};
  const out = [];
  for (const [key, v] of Object.entries(lock)) {
    if (key === "" || v.dev || v.optional || v.devOptional) continue;
    const name = v.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    let licence = null;
    try {
      const p = JSON.parse(readFileSync(join(root, key, "package.json"), "utf8"));
      const l = p.license ?? p.licence;
      licence = typeof l === "string" ? l : (l?.type ?? null);
    } catch {}
    out.push({ name, version: v.version, paths: [key], licence, tarball: v.resolved ?? null, integrity: v.integrity ?? null });
  }
  return out;
}

/** The package URL of an npm package: pkg:npm/%40scope/name@version. */
export function purl(name, version) {
  return `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {{ pkg: { name: string, license?: string }, stamp: { version: string, commit?: string | null, builtAt: string },
 *   installed: object[], bundled: object[] }} input `installed` and `bundled` are lists like installedFromLock's
 */
export function cycloneDx({ pkg, stamp, installed, bundled }) {
  const found = new Map(); // purl -> { name, version, licence, tarball, integrity, delivery: Set, paths: Set }
  for (const [delivery, list] of [["installed", installed], ["bundled", bundled]]) {
    for (const p of list) {
      const ref = purl(p.name, p.version);
      if (!found.has(ref)) found.set(ref, { name: p.name, version: p.version, licence: null, tarball: null, integrity: null, delivery: new Set(), paths: new Set() });
      const c = found.get(ref);
      c.licence ??= p.licence ?? null;
      c.tarball ??= p.tarball ?? null;
      c.integrity ??= p.integrity ?? null;
      c.delivery.add(delivery);
      for (const path of p.paths ?? []) c.paths.add(path);
    }
  }
  const components = [...found.entries()].sort(([a], [b]) => byText(a, b)).map(([ref, c]) => {
    const scoped = c.name.startsWith("@");
    const properties = [
      ...[...c.delivery].map((value) => ({ name: "superstables:delivery", value })),
      ...[...c.paths].map((value) => ({ name: "superstables:path", value })),
    ].sort((a, b) => byText(a.name, b.name) || byText(a.value, b.value));
    return {
      type: "library",
      "bom-ref": ref,
      ...(scoped ? { group: c.name.slice(0, c.name.indexOf("/")) } : {}),
      name: scoped ? c.name.slice(c.name.indexOf("/") + 1) : c.name,
      version: c.version,
      purl: ref,
      ...(c.licence ? { licenses: [{ expression: c.licence }] } : {}),
      ...(c.integrity?.startsWith("sha512-") ? { hashes: [{ alg: "SHA-512", content: Buffer.from(c.integrity.slice(7), "base64").toString("hex") }] } : {}),
      ...(c.tarball ? { externalReferences: [{ type: "distribution", url: c.tarball }] } : {}),
      properties,
    };
  });
  const self = purl(pkg.name, stamp.version);
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp: stamp.builtAt,
      tools: { components: [{ type: "application", name: "superstables scripts/sbom.mjs" }] },
      component: {
        type: "application",
        "bom-ref": self,
        group: pkg.name.slice(0, pkg.name.indexOf("/")),
        name: pkg.name.slice(pkg.name.indexOf("/") + 1),
        version: stamp.version,
        purl: self,
        licenses: [{ expression: pkg.license }],
        ...(stamp.commit ? { properties: [{ name: "superstables:commit", value: stamp.commit }] } : {}),
      },
    },
    components,
  };
}

/**
 * Writes the SBOM to `file` and returns it.
 *
 * @param {string} file where to write it; its folder is created
 * @param {{ root: string, stamp: object, installed: object[], bundled: object[] }} input `bundled` is the list the build's
 *   notices were written from (name, version, paths, licence, tarball, integrity)
 */
export function writeSbom(file, { root, stamp, installed, bundled }) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const bom = cycloneDx({
    pkg,
    stamp,
    installed,
    bundled: bundled.map((p) => ({ name: p.name, version: p.version, paths: p.paths, licence: p.licence, tarball: p.tarball, integrity: p.integrity })),
  });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(bom, null, 2) + "\n");
  return bom;
}
