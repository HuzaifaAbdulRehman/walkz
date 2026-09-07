import { value } from './src/value.mjs';

if (value < 1) {
  console.error('src/value.mjs:1 value must stay positive');
  process.exit(1);
}
