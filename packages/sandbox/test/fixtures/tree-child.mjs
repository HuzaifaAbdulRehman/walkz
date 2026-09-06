import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const grandchildPath = fileURLToPath(
  new URL('./tree-grandchild.mjs', import.meta.url),
);
const grandchild = spawn(process.execPath, [grandchildPath], {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
});

console.log(JSON.stringify({ role: 'child', pid: process.pid }));
console.log(JSON.stringify({ role: 'grandchild', pid: grandchild.pid }));
setInterval(() => {}, 1_000);
