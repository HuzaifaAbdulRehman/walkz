export function applyDiscount(total, discount) {
  return Math.max(total - discount, 0);
}
