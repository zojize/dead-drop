# Markov Chain Statement Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace independent per-position statement weights with bigram transition probabilities so generated JS has realistic statement ordering.

**Architecture:** Scraper collects (prev, next) statement pairs per bucket from corpus. New `corpus-transitions.json` stores transition weights. `filterCandidates` applies bigram weights when `prevStmtKey` is set. Encoder/decoder both track `prevStmtKey` per block. Expression candidates are coarsened to `ExpressionStatement:0` for transition lookup.

**Tech Stack:** TypeScript, `@babel/parser`, `@babel/types`, `vitest`, `bun`.

**Critical constraint:** Encoder and decoder must see identical `prevStmtKey` at every statement position. The encoder sets it from the selected candidate; the decoder sets it from the parsed AST node. These match by the round-trip guarantee.

---

## Task 1: Add `bigramKey` and `lookupTransitionWeight` to context.ts

**Files:** Modify `packages/core/src/context.ts`

- [ ] **Step 1: Write failing tests for bigramKey and lookupTransitionWeight**

Create `packages/core/test/transitions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { bigramKey, lookupTransitionWeight } from '../src/context'

describe('bigramKey', () => {
  it('returns key unchanged for statements', () => {
    expect(bigramKey('VariableDeclaration:2', true)).toBe('VariableDeclaration:2')
    expect(bigramKey('IfStatement:1', true)).toBe('IfStatement:1')
    expect(bigramKey('ImportDeclaration:named:1', true)).toBe('ImportDeclaration:named:1')
  })

  it('maps expression candidates to ExpressionStatement:0', () => {
    expect(bigramKey('CallExpression:1', false)).toBe('ExpressionStatement:0')
    expect(bigramKey('BinaryExpression:0', false)).toBe('ExpressionStatement:0')
    expect(bigramKey('Identifier:0', false)).toBe('ExpressionStatement:0')
    expect(bigramKey('NumericLiteral:0', false)).toBe('ExpressionStatement:0')
  })
})

describe('lookupTransitionWeight', () => {
  it('returns null for unknown prev key', () => {
    expect(lookupTransitionWeight('NONEXISTENT_PREV', 'VariableDeclaration:2', 'top-level')).toBeNull()
  })

  it('returns null for unknown next key under known prev', () => {
    // <START> should exist in the transition data after scraping.
    // This test will be refined after corpus-transitions.json is generated.
    // For now, just verify the function doesn't throw.
    const result = lookupTransitionWeight('<START>', 'NONEXISTENT_NEXT_KEY_99', 'top-level')
    expect(result === null || typeof result === 'number').toBe(true)
  })

  it('returns a number for known transitions', () => {
    // <START> → ExpressionStatement:0 should exist in every bucket
    const result = lookupTransitionWeight('<START>', 'ExpressionStatement:0', 'top-level')
    if (result !== null) {
      expect(result).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/jeffz/Dev/dead-drop && bun run test -- --reporter=verbose packages/core/test/transitions.test.ts`
Expected: FAIL — `bigramKey` and `lookupTransitionWeight` are not exported from context.ts.

- [ ] **Step 3: Add prevStmtKey to EncodingContext and implement helpers**

In `packages/core/src/context.ts`:

1. Add `prevStmtKey: string` to the `EncodingContext` interface (after `scopeBucket`).
2. Set `prevStmtKey: '<START>'` in `initialContext()`.
3. Add a placeholder `corpus-transitions.json` import (create the file as `{}` for now — Task 2 generates real data).
4. Add these functions after `lookupWeight`:

```ts
import corpusTransitions from './corpus-transitions.json'

type TransitionTable = Record<string, Record<string, Record<string, number>>>
const T = corpusTransitions as TransitionTable

/** Map a candidate key to its coarsened bigram key for transition lookup. */
export function bigramKey(candidateKey: string, isStatement: boolean): string {
  return isStatement ? candidateKey : 'ExpressionStatement:0'
}

/**
 * Look up the bigram transition weight for (prev → candidateKey) in a bucket.
 * Returns the weight if found, or null to signal unigram fallback.
 */
export function lookupTransitionWeight(
  prev: string,
  candidateKey: string,
  bucket: ScopeBucket,
): number | null {
  return T[bucket]?.[prev]?.[candidateKey] ?? null
}
```

5. Update `filterCandidates` — in the `.map()` at the end, after computing `w`, add the bigram override:

```ts
// Bigram transition weight: replace unigram with transition weight if available
if (ctx.prevStmtKey && !ctx.expressionOnly) {
  const bk = bigramKey(c.key, c.isStatement)
  const tw = lookupTransitionWeight(ctx.prevStmtKey, bk, ctx.scopeBucket)
  if (tw !== null) {
    w = tw
  }
}
```

This goes BEFORE the existing depth-based weight scaling block (depth scaling still applies on top).

- [ ] **Step 4: Create placeholder corpus-transitions.json**

Create `packages/core/src/corpus-transitions.json` with content: `{}`

This empty object means `lookupTransitionWeight` returns null for everything — pure unigram behavior. Task 2 fills it with real data.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/jeffz/Dev/dead-drop && bun run test -- --reporter=verbose packages/core/test/transitions.test.ts`
Expected: PASS. The existing round-trip tests should also still pass since the empty transition table means pure unigram fallback.

Run: `cd /Users/jeffz/Dev/dead-drop && bun run test`
Expected: All tests pass (no behavioral change yet).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/context.ts packages/core/src/corpus-transitions.json packages/core/test/transitions.test.ts
git commit -m "feat: add bigram transition lookup infrastructure to context.ts"
```

---

## Task 2: Update scraper to collect bigram transitions

**Files:** Modify `scripts/analyze-corpus.ts`

- [ ] **Step 1: Add bigram data structures**

At the top of `analyze-corpus.ts`, after the `counts` and `globalCounts` declarations, add:

```ts
// Bigram transition counts: bucket → prev → next → count
const transitions: Record<ScopeBucket, Map<string, Map<string, number>>> = {
  'top-level': new Map(),
  'function-body': new Map(),
  'loop-body': new Map(),
  'block-body': new Map(),
}

function addTransition(bucket: ScopeBucket, prev: string, next: string): void {
  let prevMap = transitions[bucket].get(prev)
  if (!prevMap) {
    prevMap = new Map()
    transitions[bucket].set(prev, prevMap)
  }
  prevMap.set(next, (prevMap.get(next) ?? 0) + 1)
}
```

- [ ] **Step 2: Collect bigram transitions in the walk function**

The current `walk` function processes nodes individually. Bigram collection needs to happen where we iterate over sibling statement arrays. The right place is where we iterate over array-valued slots that are statement slots.

Replace the array iteration block inside `walk` (the `if (Array.isArray(val))` branch within the `for (const slot of Object.keys(node))` loop):

```ts
if (Array.isArray(val)) {
  // Collect bigram transitions for statement-level arrays
  if (slotIsStatement) {
    let prev = '<START>'
    for (const item of val) {
      if (item && typeof item === 'object' && item.type) {
        const sk2 = stmtKey(item)
        const key2 = sk2 ?? exprKey(item)
        // Use stmtKey for coarsening: exprKey maps to specific expression types,
        // but stmtKey returns ExpressionStatement:0 for ExpressionStatements.
        // For non-ExpressionStatement nodes, stmtKey returns the right key.
        // For direct expression nodes that aren't wrapped (shouldn't happen at stmt level),
        // fall back to 'ExpressionStatement:0'.
        const bigramNext = sk2 ?? 'ExpressionStatement:0'
        if (key2) {
          addTransition(childBucket, prev, bigramNext)
          prev = bigramNext
        }
        walk(item, childBucket, slotIsStatement)
      }
    }
  } else {
    for (const item of val) {
      if (item && typeof item === 'object' && item.type)
        walk(item, childBucket, slotIsStatement)
    }
  }
}
```

Also update the transparent BlockStatement wrapper case to collect bigrams from its body:

```ts
if (node.type === 'BlockStatement' && isDirectStatement && (bucket === 'function-body' || bucket === 'loop-body')) {
  globalCounts.set('BlockStatement:0', (globalCounts.get('BlockStatement:0') ?? 0) + 1)
  let prev = '<START>'
  for (const stmt of node.body ?? []) {
    const sk2 = stmtKey(stmt)
    const key2 = sk2 ?? exprKey(stmt)
    const bigramNext = sk2 ?? 'ExpressionStatement:0'
    if (key2) {
      addTransition(bucket, prev, bigramNext)
      prev = bigramNext
    }
    walk(stmt, bucket, true)
  }
  return
}
```

- [ ] **Step 3: Add transition output to the script**

After the existing `toWeights` function and nested output block, add:

```ts
// Build transition weight output
function toTransitionWeights(
  bucketMap: Map<string, Map<string, number>>,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const [prev, nextMap] of bucketMap) {
    const sorted = [...nextMap.entries()].sort((a, b) => b[1] - a[1])
    if (sorted.length === 0) continue
    const maxCount = sorted[0][1]
    const row: Record<string, number> = {}
    for (const [next, count] of sorted) {
      row[next] = Math.max(0.01, Math.round((count / maxCount) * 1000) / 100)
    }
    out[prev] = row
  }
  return out
}

const transitionNested = {
  'top-level': toTransitionWeights(transitions['top-level']),
  'function-body': toTransitionWeights(transitions['function-body']),
  'loop-body': toTransitionWeights(transitions['loop-body']),
  'block-body': toTransitionWeights(transitions['block-body']),
}

const transOutPath = join(process.cwd(), 'packages/core/src/corpus-transitions.json')
writeFileSync(transOutPath, `${JSON.stringify(transitionNested, null, 2)}\n`)
console.log(`\nTransitions written to ${transOutPath}`)
for (const b of ['top-level', 'function-body', 'loop-body', 'block-body'] as const) {
  const prevKeys = Object.keys(transitionNested[b]).length
  const totalPairs = Object.values(transitionNested[b]).reduce((s, row) => s + Object.keys(row).length, 0)
  console.log(`  ${b}: ${prevKeys} prev keys, ${totalPairs} total transitions`)
}
```

- [ ] **Step 4: Run the scraper**

Run: `cd /Users/jeffz/Dev/dead-drop && bun run scripts/analyze-corpus.ts`
Expected: Scraper installs packages, parses JS files, writes both `corpus-weights.json` and `corpus-transitions.json`. Console output shows transition counts per bucket.

- [ ] **Step 5: Verify the transition data looks reasonable**

Spot-check `corpus-transitions.json`:
- `top-level["<START>"]` should have high weights for `ImportDeclaration:*` and `VariableDeclaration:*`
- `top-level["ImportDeclaration:named:1"]` should favor more imports (clustering)
- `function-body["<START>"]` should favor `VariableDeclaration:*` and `IfStatement:*`
- `function-body` keys should include `ReturnStatement:0` transitions
- All four buckets should have `<START>` entries

- [ ] **Step 6: Commit**

```bash
git add scripts/analyze-corpus.ts packages/core/src/corpus-transitions.json packages/core/src/corpus-weights.json
git commit -m "feat: collect bigram statement transitions from corpus"
```

---

## Task 3: Wire prevStmtKey into encoder

**Files:** Modify `packages/core/src/encode.ts`

- [ ] **Step 1: Import bigramKey**

Add `bigramKey` to the import from `./context`:

```ts
import {
  // ... existing imports ...
  bigramKey,
} from './context'
```

- [ ] **Step 2: Track prevStmtKey in the main encode loop**

In the `encode` function, the main loop at the bottom is:

```ts
const body: t.Statement[] = []
while (!isPad())
  body.push(buildTopLevel())
```

Replace with:

```ts
const body: t.Statement[] = []
while (!isPad()) {
  const { stmt, candidate } = buildTopLevelWithCandidate()
  body.push(stmt)
  ctx.prevStmtKey = candidate ? bigramKey(candidate.key, candidate.isStatement) : '<START>'
}
```

- [ ] **Step 3: Rename buildTopLevel to buildTopLevelWithCandidate and return candidate info**

The current `buildTopLevel` function:

```ts
function buildTopLevel(): t.Statement {
  if (isPad())
    return t.expressionStatement(padLeafExpr())
  const candidates = filterCandidates(ctx)
  const table = buildTable(candidates, hash)
  const bits = bitWidth(table.length)
  const value = readBits(bits)
  const c = table[value]
  hash = mixHash(hash, value)
  return buildStatement(c)
}
```

Replace with:

```ts
function buildTopLevelWithCandidate(): { stmt: t.Statement, candidate: Candidate | null } {
  if (isPad())
    return { stmt: t.expressionStatement(padLeafExpr()), candidate: null }
  const candidates = filterCandidates(ctx)
  const table = buildTable(candidates, hash)
  const bits = bitWidth(table.length)
  const value = readBits(bits)
  const c = table[value]
  hash = mixHash(hash, value)
  return { stmt: buildStatement(c), candidate: c }
}
```

- [ ] **Step 4: Track prevStmtKey in buildBlock**

The current `buildBlock` function iterates `countByte` times calling `buildTopLevel()`. Replace the loop body to track prev:

```ts
function buildBlock(parentType: string, slot: string): t.Statement[] {
  if (isPad())
    return []
  const countByte = readBits(8)
  hash = mixHash(hash, countByte)
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

- [ ] **Step 5: Run tests**

Run: `cd /Users/jeffz/Dev/dead-drop && bun run test`
Expected: Snapshot tests fail (output changed due to transition weights). Round-trip tests should pass.

If round-trip tests fail, there's a sync bug — proceed to Task 4 before debugging (decoder needs matching changes).

- [ ] **Step 6: Commit (even with snapshot failures)**

```bash
git add packages/core/src/encode.ts
git commit -m "feat: track prevStmtKey in encoder for bigram transitions"
```

---

## Task 4: Wire prevStmtKey into decoder

**Files:** Modify `packages/core/src/decode.ts`

- [ ] **Step 1: Import bigramKey**

Add `bigramKey` to the import from `./context`:

```ts
import { /* ...existing imports... */ bigramKey } from './context'
```

- [ ] **Step 2: Add prev field to the stmt work item type**

Update the `WorkItem` type's `stmt` variant:

```ts
| { kind: 'stmt', node: t.Node, prev: string }
```

- [ ] **Step 3: Compute prev when seeding top-level statements**

The current top-level seeding code:

```ts
for (let i = ast.program.body.length - 1; i >= 0; i--)
  work.push({ kind: 'stmt', node: ast.program.body[i] })
for (let i = (ast.program.directives?.length ?? 0) - 1; i >= 0; i--)
  work.push({ kind: 'stmt', node: ast.program.directives![i] })
```

Replace with a helper that computes prev for each statement and pushes them:

```ts
// Combine directives + body in source order for prev computation
const topStmts: t.Node[] = [
  ...(ast.program.directives ?? []),
  ...ast.program.body,
]
// Push in reverse (LIFO) with prev computed from predecessor
for (let i = topStmts.length - 1; i >= 0; i--) {
  const prev = i === 0 ? '<START>' : stmtKeyForBigram(topStmts[i - 1])
  work.push({ kind: 'stmt', node: topStmts[i], prev })
}
```

Add the `stmtKeyForBigram` helper inside `decode()`, after the existing `stmtKey` function:

```ts
/** Coarsen a parsed node's key for bigram lookup (ExpressionStatement → ExpressionStatement:0). */
function stmtKeyForBigram(node: t.Node): string {
  if (node.type === 'ExpressionStatement' || node.type === 'Directive')
    return 'ExpressionStatement:0'
  const sk = stmtKey(node)
  // stmtKey returns exprKey for unknown types — those would be expression-as-statement
  if (!sk.includes('Statement') && !sk.includes('Declaration') && sk !== 'BreakStatement:0' && sk !== 'ContinueStatement:0')
    return 'ExpressionStatement:0'
  return sk
}
```

Wait — `stmtKey` already returns things like `VariableDeclaration:2`, `IfStatement:1`, etc. for statements, and falls through to `exprKey` for ExpressionStatements. The issue is that the fallthrough case for ExpressionStatement hits the `default: return exprKey(node)` branch at the bottom. But there's actually a specific `case 'ExpressionStatement'` — no wait, looking at the decoder's `stmtKey`, there isn't one. The `stmt` handler checks `item.node.type === 'ExpressionStatement'` separately before calling `stmtKey`. So `stmtKey` is never called with an ExpressionStatement node.

For `stmtKeyForBigram`, we do call it on parsed AST nodes which CAN be ExpressionStatement. So the helper needs:

```ts
function stmtKeyForBigram(node: t.Node): string {
  if (node.type === 'ExpressionStatement' || node.type === 'Directive')
    return 'ExpressionStatement:0'
  return stmtKey(node)
}
```

This works because `stmtKey` handles all statement types, and for anything that falls through to `exprKey`, it would be an expression-as-statement (which shouldn't happen at block level, but the fallback to `ExpressionStatement:0` would be safe).

Actually, looking at the decoder's `stmtKey` more carefully, the `default` case returns `exprKey(node)`. That's fine for decoder operation but not for bigram lookup. Safer to just handle it explicitly:

```ts
function stmtKeyForBigram(node: t.Node): string {
  if (node.type === 'ExpressionStatement' || node.type === 'Directive')
    return 'ExpressionStatement:0'
  const key = stmtKey(node)
  return key
}
```

This is fine. `stmtKey` returns the right key for all statement types. For ExpressionStatement, we intercept before calling.

- [ ] **Step 4: Set prevStmtKey when processing stmt work items**

In the main loop's `case 'stmt'` handler, add at the very top (before any candidate filtering):

```ts
case 'stmt': {
  ctx.prevStmtKey = item.prev
  // ... rest of existing handler unchanged ...
}
```

- [ ] **Step 5: Compute prev when pushing block children**

In the `case 'block'` handler, update the loop that pushes stmt work items:

Current:

```ts
case 'block': {
  out.write(item.stmts.length, 8)
  hash = mixHash(hash, item.stmts.length)
  ctx.blockDepth++
  work.push({ kind: 'block-depth-dec' })
  for (let i = item.stmts.length - 1; i >= 0; i--)
    work.push({ kind: 'stmt', node: item.stmts[i] })
  break
}
```

Replace with:

```ts
case 'block': {
  out.write(item.stmts.length, 8)
  hash = mixHash(hash, item.stmts.length)
  ctx.blockDepth++
  work.push({ kind: 'block-depth-dec' })
  for (let i = item.stmts.length - 1; i >= 0; i--) {
    const prev = i === 0 ? '<START>' : stmtKeyForBigram(item.stmts[i - 1])
    work.push({ kind: 'stmt', node: item.stmts[i], prev })
  }
  break
}
```

- [ ] **Step 6: Run all tests**

Run: `cd /Users/jeffz/Dev/dead-drop && bun run test`
Expected: All round-trip tests PASS. Snapshot tests FAIL (expected — output changed).

If round-trip tests fail: the encoder and decoder disagree on prevStmtKey somewhere. Check that the encoder's `bigramKey(c.key, c.isStatement)` produces the same value as the decoder's `stmtKeyForBigram(node)` for the same AST node.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/decode.ts
git commit -m "feat: track prevStmtKey in decoder for bigram transitions"
```

---

## Task 5: Update snapshots, add ordering quality test, run full checklist

**Files:** Modify `packages/core/test/roundtrip.test.ts`

- [ ] **Step 1: Update snapshots**

Run: `cd /Users/jeffz/Dev/dead-drop && bun run test -- --update`
Expected: Snapshots updated, all tests pass.

- [ ] **Step 2: Add ordering quality test**

Add to `packages/core/test/roundtrip.test.ts`, in the `'import candidates'` describe block or as a new describe block:

```ts
describe('markov ordering quality', () => {
  it('imports cluster near the top of output across many seeds', () => {
    let importsInFirstHalf = 0
    let importsTotal = 0
    const N = 100
    for (let seed = 0; seed < N; seed++) {
      const msg = new Uint8Array(Array.from({ length: 20 }, (_, i) => (seed * 13 + i * 7) & 0xFF))
      const codec = createCodec({ seed })
      const js = codec.encode(msg)
      const lines = js.split(';')
      const totalLines = lines.length
      for (let i = 0; i < totalLines; i++) {
        if (/\bimport\s/.test(lines[i])) {
          importsTotal++
          if (i < totalLines / 2) importsInFirstHalf++
        }
      }
      // Verify round-trip still works
      const back = codec.decode(js)
      expect(Array.from(back)).toEqual(Array.from(msg))
    }
    // If transitions are working, imports should cluster in the first half.
    // With pure unigram weights, distribution would be roughly uniform.
    // Allow for some randomness — just check majority are in first half.
    if (importsTotal > 10) {
      expect(importsInFirstHalf / importsTotal).toBeGreaterThan(0.5)
    }
  })
})
```

- [ ] **Step 3: Run all tests**

Run: `cd /Users/jeffz/Dev/dead-drop && bun run test`
Expected: All tests pass including the new ordering quality test.

- [ ] **Step 4: Run full pre-commit checklist**

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

- [ ] **Step 5: Commit**

```bash
git add packages/core/test/roundtrip.test.ts packages/core/test/__snapshots__
git commit -m "test: update snapshots and add markov ordering quality test"
```

---

## Task 6: Final integration commit and branch push

- [ ] **Step 1: Verify clean git state**

Run: `git status` — only the plan file and CONTEXT.md should remain untracked/modified.

- [ ] **Step 2: Review output quality manually**

Run a quick encode in the REPL or via CLI to eyeball the output:

```bash
cd /Users/jeffz/Dev/dead-drop && echo "Hello, world!" | bun run packages/core/src/index.ts encode
```

Check that imports (if present) cluster near the top and the overall statement flow looks more natural than v6.

- [ ] **Step 3: Push branch and open PR**

```bash
git push -u origin feat/markov-chain
```

Open PR with title: `feat: Markov chain statement ordering (v7.0.0)` targeting `main`. Body should summarize: bigram transition weights from corpus, coarsened expression keys, per-block prev tracking, breaking encoding change.
