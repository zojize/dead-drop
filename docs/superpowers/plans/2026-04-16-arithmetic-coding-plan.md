# Arithmetic Coding Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace variable-bit-width table encoding with E1/E2/E3 arithmetic coding for near-optimal encoding efficiency.

**Architecture:** Add ArithEncoder (stego-encoder: message bits → symbol indices) and ArithDecoder (stego-decoder: symbol indices → message bits) using 30-bit precision E1/E2/E3 normalization. CDF replaces fixed-size power-of-2 tables. Block counts use geometric-distribution CDF. No `isPad()` short-circuits — every AST node goes through the arith coder for perfect encoder/decoder sync.

**Tech Stack:** TypeScript, `@babel/parser`, `@babel/types`, `vitest`, `bun`.

**Critical constraint:** Encoder and decoder must perform the EXACT same sequence of CDF operations. Any divergence (different CDF, different symbol count) corrupts the entire byte stream. The isPad() removal is the key fix from previous attempts.

---

## Task 1: Add AC primitives to context.ts

**Files:** Modify `packages/core/src/context.ts`

Add after the BitWriter section (keep BitWriter for now — decoder still uses it for the old approach until Task 3):

- `CDFEntry` interface, `CDF` interface
- `buildCDF(candidates, hash)` — weighted CDF with deterministic PRNG ordering
- `buildBlockCDF()` — cached geometric-distribution CDF for block counts (0-255)
- `ArithEncoder` class — reads message bits, selects symbols via CDF (30-bit precision, E1/E2/E3)
- `ArithDecoder` class — recovers message bits from symbol indices via CDF

The ArithDecoder.finish() should ONLY return bits already emitted by normalization — do NOT flush pending E3 bits with arbitrary values.

Commit separately. No behavioral change yet.

---

## Task 2: Convert encode.ts to arithmetic coding

**Files:** Modify `packages/core/src/encode.ts`

Replace:
- `BitWriter` + `buildTable` + `bitWidth` + `readBits` → `ArithEncoder` + `buildCDF` + `buildBlockCDF`
- Remove ALL `isPad()` checks from `buildExpr()`, `buildBlock()`, `buildTopLevel()`
- Every expression/statement/block-count selection goes through `arith.decode(cdf)`
- Main loop: `while (arith.bitsConsumed < arith.dataBits + 256)` (generous margin)
- `hash = mixHash(hash, idx)` where idx is the CDF index (not the old table value)

Key patterns (from the stash):
```ts
// Expression selection
const cdf = buildCDF(candidates, hash)
const idx = arith.decode(cdf)
const c = cdf.entries[idx].candidate
hash = mixHash(hash, idx)

// Block count
const blockCdf = buildBlockCDF()
const countIdx = arith.decode(blockCdf)
hash = mixHash(hash, countIdx)
// countIdx IS the block count (variant field)
```

No isPad, no padLeafExpr for data-carrying positions. Cosmetic children at max depth still use padLeafExpr (those don't go through arith).

Commit separately. Tests WILL fail until Task 3.

---

## Task 3: Convert decode.ts to arithmetic coding

**Files:** Modify `packages/core/src/decode.ts`

Replace:
- `BitWriter` + `buildTable` + `buildReverseTable` + `bitWidth` → `ArithDecoder` + `buildCDF` + `buildBlockCDF`
- `out.write(value, bits)` → `arith.encode(cdf, idx)` where idx comes from `cdf.reverseMap.get(key)`
- Block count: `out.write(count, 8)` → `arith.encode(blockCdf, blockCdf.reverseMap.get('block:' + count))`
- Final recovery: `arith.finish()` instead of `out.toBytes()`
- `hash = mixHash(hash, idx)` matching the encoder

For the `Directive` case in stmtKey: map to `'StringLiteral:0'` as before.

Commit separately. Tests should pass after this.

---

## Task 4: Test, debug, verify pending resolution

Run `bun run test`. Expected: some round-trip failures due to pending E3 bits.

If failures occur:
1. Add instrumentation to ArithDecoder to log `this.pending` at finish()
2. If pending > 0: increase the margin in encode.ts (try +512, +1024)
3. If pending is always 0 but bytes differ: there's a CDF sync bug — compare symbol sequences

If the margin alone doesn't resolve pending bits, add explicit resolution:
```ts
// After main loop, force-resolve pending by encoding high-probability symbols
while (arith.pending > 0) {
  // Encode most-probable symbol from a flat CDF to trigger E1/E2 normalization
  const flatCdf = buildCDF(filterCandidates(ctx), hash)
  const idx = arith.decode(flatCdf)
  hash = mixHash(hash, idx)
  body.push(buildStatement(cdf.entries[idx].candidate))
}
```

Wait — `arith` is the ArithEncoder (stego-encoder side). It doesn't have a `pending` field. Only the ArithDecoder (stego-decoder) has pending. The encoder can't know how many pending bits the decoder will have.

Alternative: the encoder generates enough symbols that the decoder's pending count reaches 0. Empirically test different margins. The 256-bit margin from the stash should cover most cases (each symbol resolves ~1 pending bit through E1/E2 normalization).

Commit with passing tests + updated snapshots.

---

## Task 5: Pre-commit checklist + PR

Run full checklist: build, lint, typecheck, knip, test, playground build.
Bump version to 7.0.0 (breaking: new encoding format).
Update README encoding efficiency section.
Push + open PR.
