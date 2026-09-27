// Deterministic RndA for the oracle diff: both engines must use identical
// "random" bytes so the APDU streams are comparable byte-for-byte.
//
// __DET_RAND_PATTERN__ (array of bytes) wins when set; otherwise a single
// fill byte (__DET_RAND_FILL__, default 0x11) is repeated.
export function randomBytes(n) {
  const pattern = globalThis.__DET_RAND_PATTERN__;
  if (pattern) return Buffer.from(pattern.slice(0, n));
  const fill = globalThis.__DET_RAND_FILL__ ?? 0x11;
  return Buffer.alloc(n, fill);
}
