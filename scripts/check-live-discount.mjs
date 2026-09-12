import { applyDiscount } from '../fixtures/live/discount.mjs';

if (applyDiscount(5, 10) !== 0) {
  console.error(
    'fixtures/live/discount.mjs:2 expected a discount to keep the total non-negative',
  );
  process.exitCode = 1;
}
