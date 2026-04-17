# rANS Steganographic Encoding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace power-of-2 table encoding with rANS (range Asymmetric Numeral Systems) for near-optimal encoding efficiency.

**Architecture:** Add `RansState` class with encode/decode operations and `buildCDF` function to context.ts. Stego-encoder uses ANS decode (reads message bits from state, selects candidates). Stego-decoder uses two-pass approach: forward pass collects `(cdf, symbolIndex)` pairs, backward pass uses ANS encode to recover message bits. Block counts go through a geometric CDF instead of raw 8-bit values.

**Tech Stack:** TypeScript, `@babel/parser`, `@babel/types`, `vitest`, `bun`.

**Critical constraint:** Encoder and decoder must build identical CDFs at every position. CDF construction must be deterministic: same candidates + same weights = same frequency table. The hash still evolves identically on both sides via `mixHash(hash, symbolIndex)`.

---

## Task 1: Add rANS primitives and CDF builder to context.ts

**Files:** Modify `packages/core/src/context.ts`, Create `packages/core/test/rans.test.ts`

- [ ] **Step 1: Write failing tests for CDF construction**

Create `packages/core/test/rans.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildCDF, type CDF } from '../src/context'

describe('buildCDF', () => {
  it('builds CDF from weighted candidates', () => {
    const candidates = [
      { key: 'A', nodeType: 'A', variant: 0, children: [], weight: 3, isStatement: false },
      { key: 'B', nodeType: 'B', variant: 0, children: [], weight: 1, isStatement: false },
    ]
    const cdf = buildCDF(candidates)
    expect(cdf.total).toBe(1 << 12)
    expect(cdf.cumFreqs[0]).toBe(0)
    expect(cdf.freqs.length).toBe(2)
    expect(cdf.freqs[0]).toBeGreaterThan(cdf.freqs[1]) // A has higher weight
    expect(cdf.freqs[0] + cdf.freqs[1]).toBe(cdf.total)
    expect(cdf.candidates).toEqual(candidates)
  })

  it('assigns minimum frequency 1 to low-weight candidates', () => {
    const candidates = [
      { key: 'Big', nodeType: 'Big', variant: 0, children: [], weight: 1000, isStatement: false },
      { key: 'Tiny', nodeType: 'Tiny', variant: 0, children: [], weight: 0.001, isStatement: false },
    ]
    const cdf = buildCDF(candidates)
    expect(cdf.freqs[1]).toBeGreaterThanOrEqual(1)
    expect(cdf.freqs[0] + cdf.freqs[1]).toBe(cdf.total)
  })

  it('handles single candidate', () => {
    const candidates = [
      { key: 'Only', nodeType: 'Only', variant: 0, children: [], weight: 5, isStatement: false },
    ]
    const cdf = buildCDF(candidates)
    expect(cdf.freqs[0]).toBe(cdf.total)
    expect(cdf.cumFreqs[0]).toBe(0)
  })

  it('builds reverse map from candidate key to index', () => {
    const candidates = [
      { key: 'A:0', nodeType: 'A', variant: 0, children: [], weight: 3, isStatement: false },
      { key: 'B:1', nodeType: 'B', variant: 1, children: [], weight: 1, isStatement: false },
    ]
    const cdf = buildCDF(candidates)
    expect(cdf.reverseMap.get('A:0')).toBe(0)
    expect(cdf.reverseMap.get('B:1')).toBe(1)
  })

  it('is deterministic — same input produces same output', () => {
    const candidates = [
      { key: 'X', nodeType: 'X', variant: 0, children: [], weight: 2, isStatement: false },
      { key: 'Y', nodeType: 'Y', variant: 0, children: [], weight: 3, isStatement: false },
      { key: 'Z', nodeType: 'Z', variant: 0, children: [], weight: 1, isStatement: false },
    ]
    const a = buildCDF(candidates)
    const b = buildCDF(candidates)
    expect(a.freqs).toEqual(b.freqs)
    expect(a.cumFreqs).toEqual(b.cumFreqs)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jeffz/Dev/dead-drop && bun run test -- --reporter=verbose packages/core/test/rans.test.ts`
Expected: FAIL — `buildCDF` not exported.

- [ ] **Step 3: Implement buildCDF**

In `packages/core/src/context.ts`, add after the `lookupTransitionWeight` function:

```ts
// ─── CDF for rANS ─────────────────────────────────────────────────────────

/** CDF precision — total frequency sums to this power of 2. */
const CDF_BITS = 12
const CDF_TOTAL = 1 << CDF_BITS

export interface CDF {
  cumFreqs: number[]
  freqs: number[]
  total: number
  candidates: Candidate[]
  reverseMap: Map<string, number>
}

/**
 * Build a cumulative frequency table from weighted candidates.
 * Frequencies are proportional to weights, quantized to integers summing to CDF_TOTAL.
 * Every candidate gets at least frequency 1.
 */
export function buildCDF(candidates: Candidate[]): CDF {
  if (candidates.length === 0)
    throw new Error('No candidates for CDF')

  const n = candidates.length
  const totalWeight = candidates.reduce((s, c) => s + c.weight, 0)

  // Initial allocation: proportional to weight, minimum 1
  const freqs = new Array<number>(n)
  let allocated = 0
  for (let i = 0; i < n; i++) {
    freqs[i] = Math.max(1, Math.round((candidates[i].weight / totalWeight) * CDF_TOTAL))
    allocated += freqs[i]
  }

  // Adjust to hit exactly CDF_TOTAL: add/remove from the largest entry
  let largestIdx = 0
  for (let i = 1; i < n; i++) {
    if (freqs[i] > freqs[largestIdx])
      largestIdx = i
  }
  freqs[largestIdx] += CDF_TOTAL - allocated

  // Safety: if adjustment pushed largest below 1, redistribute
  if (freqs[largestIdx] < 1) {
    // Fallback: uniform distribution
    for (let i = 0; i < n; i++)
      freqs[i] = 1
    freqs[0] += CDF_TOTAL - n
  }

  // Build cumulative frequencies
  const cumFreqs = new Array<number>(n)
  cumFreqs[0] = 0
  for (let i = 1; i < n; i++)
    cumFreqs[i] = cumFreqs[i - 1] + freqs[i - 1]

  // Reverse map: candidate key → index
  const reverseMap = new Map<string, number>()
  for (let i = 0; i < n; i++)
    reverseMap.set(candidates[i].key, i)

  return { cumFreqs, freqs, total: CDF_TOTAL, candidates, reverseMap }
}
```

- [ ] **Step 4: Run CDF tests**

Run: `cd /Users/jeffz/Dev/dead-drop && bun run test -- --reporter=verbose packages/core/test/rans.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing tests for rANS encode/decode round-trip**

Add to `packages/core/test/rans.test.ts`:

```ts
import { buildCDF, ransEncode, ransDecode, type CDF } from '../src/context'

describe('rANS encode/decode', () => {
  const RANS_L = 1 << 16

  it('single symbol round-trips', () => {
    const candidates = [
      { key: 'A', nodeType: 'A', variant: 0, children: [], weight: 3, isStatement: false },
      { key: 'B', nodeType: 'B', variant: 0, children: [], weight: 1, isStatement: false },
    ]
    const cdf = buildCDF(candidates)

    // Encode symbol 0 into a known state
    let x = RANS_L
    const bits: number[] = []
    x = ransEncode(x, 0, cdf, bits)

    // Decode should recover symbol 0
    const { newState, symbol } = ransDecode(x, cdf, bits)
    expect(symbol).toBe(0)
  })

  it('sequence of symbols round-trips via backward decode', () => {
    const candidates = [
      { key: 'A', nodeType: 'A', variant: 0, children: [], weight: 5, isStatement: false },
      { key: 'B', nodeType: 'B', variant: 0, children: [], weight: 3, isStatement: false },
      { key: 'C', nodeType: 'C', variant: 0, children: [], weight: 2, isStatement: false },
    ]
    const cdf = buildCDF(candidates)
    const symbols = [0, 1, 2, 0, 1, 0, 2, 1]

    // Forward encode: encode symbols 0..n-1
    let x = RANS_L
    const bits: number[] = []
    for (const s of symbols)
      x = ransEncode(x, s, cdf, bits)

    // Backward decode: decode in reverse order
    const recovered: number[] = []
    for (let i = symbols.length - 1; i >= 0; i--) {
      const result = ransDecode(x, cdf, bits)
      x = result.newState
      recovered.unshift(result.symbol)
    }
    expect(recovered).toEqual(symbols)
  })

  it('round-trips with varying CDFs per position', () => {
    const cdf1 = buildCDF([
      { key: 'X', nodeType: 'X', variant: 0, children: [], weight: 7, isStatement: false },
      { key: 'Y', nodeType: 'Y', variant: 0, children: [], weight: 3, isStatement: false },
    ])
    const cdf2 = buildCDF([
      { key: 'P', nodeType: 'P', variant: 0, children: [], weight: 1, isStatement: false },
      { key: 'Q', nodeType: 'Q', variant: 0, children: [], weight: 1, isStatement: false },
      { key: 'R', nodeType: 'R', variant: 0, children: [], weight: 1, isStatement: false },
    ])
    const pairs: { cdf: CDF, symbol: number }[] = [
      { cdf: cdf1, symbol: 0 },
      { cdf: cdf2, symbol: 2 },
      { cdf: cdf1, symbol: 1 },
      { cdf: cdf2, symbol: 0 },
    ]

    // Forward encode
    let x = RANS_L
    const bits: number[] = []
    for (const p of pairs)
      x = ransEncode(x, p.symbol, p.cdf, bits)

    // Backward decode
    const recovered: { symbol: number }[] = []
    for (let i = pairs.length - 1; i >= 0; i--) {
      const result = ransDecode(x, pairs[i].cdf, bits)
      x = result.newState
      recovered.unshift({ symbol: result.symbol })
    }
    expect(recovered.map(r => r.symbol)).toEqual(pairs.map(p => p.symbol))
  })
})
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd /Users/jeffz/Dev/dead-drop && bun run test -- --reporter=verbose packages/core/test/rans.test.ts`
Expected: FAIL — `ransEncode` and `ransDecode` not exported.

- [ ] **Step 7: Implement ransEncode and ransDecode**

Add to `packages/core/src/context.ts` after `buildCDF`:

```ts
/** rANS normalization threshold. State is kept in [RANS_L, 2*RANS_L). */
export const RANS_L = 1 << 16

/**
 * rANS encode: add symbol information to state.
 * Used by stego-DECODER (backward pass) to recover message bits.
 * Outputs bits when state gets too large (overflow → normalization).
 */
export function ransEncode(x: number, symbol: number, cdf: CDF, outBits: number[]): number {
  const freq = cdf.freqs[symbol]
  const cumFreq = cdf.cumFreqs[symbol]
  const M = cdf.total

  // Renormalize: output bits while state would overflow after encoding
  while (x >= freq * (RANS_L << 1)) {
    outBits.push(x & 1)
    x >>>= 1
  }

  // Core rANS encode: x' = (x / freq) * M + cumFreq + (x % freq)
  return Math.floor(x / freq) * M + cumFreq + (x % freq)
}

/**
 * rANS decode: extract symbol from state.
 * Used by stego-ENCODER to select candidates from message bits.
 * Reads bits when state gets too small (underflow → normalization).
 */
export function ransDecode(x: number, cdf: CDF, inBits: number[]): { newState: number, symbol: number } {
  const M = cdf.total

  // Extract symbol from state
  const t = x % M
  let symbol = cdf.cumFreqs.length - 1
  for (let i = 1; i < cdf.cumFreqs.length; i++) {
    if (cdf.cumFreqs[i] > t) {
      symbol = i - 1
      break
    }
  }

  const freq = cdf.freqs[symbol]
  const cumFreq = cdf.cumFreqs[symbol]

  // Core rANS decode: x' = (x / M) * freq + (x % M) - cumFreq
  x = Math.floor(x / M) * freq + t - cumFreq

  // Renormalize: read bits while state is too small
  while (x < RANS_L && inBits.length > 0)
    x = (x << 1) | inBits.pop()!

  return { newState: x, symbol }
}
```

- [ ] **Step 8: Run all rANS tests**

Run: `cd /Users/jeffz/Dev/dead-drop && bun run test -- --reporter=verbose packages/core/test/rans.test.ts`
Expected: All PASS.

- [ ] **Step 9: Add block count CDF builder**

Add to `packages/core/src/context.ts` after `ransDecode`:

```ts
/** Geometric CDF for block counts 0-255. Cached since it never changes. */
let _blockCDF: CDF | null = null
export function buildBlockCDF(): CDF {
  if (_blockCDF)
    return _blockCDF
  // Geometric distribution: P(k) ∝ 0.6^k, favoring small block counts
  const candidates: Candidate[] = []
  for (let k = 0; k <= 255; k++) {
    candidates.push({
      key: `block:${k}`,
      nodeType: 'BlockCount',
      variant: k,
      children: [],
      weight: 0.6 ** k,
      isStatement: false,
    })
  }
  _blockCDF = buildCDF(candidates)
  return _blockCDF
}
```

- [ ] **Step 10: Run all tests**

Run: `cd /Users/jeffz/Dev/dead-drop && bun run test`
Expected: All pass (no behavioral change yet — encoder/decoder still use old tables).

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/context.ts packages/core/test/rans.test.ts
git commit -m "feat: add rANS primitives, CDF builder, and block count CDF"
```

---

## Task 2: Convert encoder to rANS

**Files:** Modify `packages/core/src/encode.ts`

- [ ] **Step 1: Update imports**

Replace table-related imports with rANS imports:

```ts
import {
  ASSIGN_OPS,
  bigramKey,
  BINARY_OPS,
  buildBlockCDF,
  buildCDF,
  deriveScopeBucket,
  filterCandidates,
  inferTypeFromKey,
  initialContext,
  labelFromHash,
  LOGICAL_OPS,
  MAX_EXPR_DEPTH,
  mixHash,
  nameFromHash,
  ransDecode,
  RANS_L,
  UNARY_OPS,
  UPDATE_OPS,
} from './context'
```

Remove: `bitWidth`, `BitWriter`, `buildTable` from imports.

- [ ] **Step 2: Replace bitstream setup with rANS state initialization**

In the `encode` function, replace the bitstream setup block (lines 63-88, from `const writer = new BitWriter()` through the `readBits` function) with:

```ts
  // Initialize rANS state from message bits
  const prefixedBits: number[] = []
  for (let i = 0; i < prefixed.length; i++) {
    for (let b = 7; b >= 0; b--)
      prefixedBits.push((prefixed[i] >>> b) & 1)
  }
  // Reverse bits so pop() reads them in forward order
  prefixedBits.reverse()
  const totalBits = prefixedBits.length

  // Initialize state by reading bits until normalized
  let ransState = RANS_L
  while (ransState < (RANS_L << 1) && prefixedBits.length > 0)
    ransState = (ransState << 1) | prefixedBits.pop()!

  const key = opts.key
  let hash = key != null ? mixHash(0xDEADD, key) : 0xDEADD
  const rng = createRng(opts.seed ?? length)
  const ctx: EncodingContext = { ...initialContext(), maxExprDepth: opts.maxExprDepth ?? MAX_EXPR_DEPTH }
  const isPad = () => prefixedBits.length === 0 && ransState <= RANS_L

  /** Select a symbol from the CDF using rANS state. Returns symbol index. */
  function selectSymbol(cdf: ReturnType<typeof buildCDF>): number {
    // Renormalize: refill state from message bits
    while (ransState < RANS_L && prefixedBits.length > 0)
      ransState = (ransState << 1) | prefixedBits.pop()!

    const result = ransDecode(ransState, cdf, prefixedBits)
    ransState = result.newState
    return result.symbol
  }
```

- [ ] **Step 3: Replace buildExpr table logic with CDF**

Replace the `buildExpr` function body:

```ts
  function buildExpr(depth: number): { node: t.Expression, candidate: Candidate | null } {
    if (isPad())
      return { node: padLeafExpr(), candidate: null }

    const exprCtx = { ...ctx, expressionOnly: true, exprDepth: depth }
    const candidates = filterCandidates(exprCtx)
    const cdf = buildCDF(candidates)
    const idx = selectSymbol(cdf)
    const c = cdf.candidates[idx]
    hash = mixHash(hash, idx)

    const cosmetic = ctx.maxExprDepth < Infinity && depth >= ctx.maxExprDepth
    const node = buildExprNode(c, depth, cosmetic)
    return { node, candidate: c }
  }
```

- [ ] **Step 4: Replace buildBlock table logic with CDF + block CDF**

Replace the `buildBlock` function:

```ts
  function buildBlock(parentType: string, slot: string): t.Statement[] {
    if (isPad())
      return []
    const blockCdf = buildBlockCDF()
    const countIdx = selectSymbol(blockCdf)
    hash = mixHash(hash, countIdx)
    const countByte = blockCdf.candidates[countIdx].variant
    ctx.blockDepth++
    const prevBucket = ctx.scopeBucket
    ctx.scopeBucket = deriveScopeBucket(parentType, slot)
    const savedPrev = ctx.prevStmtKey
    ctx.prevStmtKey = '<START>'
    const stmts: t.Statement[] = []
    for (let i = 0; i < countByte; i++) {
      const { stmt, candidate } = buildTopLevelWithCandidate()
      stmts.push(stmt)
      ctx.prevStmtKey = candidate ? bigramKey(candidate.key, candidate.isStatement) : '<START>'
    }
    ctx.prevStmtKey = savedPrev
    ctx.scopeBucket = prevBucket
    ctx.blockDepth--
    return stmts
  }
```

- [ ] **Step 5: Replace buildTopLevelWithCandidate table logic with CDF**

Replace the `buildTopLevelWithCandidate` function:

```ts
  function buildTopLevelWithCandidate(): { stmt: t.Statement, candidate: Candidate | null } {
    if (isPad())
      return { stmt: t.expressionStatement(padLeafExpr()), candidate: null }
    const candidates = filterCandidates(ctx)
    const cdf = buildCDF(candidates)
    const idx = selectSymbol(cdf)
    const c = cdf.candidates[idx]
    hash = mixHash(hash, idx)
    return { stmt: buildStatement(c), candidate: c }
  }
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/encode.ts
git commit -m "feat: convert encoder to rANS candidate selection"
```

Tests WILL fail until the decoder is converted (Task 3).

---

## Task 3: Convert decoder to two-pass rANS

**Files:** Modify `packages/core/src/decode.ts`

- [ ] **Step 1: Update imports**

Replace table-related imports with rANS imports:

```ts
import { ASSIGN_OPS, bigramKey, BINARY_OPS, buildBlockCDF, buildCDF, type CDF, deriveScopeBucket, filterCandidates, inferTypeFromKey, initialContext, LOGICAL_OPS, MAX_EXPR_DEPTH, mixHash, nameFromHash, ransEncode, RANS_L, UNARY_OPS } from './context'
```

Remove: `bitWidth`, `BitWriter`, `buildReverseTable`, `buildTable` from imports.

- [ ] **Step 2: Add collected pairs array and replace BitWriter**

At the top of the `decode` function, replace `const out = new BitWriter()` with:

```ts
  // Collected (cdf, symbolIndex) pairs for backward rANS pass
  const pairs: { cdf: CDF, symbol: number }[] = []
```

- [ ] **Step 3: Replace the `expr` case**

Replace the `case 'expr'` handler (which currently builds a table, does reverse lookup, and writes bits) with:

```ts
      case 'expr': {
        const exprCtx = { ...ctx, expressionOnly: true, exprDepth: item.depth }
        const candidates = filterCandidates(exprCtx)
        const cdf = buildCDF(candidates)
        const key = exprKey(item.node)
        const symbol = cdf.reverseMap.get(key) ?? 0
        pairs.push({ cdf, symbol })
        hash = mixHash(hash, symbol)
        // At max depth, children are cosmetic — don't recurse
        if (ctx.maxExprDepth === Infinity || item.depth < ctx.maxExprDepth) {
          pushExprChildren(item.node, item.depth)
        }
        break
      }
```

- [ ] **Step 4: Replace the `stmt` case**

Replace the `case 'stmt'` handler:

```ts
      case 'stmt': {
        ctx.prevStmtKey = item.prev
        const candidates = filterCandidates(ctx)
        const cdf = buildCDF(candidates)
        const key = item.node.type === 'ExpressionStatement'
          ? exprKey((item.node as t.ExpressionStatement).expression)
          : stmtKey(item.node)
        const symbol = cdf.reverseMap.get(key) ?? 0
        pairs.push({ cdf, symbol })
        hash = mixHash(hash, symbol)
        pushStmtChildren(item.node)
        break
      }
```

- [ ] **Step 5: Replace the `block` case**

Replace the `case 'block'` handler:

```ts
      case 'block': {
        const blockCdf = buildBlockCDF()
        const countSymbol = blockCdf.reverseMap.get(`block:${item.stmts.length}`) ?? 0
        pairs.push({ cdf: blockCdf, symbol: countSymbol })
        hash = mixHash(hash, countSymbol)
        ctx.blockDepth++
        work.push({ kind: 'block-depth-dec' })
        for (let i = item.stmts.length - 1; i >= 0; i--) {
          const prev = i === 0 ? '<START>' : stmtKeyForBigram(item.stmts[i - 1])
          work.push({ kind: 'stmt', node: item.stmts[i], prev })
        }
        break
      }
```

- [ ] **Step 6: Replace the `var-decl` case**

Replace the `case 'var-decl'` handler:

```ts
      case 'var-decl': {
        const exprCtx = { ...ctx, expressionOnly: true, exprDepth: item.depth }
        const candidates = filterCandidates(exprCtx)
        const cdf = buildCDF(candidates)
        const key = exprKey(item.initNode)
        const symbol = cdf.reverseMap.get(key) ?? 0
        pairs.push({ cdf, symbol })
        hash = mixHash(hash, symbol)
        const inferredType = inferTypeFromKey(key)
        work.push({ kind: 'var-type-push', name: item.name, type: inferredType })
        if (ctx.maxExprDepth === Infinity || item.depth < ctx.maxExprDepth) {
          pushExprChildren(item.initNode, item.depth)
        }
        break
      }
```

- [ ] **Step 7: Replace bit recovery with backward rANS pass**

Replace the final byte recovery block (from `const bytes = out.toBytes()` to the return) with:

```ts
  // ─── Backward rANS pass: recover message bits ──────────────────────
  let ransState = RANS_L
  const recoveredBits: number[] = []

  for (let i = pairs.length - 1; i >= 0; i--) {
    const { cdf, symbol } = pairs[i]

    // rANS encode (adds symbol info to state, outputs overflow bits)
    ransState = ransEncode(ransState, symbol, cdf, recoveredBits)
  }

  // Extract remaining bits from the state
  while (ransState > RANS_L) {
    recoveredBits.push(ransState & 1)
    ransState >>>= 1
  }

  // Reverse bits (LIFO → FIFO) and convert to bytes
  recoveredBits.reverse()
  const byteCount = Math.floor(recoveredBits.length / 8)
  const bytes = new Uint8Array(byteCount)
  for (let i = 0; i < byteCount; i++) {
    let byte = 0
    for (let b = 0; b < 8; b++)
      byte = (byte << 1) | (recoveredBits[i * 8 + b] ?? 0)
    bytes[i] = byte
  }

  if (bytes.length < 4)
    return new Uint8Array(0)
  const payloadLength = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  return new Uint8Array(bytes.slice(4, 4 + payloadLength))
```

- [ ] **Step 8: Run all tests**

Run: `cd /Users/jeffz/Dev/dead-drop && bun run test`

Expected: Round-trip tests should pass if rANS encode/decode are correct. Snapshot tests will fail (different output).

If round-trip tests fail: add logging to compare the symbol indices from encoder vs decoder at each position. They must match exactly.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/decode.ts
git commit -m "feat: convert decoder to two-pass rANS bit recovery"
```

---

## Task 4: Debug, update snapshots, run full checklist

**Files:** Modify `packages/core/test/roundtrip.test.ts`, possibly `packages/core/src/encode.ts` or `packages/core/src/decode.ts`

- [ ] **Step 1: Run tests and diagnose failures**

Run: `cd /Users/jeffz/Dev/dead-drop && bun run test`

If round-trip tests pass but snapshots fail: proceed to step 2.

If round-trip tests fail: the encoder and decoder disagree somewhere. Debug by:
1. Adding `console.log` in both encoder (`selectSymbol`) and decoder (forward pass) to print `(position, cdfSize, symbolIndex)` at each position
2. Finding the first position where they diverge
3. Common causes: CDF built from different candidates (context mismatch), hash divergence, block count encoding mismatch

- [ ] **Step 2: Update snapshots**

Run: `cd /Users/jeffz/Dev/dead-drop && bun run test -- --update`
Expected: Snapshots updated, all tests pass.

- [ ] **Step 3: Run full pre-commit checklist**

```bash
cd /Users/jeffz/Dev/dead-drop
bun run --filter '@zojize/dead-drop' build
bun run lint
bun run typecheck
bun run knip
bun run test
cd playground && bunx vite build && cd ..
```

All must pass with zero errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/test packages/core/src
git commit -m "test: update snapshots for rANS encoding"
```

---

## Task 5: Clean up dead code, update README, push PR

**Files:** Modify `packages/core/src/context.ts`, `README.md`

- [ ] **Step 1: Remove dead table code from context.ts**

If `buildTable`, `buildReverseTable`, and `bitWidth` are no longer imported anywhere, remove them from `packages/core/src/context.ts`. Also remove `BitWriter` if it's no longer used. Run `bun run knip` to confirm what's unused.

- [ ] **Step 2: Update README**

In `README.md`, update the "Table construction" section to describe CDF/rANS instead of power-of-2 tables. Update the "Decoding" section to mention the two-pass approach.

- [ ] **Step 3: Run full pre-commit checklist again**

```bash
cd /Users/jeffz/Dev/dead-drop
bun run --filter '@zojize/dead-drop' build
bun run lint
bun run typecheck
bun run knip
bun run test
cd playground && bunx vite build && cd ..
```

- [ ] **Step 4: Commit and push**

```bash
git add -A
git commit -m "refactor: remove dead table code, update README for rANS"
git push -u origin feat/rans-encoding
```

- [ ] **Step 5: Open PR**

Title: `feat: rANS encoding for near-optimal efficiency`
Body: Summarize the change (power-of-2 tables → rANS, two-pass decoder, block count CDF, breaking encoding format).
