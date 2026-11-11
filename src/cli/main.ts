#!/usr/bin/env node
if (Number(process.versions.node.split(".")[0]) < 22) {
  process.stderr.write(`superstables needs Node 22 or newer; this is Node ${process.versions.node}.\n`);
  process.exit(2);
}
void import("./command.js");
