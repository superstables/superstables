// Test-only terminal simulation for the wallet's passphrase prompts: stdin and stderr claim to be a terminal, and what a
// test pipes into stdin is what the owner "types". Production code has no environment bypass.
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stderr, "isTTY", { value: true });
process.stdin.setRawMode = function setRawMode() {
  return this;
};
