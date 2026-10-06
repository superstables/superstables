// Test-only terminal simulation. Production unlock has no environment bypass.
Object.defineProperty(process.stdin, 'isTTY', { value: true });
