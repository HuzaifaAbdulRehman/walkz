import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const childPath = fileURLToPath(new URL('./tree-child.mjs', import.meta.url));
const child = spawn(process.execPath, [childPath], {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
});

console.log(JSON.stringify({ role: 'parent', pid: process.pid }));
console.log(JSON.stringify({ role: 'spawned-child', pid: child.pid }));
setInterval(() => {}, 1_000);
