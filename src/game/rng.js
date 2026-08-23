// Deterministic, injectable randomness for the headless game core.
// mulberry32: tiny, fast, good-enough distribution; the same seed always
// produces the same sequence so agent-driven runs are reproducible.
export function createRng(seed = 0x2f6e2b1) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
