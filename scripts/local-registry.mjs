#!/usr/bin/env node
// A registry on 127.0.0.1 that serves one package version from a tarball, for scripts/install-check.mjs.
//
// npm learns that a package has a shrinkwrap from the registry's packument (`_hasShrinkwrap`, which registry.npmjs.org
// sets for a published package that carries one). It never learns it from a local tarball, so an install from a file
// ignores the shrinkwrap and cannot show what npx does. This server answers like the real registry for that one package.
//
// node scripts/local-registry.mjs <tarball>     prints the base URL on one line, then serves until it is killed

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const [tarball] = process.argv.slice(2);
if (!tarball || process.argv.length > 3) {
  console.error("usage: node scripts/local-registry.mjs <tarball>");
  process.exit(2);
}
const data = readFileSync(tarball);
const manifest = JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }));
const hasShrinkwrap = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n").includes("package/npm-shrinkwrap.json");

const server = createServer((req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`;
  if (req.url.endsWith(".tgz")) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(data);
    return;
  }
  const version = {
    ...manifest,
    _hasShrinkwrap: hasShrinkwrap,
    dist: {
      tarball: `${base}/${manifest.name}/-/package.tgz`,
      integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`,
      shasum: createHash("sha1").update(data).digest("hex"),
    },
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ name: manifest.name, "dist-tags": { latest: manifest.version }, versions: { [manifest.version]: version } }));
});
server.listen(0, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}/`));
