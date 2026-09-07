import { boundary } from './src/value.mjs';

if (boundary(0) !== 0) {
  console.error('src/value.mjs:1 boundary(0) should be 0');
  process.exit(1);
}
