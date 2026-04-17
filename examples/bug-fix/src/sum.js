// Inclusive sum of integers from 1 to n. Returns 0 for n <= 0.
export function sumTo(n) {
  if (n <= 0) return 0;
  let total = 0;
  // BUG: off-by-one — this loop stops one short.
  for (let i = 1; i < n; i++) {
    total += i;
  }
  return total;
}
