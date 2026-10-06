import { join } from 'node:path';
const [root, path, action] = process.argv.slice(2);
const { lockFile } = await import(join(root, 'budget/op-lock.mjs'));
const lock = lockFile(path);
console.log(JSON.stringify(lock.ok ? { ok: true } : lock));
if (lock.ok && action === 'hold') setInterval(() => {}, 1000);
else if (lock.ok) lock.release();
