#!/usr/bin/env node
if (Number(process.versions.node.split(".")[0]) < 22) {
  process.stderr.write(`superstables needs Node 22 or newer; this is Node ${process.versions.node}.\n`);
  process.exit(2);
}
// --testnet makes this run testnet-only (src/core/mainnet-policy.js): read here, before any chain table loads, and passed
// on as SUPERSTABLES_TESTNET=1 so every process this one starts uses testnets too. Arguments after "--" are left alone.
{
  const end = process.argv.indexOf("--");
  for (let i = process.argv.length - 1; i >= 2; i--) {
    if (process.argv[i] === "--testnet" && (end === -1 || i < end)) {
      process.argv.splice(i, 1);
      process.env.SUPERSTABLES_TESTNET = "1";
    }
  }
}
void new Function('return import("./command.js")')();
