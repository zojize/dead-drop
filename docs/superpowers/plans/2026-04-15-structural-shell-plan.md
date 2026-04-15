# Structural Shell + Scope-Dependent Weights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ImportDeclaration` and `Export*Declaration` structural candidates at program top-level, plus scope-dependent weight distributions (top-level / function-body / loop-body / block-body) so the encoded output resembles real JavaScript modules.

**Architecture:** Add `scopeBucket` to `EncodingContext`. Convert `corpus-weights.json` from a flat record to a nested `{bucket: {key: weight}}` format with a `global` fallback. Add 6 new structural candidates gated on `ctx.scopeBucket === 'top-level'`. Export wrappers disambiguate via AST node type in decoder before reverse-lookup. Rewrite `scripts/analyze-corpus.ts` to track scope buckets during AST walk; extend `scripts/scrape-cosmetics.ts` with package names and import specifier names.

**Tech Stack:** TypeScript, `@babel/parser`, `@babel/types`, `vitest`, `bun`.

**Spec:** [`docs/superpowers/specs/2026-04-15-structural-shell-design.md`](../specs/2026-04-15-structural-shell-design.md)

---

## File Structure

**Modified files:**

- `packages/core/src/context.ts` — add `ScopeBucket` type, `scopeBucket` field on `EncodingContext`, update weight-lookup `w()` to take bucket, add `Import/Export*` candidate entries to `buildAllCandidates()`
- `packages/core/src/encode.ts` — push bucket transitions when entering function bodies, loops, blocks; build logic for new candidates
- `packages/core/src/decode.ts` — `bucket-enter` / `bucket-exit` work items, branching in `stmtKey` for export wrappers, `pushStmtChildren` support for imports/exports
- `packages/core/src/codegen.ts` — emit `import`, `export`, `export default` syntax
- `packages/core/src/corpus-weights.json` — nested format
- `packages/core/src/cosmetic-data.json` — add `packageNames`, `importedNames`
- `packages/core/package.json` — version bump to `6.0.0`
- `scripts/analyze-corpus.ts` — bucket-aware counting
- `scripts/scrape-cosmetics.ts` — collect package names and import specifiers

**New test files / additions:**

- `packages/core/test/scope-bucket.test.ts` — NEW; unit tests for `deriveScopeBucket` helper
- `packages/core/test/roundtrip.test.ts` — add import/export round-trip cases

---

## Task 1: Add ScopeBucket type and context field

**Files:**

- Modify: `packages/core/src/context.ts`
- Test: `packages/core/test/scope-bucket.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/scope-bucket.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { initialContext } from '../src/context'

describe('scope bucket', () => {
  it('initial context is top-level', () => {
    const ctx = initialContext()
    expect(ctx.scopeBucket).toBe('top-level')
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

```bash
bun run --filter '@zojize/dead-drop' test test/scope-bucket.test.ts
```

Expected: FAIL with "Property 'scopeBucket' does not exist" or `undefined`.

- [ ] **Step 3: Add the type and field**

In `packages/core/src/context.ts`, after the `ScopeEntry` interface (around line 35), add:

```ts
export type ScopeBucket = 'top-level' | 'function-body' | 'loop-body' | 'block-body'
```

In `EncodingContext` (around line 40), add the field:

```ts
export interface EncodingContext {
  inFunction: boolean
  inAsync: boolean
  inLoop: boolean
  scope: string[]
  typedScope: ScopeEntry[]
  expressionOnly: boolean
  exprDepth: number
  maxExprDepth: number
  blockDepth: number
  scopeBucket: ScopeBucket
}
```

In `initialContext()`, set the initial value:

```ts
export function initialContext(): EncodingContext {
  return {
    inFunction: false,
    inAsync: false,
    inLoop: false,
    scope: [],
    typedScope: [],
    expressionOnly: false,
    exprDepth: 0,
    maxExprDepth: MAX_EXPR_DEPTH,
    blockDepth: 0,
    scopeBucket: 'top-level',
  }
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
bun run --filter '@zojize/dead-drop' test test/scope-bucket.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full test suite to verify no regression**

```bash
bun run test
```

Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/context.ts packages/core/test/scope-bucket.test.ts
git commit -m "feat(context): add ScopeBucket type and scopeBucket field"
```

---

## Task 2: Add deriveScopeBucket helper

**Files:**

- Modify: `packages/core/src/context.ts`
- Test: `packages/core/test/scope-bucket.test.ts`

The encoder and decoder will both need to derive the scope bucket when entering a child block. Rather than duplicating the logic, centralize it in a pure helper that takes the immediate parent node type and slot and returns the bucket.

- [ ] **Step 1: Write failing tests**

Append to `packages/core/test/scope-bucket.test.ts`:

```ts
import { deriveScopeBucket } from '../src/context'

describe('deriveScopeBucket', () => {
  it('Program body → top-level', () => {
    expect(deriveScopeBucket('Program', 'body')).toBe('top-level')
  })

  it('FunctionDeclaration body → function-body', () => {
    expect(deriveScopeBucket('FunctionDeclaration', 'body')).toBe('function-body')
  })

  it('FunctionExpression body → function-body', () => {
    expect(deriveScopeBucket('FunctionExpression', 'body')).toBe('function-body')
  })

  it('ArrowFunctionExpression body → function-body', () => {
    expect(deriveScopeBucket('ArrowFunctionExpression', 'body')).toBe('function-body')
  })

  it('ForStatement body → loop-body', () => {
    expect(deriveScopeBucket('ForStatement', 'body')).toBe('loop-body')
  })

  it('WhileStatement body → loop-body', () => {
    expect(deriveScopeBucket('WhileStatement', 'body')).toBe('loop-body')
  })

  it('DoWhileStatement body → loop-body', () => {
    expect(deriveScopeBucket('DoWhileStatement', 'body')).toBe('loop-body')
  })

  it('ForOfStatement body → loop-body', () => {
    expect(deriveScopeBucket('ForOfStatement', 'body')).toBe('loop-body')
  })

  it('ForInStatement body → loop-body', () => {
    expect(deriveScopeBucket('ForInStatement', 'body')).toBe('loop-body')
  })

  it('IfStatement consequent → block-body', () => {
    expect(deriveScopeBucket('IfStatement', 'consequent')).toBe('block-body')
  })

  it('IfStatement alternate → block-body', () => {
    expect(deriveScopeBucket('IfStatement', 'alternate')).toBe('block-body')
  })

  it('BlockStatement body → block-body', () => {
    expect(deriveScopeBucket('BlockStatement', 'body')).toBe('block-body')
  })

  it('TryStatement block → block-body', () => {
    expect(deriveScopeBucket('TryStatement', 'block')).toBe('block-body')
  })

  it('CatchClause body → block-body', () => {
    expect(deriveScopeBucket('CatchClause', 'body')).toBe('block-body')
  })

  it('SwitchCase consequent → block-body', () => {
    expect(deriveScopeBucket('SwitchCase', 'consequent')).toBe('block-body')
  })

  it('LabeledStatement body → block-body', () => {
    expect(deriveScopeBucket('LabeledStatement', 'body')).toBe('block-body')
  })

  it('unknown parent → block-body (fallback)', () => {
    expect(deriveScopeBucket('Unknown', 'whatever')).toBe('block-body')
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
bun run --filter '@zojize/dead-drop' test test/scope-bucket.test.ts
```

Expected: FAIL with "deriveScopeBucket is not exported".

- [ ] **Step 3: Implement the helper**

In `packages/core/src/context.ts`, after the `ScopeBucket` type, add:

```ts
/**
 * Derive the scope bucket for code entering a parent node's slot.
 * Encoder and decoder must agree on this mapping identically.
 */
export function deriveScopeBucket(parentType: string, slot: string): ScopeBucket {
  if (parentType === 'Program')
    return 'top-level'
  if (parentType === 'FunctionDeclaration' || parentType === 'FunctionExpression' || parentType === 'ArrowFunctionExpression')
    return slot === 'body' ? 'function-body' : 'block-body'
  if (parentType === 'ForStatement' || parentType === 'WhileStatement' || parentType === 'DoWhileStatement' || parentType === 'ForOfStatement' || parentType === 'ForInStatement')
    return slot === 'body' ? 'loop-body' : 'block-body'
  return 'block-body'
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
bun run --filter '@zojize/dead-drop' test test/scope-bucket.test.ts
```

Expected: all 17 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/context.ts packages/core/test/scope-bucket.test.ts
git commit -m "feat(context): add deriveScopeBucket helper"
```

---

## Task 3: Convert corpus-weights.json to nested format (global-only, preserve current behavior)

Before adding bucket-specific weight data, migrate the existing flat file to nested format with only the `global` bucket populated. Weight lookup falls through to `global` for every bucket until we regenerate.

**Files:**

- Modify: `packages/core/src/corpus-weights.json`
- Modify: `packages/core/src/context.ts`

- [ ] **Step 1: Convert the JSON**

Read the current `packages/core/src/corpus-weights.json` content (a flat `{ "key": weight }` record) and wrap it under a `global` key. The new file is:

```json
{
  "top-level": {},
  "function-body": {},
  "loop-body": {},
  "block-body": {},
  "global": {
    "Identifier:0": 10,
    "MemberExpression:0": 2.42,
    ... (all existing entries verbatim)
  }
}
```

Concrete shell command to produce the new file:

```bash
node -e "
const fs = require('node:fs');
const path = 'packages/core/src/corpus-weights.json';
const flat = JSON.parse(fs.readFileSync(path, 'utf8'));
if (flat.global) { console.log('Already migrated'); process.exit(0); }
const nested = {
  'top-level': {},
  'function-body': {},
  'loop-body': {},
  'block-body': {},
  global: flat,
};
fs.writeFileSync(path, JSON.stringify(nested, null, 2) + '\n');
console.log('Migrated ' + Object.keys(flat).length + ' entries to global bucket');
"
```

- [ ] **Step 2: Update the type and lookup function in context.ts**

In `packages/core/src/context.ts`, replace the current `W` and `w` bindings (around lines 163-167) with:

```ts
type WeightTable = Record<string, number>
type BucketedWeights = {
  'top-level': WeightTable
  'function-body': WeightTable
  'loop-body': WeightTable
  'block-body': WeightTable
  'global': WeightTable
}

const W = corpusWeights as BucketedWeights

/**
 * Corpus-derived weight for a candidate key in a given bucket.
 * Falls through: bucket-specific → global → 0.01 default.
 */
function w(key: string, bucket: ScopeBucket = 'top-level'): number {
  return W[bucket]?.[key] ?? W.global[key] ?? 0.01
}
```

- [ ] **Step 3: Update `buildAllCandidates` to pass no bucket (keep current global behavior)**

The existing calls `w('SomeKey')` use the default `'top-level'` bucket, which falls through to `global`. No code changes needed in `buildAllCandidates` — this works by default since the top-level bucket is empty and falls through.

But there's still a problem: the current candidate pool has a fixed `weight` field, computed at module load. To make weights bucket-dependent, this must be computed per-context at `filterCandidates` time.

For this migration task, **do not restructure yet** — we just confirm the fallback works. The bucket-specific weight application happens in Task 5.

- [ ] **Step 4: Run full test suite, verify no regression**

```bash
bun run --filter '@zojize/dead-drop' typecheck
bun run test
```

Expected: all tests pass. The `global` fallback means the behavior is bit-identical to pre-migration.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/corpus-weights.json packages/core/src/context.ts
git commit -m "refactor(weights): migrate corpus-weights.json to bucketed format with global fallback"
```

---

## Task 4: Apply bucket-specific weights at filterCandidates time

The candidate pool currently sets `weight` statically at module load. Make it dynamic: `filterCandidates(ctx)` looks up the current weight from the bucket at call time, so changing `ctx.scopeBucket` changes which candidates are emphasized.

**Files:**

- Modify: `packages/core/src/context.ts`

- [ ] **Step 1: Write a failing test**

Append to `packages/core/test/scope-bucket.test.ts`:

```ts
import { filterCandidates } from '../src/context'

describe('bucket-dependent weights', () => {
  it('weight differs between top-level and function-body when bucket has entry', () => {
    // Temporarily mutate corpusWeights at test scope? No — instead, verify
    // that the lookup function dispatches on ctx.scopeBucket.
    // Without bucket data we can't assert different values. This test
    // asserts the plumbing: filterCandidates must produce different weight
    // for a key we've seeded via a spy.
    const ctxTop = { ...initialContext(), scopeBucket: 'top-level' as const }
    const ctxFn = { ...initialContext(), scopeBucket: 'function-body' as const, inFunction: true }
    const topCands = filterCandidates(ctxTop)
    const fnCands = filterCandidates(ctxFn)
    // ReturnStatement is only available when inFunction=true
    expect(fnCands.some(c => c.key === 'ReturnStatement:0')).toBe(true)
    expect(topCands.some(c => c.key === 'ReturnStatement:0')).toBe(false)
    // Both should have Identifier:0 (it's global)
    expect(topCands.some(c => c.key === 'Identifier:0')).toBe(true)
    expect(fnCands.some(c => c.key === 'Identifier:0')).toBe(true)
  })
})
```

This test doesn't actually verify the weight value (we have no bucket data yet), but it does confirm that the `scopeBucket` field is plumbed through `filterCandidates` without crashing.

- [ ] **Step 2: Run, verify it passes (plumbing test)**

```bash
bun run --filter '@zojize/dead-drop' test test/scope-bucket.test.ts
```

Expected: PASS (the test is about plumbing, not data).

- [ ] **Step 3: Make weights dynamic**

In `packages/core/src/context.ts`, at the bottom of `filterCandidates` (around line 436, inside the `.map((c) => { let w = c.weight; ... })` block), replace the initial `let w = c.weight` with a bucket-aware lookup:

```ts
  }).map((c) => {
    // Re-lookup weight using current bucket (falls through to global, then default)
    let w = lookupWeight(c.key, ctx.scopeBucket)

    // Dynamic weight: Identifier gets heavier with more scope entries
    if (c.nodeType === 'Identifier' && ctx.typedScope.length > 0) {
      w += ctx.typedScope.length * 0.5
    }

    // Depth-based weight scaling for expressions
    if (ctx.exprDepth > 0 && ctx.maxExprDepth < Infinity) {
      const depthRatio = ctx.exprDepth / ctx.maxExprDepth
      if (c.children.length === 0) {
        w *= 10 ** (depthRatio * 4)
      }
      else {
        w *= 0.1 ** (depthRatio * 4)
      }
    }

    return w !== c.weight ? { ...c, weight: w } : c
  })
```

Rename the module-local `w` function to `lookupWeight` to avoid the name collision with the local `let w` variable. Update all existing callers of `w(key)` in `buildAllCandidates` to call `lookupWeight(key)` instead.

```ts
function lookupWeight(key: string, bucket: ScopeBucket = 'top-level'): number {
  return W[bucket]?.[key] ?? W.global[key] ?? 0.01
}
```

The baseline `weight` field in each candidate is now just a default (used only if `lookupWeight` returns the default). The per-context bucket lookup is authoritative.

- [ ] **Step 4: Run full tests**

```bash
bun run --filter '@zojize/dead-drop' typecheck
bun run test
```

Expected: all pass. (Bucket data is still empty, so behavior remains identical to before.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/context.ts
git commit -m "refactor(weights): look up weight per-bucket at filterCandidates time"
```

---

## Task 5: Push bucket transitions in encoder

When the encoder descends into a child block (function body, loop body, if branch, etc.), it must update `ctx.scopeBucket` before processing children and restore it afterward.

**Files:**

- Modify: `packages/core/src/encode.ts`

- [ ] **Step 1: Identify the encoder's block-entry points**

Search `packages/core/src/encode.ts` for every place that processes a `block` child slot or recurses into a body. These are the call sites that need bucket updates. Concretely, the encoder's `buildBlock(ctx, count, parentType, slot)` function is the standard entry point — if it doesn't take `parentType/slot` params yet, add them.

Run:

```bash
grep -n 'buildBlock\|buildStatement\|inFunction = true\|inLoop = true' packages/core/src/encode.ts
```

Note the exact line numbers of each call.

- [ ] **Step 2: Thread parent context through buildBlock**

Update the signature of `buildBlock` (or whatever the encoder's block builder is named) to accept `parentType: string, slot: string` parameters. At the top of the function:

```ts
function buildBlock(ctx: EncodingContext, count: number, parentType: string, slot: string): t.Statement[] {
  const prevBucket = ctx.scopeBucket
  ctx.scopeBucket = deriveScopeBucket(parentType, slot)
  try {
    // ... existing body ...
    return stmts
  }
  finally {
    ctx.scopeBucket = prevBucket
  }
}
```

Import `deriveScopeBucket` from `./context`.

Then update every caller. For each `BlockStatement`, `FunctionExpression.body`, `IfStatement.consequent/alternate`, `ForStatement.body`, etc., pass the parent's node type and slot name.

Example: if the encoder currently does:

```ts
case 'IfStatement:0': // if-else
  return t.ifStatement(cond, t.blockStatement(buildBlock(ctx, n)), t.blockStatement(buildBlock(ctx, n2)))
```

Change to:

```ts
case 'IfStatement:0':
  return t.ifStatement(
    cond,
    t.blockStatement(buildBlock(ctx, n, 'IfStatement', 'consequent')),
    t.blockStatement(buildBlock(ctx, n2, 'IfStatement', 'alternate'))
  )
```

Apply this pattern to every `buildBlock` caller.

- [ ] **Step 3: Typecheck**

```bash
bun run --filter '@zojize/dead-drop' typecheck
```

Expected: no errors. If any caller was missed, TypeScript's required-parameter check will flag it.

- [ ] **Step 4: Run tests**

```bash
bun run test
```

Expected: all tests pass. (Bucket data is still empty, so behavior is unchanged — this just wires the transitions.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/encode.ts
git commit -m "feat(encode): thread scopeBucket through block transitions"
```

---

## Task 6: Push bucket transitions in decoder

The decoder must mirror the encoder's bucket transitions via work-stack items.

**Files:**

- Modify: `packages/core/src/decode.ts`

- [ ] **Step 1: Add bucket-enter / bucket-exit work items**

In `packages/core/src/decode.ts`, find the work-item type definition (top of file, likely a discriminated union). Add two new variants:

```ts
type WorkItem =
  | { kind: 'expr'; node: t.Node; depth: number }
  | { kind: 'stmt'; node: t.Node }
  | { kind: 'block'; nodes: t.Node[] }
  | { kind: 'scope-save' }
  | { kind: 'scope-restore'; /* existing fields */ }
  | { kind: 'inloop-enter' }
  | { kind: 'inloop-exit' }
  | { kind: 'var-type-push'; /* existing fields */ }
  | { kind: 'bucket-enter'; bucket: ScopeBucket }
  | { kind: 'bucket-exit'; bucket: ScopeBucket }
```

Import `ScopeBucket` and `deriveScopeBucket` from `./context`.

- [ ] **Step 2: Handle the new work items in the drain loop**

In the decoder's main drain loop (the `while (work.length > 0)` section), add cases:

```ts
case 'bucket-enter':
  ctx.scopeBucket = item.bucket
  break
case 'bucket-exit':
  ctx.scopeBucket = item.bucket  // item.bucket is the PREVIOUS bucket (restored)
  break
```

- [ ] **Step 3: Push bucket transitions when entering blocks**

Find the decoder's `pushStmtChildren` (or equivalent) handler. For each case that enters a block child, wrap the children push with bucket-enter / bucket-exit pairs:

LIFO order: push `bucket-exit` first, then block contents, then `bucket-enter`. When drained, encounter `bucket-enter` first, process block, then `bucket-exit`.

Example, for `IfStatement`:

```ts
case 'IfStatement': {
  const n = node as t.IfStatement
  const prevBucket = ctx.scopeBucket
  const childBucket = deriveScopeBucket('IfStatement', 'consequent')
  // For alternate branch (if exists)
  if (n.alternate) {
    work.push({ kind: 'bucket-exit', bucket: prevBucket })
    // push alternate block contents
    work.push({ kind: 'block', nodes: getBlockBody(n.alternate) })
    work.push({ kind: 'bucket-enter', bucket: deriveScopeBucket('IfStatement', 'alternate') })
  }
  // Consequent
  work.push({ kind: 'bucket-exit', bucket: prevBucket })
  work.push({ kind: 'block', nodes: getBlockBody(n.consequent) })
  work.push({ kind: 'bucket-enter', bucket: childBucket })
  // Test expression (no bucket change)
  work.push({ kind: 'expr', node: n.test, depth: 0 })
  break
}
```

Apply the same pattern to every statement type with a block child: `FunctionDeclaration/Expression`, `ArrowFunctionExpression` (when body is BlockStatement), `ForStatement`, `WhileStatement`, `DoWhileStatement`, `ForOfStatement`, `ForInStatement`, `BlockStatement`, `TryStatement` (block + handler body), `SwitchStatement` (each case's consequent), `LabeledStatement`.

**Important:** `prevBucket` must be captured at push-time (when this handler runs), not at drain-time. That's why it's stored on the `bucket-exit` work item.

- [ ] **Step 4: Typecheck**

```bash
bun run --filter '@zojize/dead-drop' typecheck
```

Expected: no errors.

- [ ] **Step 5: Run tests**

```bash
bun run test
```

Expected: all 39 existing tests pass. If any fail, check for mismatches between encoder and decoder bucket transitions — the LIFO push order must mirror the encoder's recursion order exactly.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/decode.ts
git commit -m "feat(decode): push bucket transitions via work-stack items"
```

---

## Task 7: Rewrite analyze-corpus.ts to track buckets

**Files:**

- Modify: `scripts/analyze-corpus.ts`

- [ ] **Step 1: Read the current scraper**

```bash
cat scripts/analyze-corpus.ts
```

Note the current walker and count structure. The scraper currently increments `counts[nodeKey]`. We'll maintain a stack of buckets during walk and increment `counts[currentBucket][nodeKey]` instead.

- [ ] **Step 2: Update the walker**

Replace the walk function in `scripts/analyze-corpus.ts` with a bucket-aware version:

```ts
import { deriveScopeBucket } from '../packages/core/src/context'

type ScopeBucket = 'top-level' | 'function-body' | 'loop-body' | 'block-body'

const counts: Record<ScopeBucket, Map<string, number>> = {
  'top-level': new Map(),
  'function-body': new Map(),
  'loop-body': new Map(),
  'block-body': new Map(),
}
const globalCounts = new Map<string, number>()

function inc(bucket: ScopeBucket, key: string) {
  counts[bucket].set(key, (counts[bucket].get(key) ?? 0) + 1)
  globalCounts.set(key, (globalCounts.get(key) ?? 0) + 1)
}

function nodeKey(node: any): string | null {
  // Reuse the existing key derivation. If current script has a function
  // like `nodeToKey(node)`, keep it and return null for uninteresting nodes.
  if (!node || typeof node !== 'object') return null
  // ... existing derivation logic (e.g., `${node.type}:${variant(node)}`) ...
  return `${node.type}:0`  // fallback — replace with real derivation
}

function walk(node: any, bucket: ScopeBucket): void {
  if (!node || typeof node !== 'object') return

  const key = nodeKey(node)
  if (key) inc(bucket, key)

  // For every child, compute the child bucket based on this node's type and child slot name
  for (const slot of Object.keys(node)) {
    if (slot === 'type' || slot === 'start' || slot === 'end' || slot === 'loc' || slot === 'extra' || slot === 'leadingComments' || slot === 'trailingComments') continue
    const val = node[slot]
    const childBucket = slot === 'body' || slot === 'consequent' || slot === 'alternate' || slot === 'block'
      ? deriveScopeBucket(node.type, slot)
      : bucket  // non-statement slots (expressions) inherit parent bucket
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object' && item.type) walk(item, childBucket)
      }
    }
    else if (val && typeof val === 'object' && val.type) {
      walk(val, childBucket)
    }
  }
}

// Start walking each parsed AST as:
walk(ast.program, 'top-level')
```

Also change the output serialization. At the end of the script:

```ts
function normalize(m: Map<string, number>, total: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of m.entries()) {
    const weight = (v / total) * 100  // preserve the scale of the existing file
    if (weight >= 0.01) out[k] = Math.round(weight * 100) / 100
  }
  return out
}

const total = [...globalCounts.values()].reduce((a, b) => a + b, 0)
const topLevelTotal = [...counts['top-level'].values()].reduce((a, b) => a + b, 0) || 1
const fnTotal = [...counts['function-body'].values()].reduce((a, b) => a + b, 0) || 1
const loopTotal = [...counts['loop-body'].values()].reduce((a, b) => a + b, 0) || 1
const blockTotal = [...counts['block-body'].values()].reduce((a, b) => a + b, 0) || 1

const nested = {
  'top-level': normalize(counts['top-level'], topLevelTotal),
  'function-body': normalize(counts['function-body'], fnTotal),
  'loop-body': normalize(counts['loop-body'], loopTotal),
  'block-body': normalize(counts['block-body'], blockTotal),
  global: normalize(globalCounts, total),
}

writeFileSync('packages/core/src/corpus-weights.json', `${JSON.stringify(nested, null, 2)}\n`)
```

Replace the existing single-record emission.

- [ ] **Step 3: Typecheck**

```bash
bun run --filter '@zojize/dead-drop' typecheck
```

Expected: no errors in the script.

- [ ] **Step 4: Commit the scraper change (without regenerating yet)**

```bash
git add scripts/analyze-corpus.ts
git commit -m "feat(scripts): bucket-aware corpus analysis"
```

---

## Task 8: Regenerate corpus-weights.json with bucket data

**Files:**

- Modify: `packages/core/src/corpus-weights.json`

- [ ] **Step 1: Run the scraper**

```bash
bun run scripts/analyze-corpus.ts
```

This will install 83 npm packages into a temp dir, parse all `.js` files, walk each AST with bucket tracking, and write the new nested JSON. Expect 5-15 minutes runtime.

- [ ] **Step 2: Inspect the output**

```bash
node -e "
const w = require('./packages/core/src/corpus-weights.json');
for (const bucket of Object.keys(w)) {
  const top5 = Object.entries(w[bucket]).sort((a,b) => b[1]-a[1]).slice(0, 5);
  console.log(bucket + ':', top5);
}
"
```

Sanity checks:
- `top-level` should have `FunctionDeclaration`, `ImportDeclaration`, `VariableDeclaration`, `ExpressionStatement` among top entries (note: ImportDeclaration may not appear yet since the candidate isn't registered — but the corpus data can still include the key).
- `function-body` should rank `VariableDeclaration`, `ReturnStatement`, `IfStatement`, `ExpressionStatement` highly.
- `loop-body` should have `ExpressionStatement`, `IfStatement`, `BreakStatement`, `ContinueStatement`.
- `block-body` should look similar to function-body but without `ReturnStatement` dominance.

- [ ] **Step 3: Run all tests**

```bash
bun run test
```

Expected: all pass. (The weight re-distribution will change snapshot outputs, but no round-trip failures.)

- [ ] **Step 4: Update snapshots if needed**

```bash
bun run test -- -u
```

Then inspect the updated snapshot to confirm the output looks more module-like (may take effect fully only after import/export candidates are added in later tasks).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/corpus-weights.json packages/core/test/__snapshots__/roundtrip.test.ts.snap
git commit -m "feat(corpus): regenerate weights with bucket-specific distributions"
```

---

## Task 9: Extend scrape-cosmetics.ts to collect package names and import specifier names

**Files:**

- Modify: `scripts/scrape-cosmetics.ts`

- [ ] **Step 1: Add counters for new data**

At the top of `scripts/scrape-cosmetics.ts` alongside the existing counters, add:

```ts
const packageNames = new Map<string, number>()
const importedNames = new Map<string, number>()
```

- [ ] **Step 2: Add extraction cases in the walker**

In the `switch (node.type)` block inside `walk()`, add:

```ts
case 'ImportDeclaration':
  if (node.source?.type === 'StringLiteral' && node.source.value.length > 0 && node.source.value.length <= 50) {
    inc(packageNames, node.source.value)
  }
  if (Array.isArray(node.specifiers)) {
    for (const spec of node.specifiers) {
      // spec.local.name — the binding name
      if (spec.local?.type === 'Identifier' && RE_IDENT.test(spec.local.name) && !KEYWORDS.has(spec.local.name)) {
        inc(importedNames, spec.local.name)
      }
    }
  }
  break
```

- [ ] **Step 3: Include results in the output JSON**

At the bottom of the script, update the `cosmetics` object:

```ts
const cosmetics = {
  identifiers: topIdents,
  properties: topProps,
  strings: topStrings,
  numbers: topNumbers,
  functionNames: topFuncNames,
  packageNames: topN(packageNames, 200),
  importedNames: topN(importedNames, 200),
  globals: GLOBALS,
}
```

- [ ] **Step 4: Commit the scraper change**

```bash
git add scripts/scrape-cosmetics.ts
git commit -m "feat(scripts): scrape package names and import specifier names"
```

---

## Task 10: Regenerate cosmetic-data.json

**Files:**

- Modify: `packages/core/src/cosmetic-data.json`

- [ ] **Step 1: Run the scraper**

```bash
bun run scripts/scrape-cosmetics.ts
```

5-15 minutes.

- [ ] **Step 2: Verify the output has new fields**

```bash
node -e "
const d = require('./packages/core/src/cosmetic-data.json');
console.log('packageNames top 10:', d.packageNames.slice(0, 10));
console.log('importedNames top 10:', d.importedNames.slice(0, 10));
console.log('packageNames total:', d.packageNames.length);
console.log('importedNames total:', d.importedNames.length);
"
```

Sanity: `packageNames` should include `react`, `lodash`, `path`, `fs`, `node:fs`, `@babel/parser`, etc. `importedNames` should include names like `merge`, `debounce`, `useState`, `join`, etc.

- [ ] **Step 3: Run tests**

```bash
bun run test
```

Expected: all pass. (Cosmetic data is read by encoder at runtime, but no candidate uses the new fields yet.)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/cosmetic-data.json
git commit -m "feat(cosmetics): add packageNames and importedNames from corpus"
```

---

## Task 11: Add ImportDeclaration candidates to pool

**Files:**

- Modify: `packages/core/src/context.ts`

- [ ] **Step 1: Add a top-level filter gate**

In `filterCandidates(ctx)`, add a new gate above the returns:

```ts
// Top-level-only candidates: only available when scopeBucket === 'top-level'
if (
  (c.nodeType === 'ImportDeclaration' || c.nodeType === 'ExportNamedDeclaration' || c.nodeType === 'ExportDefaultDeclaration')
  && ctx.scopeBucket !== 'top-level'
)
  return false
```

- [ ] **Step 2: Add ImportDeclaration entries to buildAllCandidates**

In `buildAllCandidates()`, after the existing statement candidates, add:

```ts
// ImportDeclaration — top-level only
c.push({ key: 'ImportDeclaration:sideEffect', nodeType: 'ImportDeclaration', variant: 0, children: [], weight: lookupWeight('ImportDeclaration:sideEffect'), isStatement: true })
c.push({ key: 'ImportDeclaration:default', nodeType: 'ImportDeclaration', variant: 1, children: [], weight: lookupWeight('ImportDeclaration:default'), isStatement: true })
// Named imports with 1..4 specifiers
for (let n = 1; n <= 4; n++) {
  c.push({ key: `ImportDeclaration:named:${n}`, nodeType: 'ImportDeclaration', variant: 1 + n, children: [], weight: lookupWeight(`ImportDeclaration:named:${n}`), isStatement: true })
}
```

Variants: 0 = sideEffect, 1 = default, 2..5 = named with 1..4 specifiers. (This encoding simplifies decoder disambiguation.)

- [ ] **Step 3: Typecheck**

```bash
bun run --filter '@zojize/dead-drop' typecheck
```

Expected: no errors. (Encoder and decoder don't yet know how to build/parse these, but the pool compiles.)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/context.ts
git commit -m "feat(context): add ImportDeclaration candidates (sideEffect, default, named:1-4)"
```

---

## Task 12: Implement encoder support for ImportDeclaration

**Files:**

- Modify: `packages/core/src/encode.ts`

- [ ] **Step 1: Add cosmetic package-name and specifier-name helpers**

In `packages/core/src/encode.ts`, alongside `cosmeticIdent()` and `cosmeticFuncName()`, add:

```ts
import cosmeticData from './cosmetic-data.json'
const PACKAGE_NAMES: string[] = (cosmeticData as any).packageNames ?? []
const IMPORTED_NAMES: string[] = (cosmeticData as any).importedNames ?? []

function cosmeticPackageName(hash: number): string {
  if (PACKAGE_NAMES.length === 0) return 'pkg'
  return PACKAGE_NAMES[hash % PACKAGE_NAMES.length]
}

function cosmeticImportedName(hash: number, offset: number): string {
  if (IMPORTED_NAMES.length === 0) return nameFromHash(hash, offset)
  return IMPORTED_NAMES[mixHash(hash, offset) % IMPORTED_NAMES.length]
}
```

- [ ] **Step 2: Add build-case for ImportDeclaration**

In the encoder's `buildStatement` (or wherever the top-level candidate switch lives), add a case for ImportDeclaration. The logic:

```ts
case 'ImportDeclaration:sideEffect': {
  // import 'pkgname'
  const pkg = cosmeticPackageName(hash)
  return t.importDeclaration([], t.stringLiteral(pkg))
}
case 'ImportDeclaration:default': {
  // import Name from 'pkgname'
  const pkg = cosmeticPackageName(hash)
  const local = cosmeticImportedName(hash, 1)
  // Add binding to scope
  ctx.scope.push(local)
  ctx.typedScope.push({ name: local, type: 'any' })
  return t.importDeclaration(
    [t.importDefaultSpecifier(t.identifier(local))],
    t.stringLiteral(pkg),
  )
}
```

For the named variants (2..5 → 1..4 specifiers):

```ts
// Named imports: variants 2..5 mean 1..4 specifiers
default: {
  if (c.nodeType === 'ImportDeclaration' && c.variant >= 2 && c.variant <= 5) {
    const count = c.variant - 1  // 1..4
    const pkg = cosmeticPackageName(hash)
    const specifiers = []
    for (let i = 0; i < count; i++) {
      const local = cosmeticImportedName(hash, 10 + i)
      ctx.scope.push(local)
      ctx.typedScope.push({ name: local, type: 'any' })
      specifiers.push(t.importSpecifier(t.identifier(local), t.identifier(local)))
    }
    return t.importDeclaration(specifiers, t.stringLiteral(pkg))
  }
  // ...existing default
}
```

(Adapt to actual encoder switch structure — the branch may be on `c.key` rather than a separate switch.)

**Note:** ImportDeclaration has no expression children that carry bits, so there's no bit consumption beyond the table lookup that chose this candidate. The specifier count is determined by the variant index, which is itself encoded in the table slot's bits.

- [ ] **Step 3: Typecheck**

```bash
bun run --filter '@zojize/dead-drop' typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit (encoder only; decoder comes next)**

```bash
git add packages/core/src/encode.ts
git commit -m "feat(encode): build ImportDeclaration variants with cosmetic names"
```

---

## Task 13: Implement decoder + codegen for ImportDeclaration

**Files:**

- Modify: `packages/core/src/decode.ts`
- Modify: `packages/core/src/codegen.ts`

- [ ] **Step 1: Extend decoder `stmtKey` to recognize ImportDeclaration**

In `packages/core/src/decode.ts`, add a case to `stmtKey`:

```ts
case 'ImportDeclaration': {
  const n = node as t.ImportDeclaration
  if (n.specifiers.length === 0) return 'ImportDeclaration:sideEffect'
  // Default: exactly one specifier that is ImportDefaultSpecifier
  if (n.specifiers.length === 1 && n.specifiers[0].type === 'ImportDefaultSpecifier') return 'ImportDeclaration:default'
  // Named: all specifiers are ImportSpecifier
  if (n.specifiers.every(s => s.type === 'ImportSpecifier')) {
    const count = n.specifiers.length
    if (count >= 1 && count <= 4) return `ImportDeclaration:named:${count}`
  }
  // Unknown import shape — fall through
  return 'ImportDeclaration:default'
}
```

- [ ] **Step 2: Update decoder work-stack item pusher**

ImportDeclaration has no bit-carrying children. In `pushStmtChildren` (or whatever the decoder calls to enqueue child work), add a case for ImportDeclaration that pushes nothing (it's a leaf structurally) — but it does introduce scope bindings:

```ts
case 'ImportDeclaration': {
  const n = node as t.ImportDeclaration
  for (const spec of n.specifiers) {
    if (spec.local?.type === 'Identifier') {
      ctx.scope.push(spec.local.name)
      ctx.typedScope.push({ name: spec.local.name, type: 'any' })
    }
  }
  break
}
```

- [ ] **Step 3: Add codegen for ImportDeclaration**

In `packages/core/src/codegen.ts`'s `processStmt`, add a case:

```ts
case 'ImportDeclaration': {
  const n = node as t.ImportDeclaration
  // Output: import <specifiers> from 'source' OR import 'source'
  const src = JSON.stringify(n.source.value)
  if (n.specifiers.length === 0) {
    // Side-effect: import 'pkg'
    raw(`import ${src};`)
  }
  else if (n.specifiers.length === 1 && n.specifiers[0].type === 'ImportDefaultSpecifier') {
    raw(`import ${(n.specifiers[0].local as t.Identifier).name} from ${src};`)
  }
  else {
    // Named specifiers
    const specs = n.specifiers
      .filter(s => s.type === 'ImportSpecifier')
      .map(s => {
        const imp = s as t.ImportSpecifier
        const importedName = imp.imported.type === 'Identifier' ? imp.imported.name : (imp.imported as t.StringLiteral).value
        const localName = (imp.local as t.Identifier).name
        return importedName === localName ? localName : `${importedName} as ${localName}`
      })
      .join(',')
    raw(`import{${specs}}from ${src};`)
  }
  break
}
```

Because codegen here runs in reverse (work.pop()), any `raw(...)` call pushes to parts, and parts are concatenated at end. Verify: in this codegen, `raw(x)` appears to prepend via reversal. Check the actual emit pattern in the existing `VariableDeclaration` case above — for `var x = init;` it does `raw(';')`, then `expr(init)`, then `raw('var x =')`. The emit is in reverse because the work stack is drained in LIFO and strings are joined at end. Adjust the ImportDeclaration case to match this reverse pattern.

Concretely (matching the reverse pattern), the ImportDeclaration case becomes:

```ts
case 'ImportDeclaration': {
  const n = node as t.ImportDeclaration
  const src = JSON.stringify(n.source.value)
  if (n.specifiers.length === 0) {
    raw(`import ${src};`)  // single atomic string
  }
  else if (n.specifiers.length === 1 && n.specifiers[0].type === 'ImportDefaultSpecifier') {
    raw(`import ${(n.specifiers[0].local as t.Identifier).name} from ${src};`)
  }
  else {
    const specs = n.specifiers
      .filter(s => s.type === 'ImportSpecifier')
      .map(s => {
        const imp = s as t.ImportSpecifier
        const importedName = imp.imported.type === 'Identifier' ? imp.imported.name : (imp.imported as t.StringLiteral).value
        const localName = (imp.local as t.Identifier).name
        return importedName === localName ? localName : `${importedName} as ${localName}`
      })
      .join(',')
    raw(`import{${specs}}from ${src};`)
  }
  break
}
```

Since there are no expression children, the entire emission is a single `raw(...)` string — no reverse concern.

- [ ] **Step 4: Write round-trip test**

Add to `packages/core/test/roundtrip.test.ts`:

```ts
it('round-trips messages that encode as ImportDeclaration candidates', () => {
  // Probe: try many small messages; at least some should choose import candidates
  // Fuzz test — verify no crashes + data preserved
  for (let seed = 0; seed < 50; seed++) {
    const msg = new Uint8Array([seed, (seed * 7) & 0xFF, (seed * 13) & 0xFF])
    const codec = createCodec({ seed })
    const js = codec.encode(msg)
    const back = codec.decode(js)
    expect(back).toEqual(msg)
  }
})
```

- [ ] **Step 5: Run tests**

```bash
bun run --filter '@zojize/dead-drop' typecheck
bun run test
```

Expected: all tests pass including the new round-trip. If decoder fails: check `stmtKey` mapping matches encoder candidate keys exactly.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/decode.ts packages/core/src/codegen.ts packages/core/test/roundtrip.test.ts
git commit -m "feat(decode,codegen): round-trip ImportDeclaration candidates"
```

---

## Task 14: Add ExportDefaultDeclaration candidate

**Files:**

- Modify: `packages/core/src/context.ts`
- Modify: `packages/core/src/encode.ts`
- Modify: `packages/core/src/decode.ts`
- Modify: `packages/core/src/codegen.ts`

- [ ] **Step 1: Add candidate entry**

In `packages/core/src/context.ts`, in `buildAllCandidates()`:

```ts
// ExportDefaultDeclaration — top-level only; wraps an expression
c.push({ key: 'ExportDefaultDeclaration:0', nodeType: 'ExportDefaultDeclaration', variant: 0, children: ['expr'], weight: lookupWeight('ExportDefaultDeclaration:0'), isStatement: true })
```

- [ ] **Step 2: Add encoder case**

In `packages/core/src/encode.ts`'s `buildStatement`:

```ts
case 'ExportDefaultDeclaration:0': {
  const inner = buildExpr(ctx)  // reads bits, builds expression
  return t.exportDefaultDeclaration(inner)
}
```

- [ ] **Step 3: Add decoder `stmtKey` case**

In `packages/core/src/decode.ts`:

```ts
case 'ExportDefaultDeclaration': return 'ExportDefaultDeclaration:0'
```

Add child-pusher:

```ts
case 'ExportDefaultDeclaration': {
  const n = node as t.ExportDefaultDeclaration
  work.push({ kind: 'expr', node: n.declaration as t.Node, depth: 0 })
  break
}
```

- [ ] **Step 4: Add codegen**

In `packages/core/src/codegen.ts`'s `processStmt`, matching the existing reverse-emit pattern (VariableDeclaration precedent):

```ts
case 'ExportDefaultDeclaration': {
  const n = node as t.ExportDefaultDeclaration
  raw(';')
  expr(n.declaration as t.Expression)  // emits the expression in reverse
  raw('export default ')
  break
}
```

- [ ] **Step 5: Add round-trip tests**

```ts
it('round-trips messages encoding ExportDefaultDeclaration', () => {
  for (let seed = 100; seed < 150; seed++) {
    const msg = new Uint8Array([seed, (seed * 11) & 0xFF, 0xAB, 0xCD])
    const codec = createCodec({ seed })
    const js = codec.encode(msg)
    const back = codec.decode(js)
    expect(back).toEqual(msg)
  }
})
```

- [ ] **Step 6: Run tests**

```bash
bun run --filter '@zojize/dead-drop' typecheck
bun run test
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src
git commit -m "feat: round-trip ExportDefaultDeclaration candidate"
```

---

## Task 15: Add ExportNamedDeclaration:variable candidate

`export var x = 5;` / `export let x = 5;` / `export const x = 5;` — wraps a `VariableDeclaration`. The inner declaration carries the variant bits for `var`/`let`/`const`.

**Files:**

- Modify: `packages/core/src/context.ts`
- Modify: `packages/core/src/encode.ts`
- Modify: `packages/core/src/decode.ts`
- Modify: `packages/core/src/codegen.ts`

- [ ] **Step 1: Add candidate entry**

In `packages/core/src/context.ts`:

```ts
// ExportNamedDeclaration wrapping VariableDeclaration: 3 variants (var/let/const)
c.push({ key: 'ExportNamedDeclaration:variable:0', nodeType: 'ExportNamedDeclaration', variant: 0, children: ['expr'], weight: lookupWeight('ExportNamedDeclaration:variable:0'), isStatement: true })
c.push({ key: 'ExportNamedDeclaration:variable:1', nodeType: 'ExportNamedDeclaration', variant: 1, children: ['expr'], weight: lookupWeight('ExportNamedDeclaration:variable:1'), isStatement: true })
c.push({ key: 'ExportNamedDeclaration:variable:2', nodeType: 'ExportNamedDeclaration', variant: 2, children: ['expr'], weight: lookupWeight('ExportNamedDeclaration:variable:2'), isStatement: true })
```

- [ ] **Step 2: Encoder**

```ts
case 'ExportNamedDeclaration:variable:0':
case 'ExportNamedDeclaration:variable:1':
case 'ExportNamedDeclaration:variable:2': {
  const kind = c.variant === 0 ? 'var' : c.variant === 1 ? 'let' : 'const'
  const name = cosmeticIdent(hash)
  const init = buildExpr(ctx)
  ctx.scope.push(name)
  ctx.typedScope.push({ name, type: inferTypeFromKey(/* init candidate key */) })
  const decl = t.variableDeclaration(kind, [t.variableDeclarator(t.identifier(name), init)])
  return t.exportNamedDeclaration(decl, [])
}
```

- [ ] **Step 3: Decoder stmtKey**

```ts
case 'ExportNamedDeclaration': {
  const n = node as t.ExportNamedDeclaration
  if (n.declaration?.type === 'VariableDeclaration') {
    const kind = n.declaration.kind
    const variant = kind === 'var' ? 0 : kind === 'let' ? 1 : 2
    return `ExportNamedDeclaration:variable:${variant}`
  }
  // FunctionDeclaration case comes in next task
  return 'ExportNamedDeclaration:variable:0'  // fallback
}
```

Add child pusher:

```ts
case 'ExportNamedDeclaration': {
  const n = node as t.ExportNamedDeclaration
  if (n.declaration?.type === 'VariableDeclaration') {
    const vd = n.declaration as t.VariableDeclaration
    const init = vd.declarations[0]?.init
    if (init) work.push({ kind: 'expr', node: init, depth: 0 })
    // Bind variable name in scope (var-type-push after expr)
    // ... follow same pattern as regular VariableDeclaration ...
  }
  break
}
```

- [ ] **Step 4: Codegen**

```ts
case 'ExportNamedDeclaration': {
  const n = node as t.ExportNamedDeclaration
  if (n.declaration?.type === 'VariableDeclaration') {
    const vd = n.declaration as t.VariableDeclaration
    const d = vd.declarations[0]
    raw(';')
    expr(d.init as t.Expression)
    raw(`export ${vd.kind} ${(d.id as t.Identifier).name}=`)
  }
  // FunctionDeclaration case handled in next task
  break
}
```

- [ ] **Step 5: Round-trip test**

```ts
it('round-trips messages encoding ExportNamedDeclaration:variable', () => {
  for (let seed = 200; seed < 250; seed++) {
    const msg = new Uint8Array([seed, (seed * 17) & 0xFF, 0xEF])
    const codec = createCodec({ seed })
    const js = codec.encode(msg)
    const back = codec.decode(js)
    expect(back).toEqual(msg)
  }
})
```

- [ ] **Step 6: Run tests**

```bash
bun run --filter '@zojize/dead-drop' typecheck
bun run test
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src
git commit -m "feat: round-trip ExportNamedDeclaration:variable candidate"
```

---

## Task 16: Add ExportNamedDeclaration:function candidate

`export function foo() { ... }` — wraps a `FunctionExpression` (emitted as `FunctionDeclaration` syntactically). The inner function's param count is the variant's structural signal.

**Files:**

- Modify: `packages/core/src/context.ts`
- Modify: `packages/core/src/encode.ts`
- Modify: `packages/core/src/decode.ts`
- Modify: `packages/core/src/codegen.ts`

- [ ] **Step 1: Add candidate entries**

Because the inner function carries param-count bits, use one variant per param count (0..3 to start, keep the pool manageable):

```ts
// ExportNamedDeclaration wrapping FunctionDeclaration: param count 0..3
for (let n = 0; n <= 3; n++) {
  c.push({
    key: `ExportNamedDeclaration:function:${n}`,
    nodeType: 'ExportNamedDeclaration',
    variant: 10 + n,  // disambiguate from :variable variants 0..2
    children: ['expr'],
    weight: lookupWeight(`ExportNamedDeclaration:function:${n}`),
    isStatement: true,
  })
}
```

- [ ] **Step 2: Encoder**

```ts
// Match variant 10..13 for export-function with param count 0..3
default: {
  if (c.nodeType === 'ExportNamedDeclaration' && c.variant >= 10 && c.variant <= 13) {
    const paramCount = c.variant - 10
    const fnName = cosmeticFuncName(hash)
    const paramNames = Array.from({ length: paramCount }, (_, i) => nameFromHash(hash, 900 + i))
    // Enter function scope
    const savedScope = ctx.scope.slice()
    const savedTypedScope = ctx.typedScope.slice()
    const wasInFn = ctx.inFunction
    ctx.inFunction = true
    for (const p of paramNames) {
      ctx.scope.push(p)
      ctx.typedScope.push({ name: p, type: 'any' })
    }
    const body = t.blockStatement(buildBlock(ctx, /* count */ 1, 'FunctionDeclaration', 'body'))
    ctx.inFunction = wasInFn
    ctx.scope = savedScope
    ctx.typedScope = savedTypedScope
    // Also bind the function name in outer scope
    ctx.scope.push(fnName)
    ctx.typedScope.push({ name: fnName, type: 'function' })
    // Build as FunctionDeclaration
    const fd = t.functionDeclaration(
      t.identifier(fnName),
      paramNames.map(p => t.identifier(p)),
      body,
    )
    return t.exportNamedDeclaration(fd, [])
  }
  // existing default
}
```

(Align exactly with the existing FunctionExpression build pattern in encode.ts; reuse any helper like `enterFunctionScope`.)

- [ ] **Step 3: Decoder stmtKey**

```ts
case 'ExportNamedDeclaration': {
  const n = node as t.ExportNamedDeclaration
  if (n.declaration?.type === 'VariableDeclaration') {
    // existing case from Task 15
    const kind = n.declaration.kind
    const variant = kind === 'var' ? 0 : kind === 'let' ? 1 : 2
    return `ExportNamedDeclaration:variable:${variant}`
  }
  if (n.declaration?.type === 'FunctionDeclaration') {
    const paramCount = n.declaration.params.length
    if (paramCount >= 0 && paramCount <= 3) return `ExportNamedDeclaration:function:${paramCount}`
    return 'ExportNamedDeclaration:function:0'
  }
  return 'ExportNamedDeclaration:variable:0'
}
```

Child pusher: mirror the encoder's scope transitions (scope-save, inFunction push, param bindings, block, scope-restore, bucket-enter/exit for function-body).

- [ ] **Step 4: Codegen**

```ts
case 'ExportNamedDeclaration': {
  const n = node as t.ExportNamedDeclaration
  if (n.declaration?.type === 'FunctionDeclaration') {
    const fd = n.declaration
    const params = fd.params.map(p => (p as t.Identifier).name).join(',')
    raw('}')
    stmtList(fd.body.body)
    raw(`export function ${(fd.id as t.Identifier).name}(${params}){`)
    break
  }
  // existing VariableDeclaration case...
}
```

- [ ] **Step 5: Round-trip test**

```ts
it('round-trips messages encoding ExportNamedDeclaration:function', () => {
  for (let seed = 300; seed < 350; seed++) {
    const msg = new Uint8Array([seed, (seed * 19) & 0xFF, 0xFA, 0xCE])
    const codec = createCodec({ seed })
    const js = codec.encode(msg)
    const back = codec.decode(js)
    expect(back).toEqual(msg)
  }
})
```

- [ ] **Step 6: Run tests**

```bash
bun run --filter '@zojize/dead-drop' typecheck
bun run test
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src packages/core/test
git commit -m "feat: round-trip ExportNamedDeclaration:function candidate"
```

---

## Task 17: Fuzz test — verify new candidates actually appear and output looks modular

**Files:**

- Modify: `packages/core/test/roundtrip.test.ts`

- [ ] **Step 1: Add a test that inspects the output shape**

```ts
it('encoded output contains import/export statements at least some of the time', () => {
  let hasImport = 0
  let hasExport = 0
  const N = 200
  for (let seed = 0; seed < N; seed++) {
    const msg = new Uint8Array(Array.from({ length: 16 }, (_, i) => (seed * 7 + i) & 0xFF))
    const codec = createCodec({ seed })
    const js = codec.encode(msg)
    if (/\bimport\b/.test(js)) hasImport++
    if (/\bexport\b/.test(js)) hasExport++
    // Verify round-trip
    expect(codec.decode(js)).toEqual(msg)
  }
  // Weak assertion: at least 5% of outputs contain imports or exports.
  // Tune thresholds after inspecting corpus weights.
  expect(hasImport / N).toBeGreaterThan(0.05)
  expect(hasExport / N).toBeGreaterThan(0.02)
})
```

Thresholds are lower bounds — if they fail, either the weights for Import/Export aren't strong enough in `top-level` bucket, or the encoder is routing around them. Inspect with `console.log(js)` on a few failures to diagnose.

- [ ] **Step 2: Run**

```bash
bun run test
```

- [ ] **Step 3: Tune if needed**

If the thresholds fail because the corpus data has low Import/Export weights relative to other top-level candidates, tune by adjusting thresholds down — do NOT artificially inflate weights to pass the test. The distribution should match corpus reality.

- [ ] **Step 4: Commit**

```bash
git add packages/core/test/roundtrip.test.ts
git commit -m "test: verify import/export candidates appear in top-level distribution"
```

---

## Task 18: Bump version, regenerate snapshots, update README

**Files:**

- Modify: `packages/core/package.json`
- Modify: `packages/core/test/__snapshots__/roundtrip.test.ts.snap`
- Modify: `README.md`

- [ ] **Step 1: Bump version**

In `packages/core/package.json`:

```json
  "version": "6.0.0",
```

- [ ] **Step 2: Regenerate snapshots**

```bash
bun run test -- -u
```

- [ ] **Step 3: Inspect snapshot changes**

```bash
git diff packages/core/test/__snapshots__/roundtrip.test.ts.snap | head -80
```

Verify the new output contains imports/exports for at least some seeds. If the snapshot shows no structural change, investigate: likely the bucket transitions aren't firing correctly or the corpus weights aren't producing the candidates.

- [ ] **Step 4: Update README**

Update `README.md` to:
- Mention v6.0.0 and the structural shell feature in the feature list
- Add an example showing encoded output with imports/exports
- Note that v6 payloads are incompatible with pre-v6

Scan for:
- Feature bullet list — add "Structural shell: top-level output includes imports, exports, function declarations"
- Example JS snippets — regenerate to reflect new output style

- [ ] **Step 5: Run the full pre-commit checklist from CLAUDE.md**

```bash
bun run --filter '@zojize/dead-drop' build
bun run typecheck
bun run knip
bun run test
cd playground && bunx vite build && cd ..
```

Expected: every check passes.

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json packages/core/test/__snapshots__ README.md
git commit -m "chore: bump to 6.0.0, regen snapshots, update README"
```

---

## Task 19: Push branch and open PR

- [ ] **Step 1: Push**

```bash
git push -u origin feat/structural-shell
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat: structural shell + scope-dependent weights (v6.0.0)" --body "$(cat <<'EOF'
## Summary

- Add `ImportDeclaration` and `Export*Declaration` as top-level structural candidates
- Scope-dependent weight distributions: top-level / function-body / loop-body / block-body
- Cosmetic package names and import specifier names from corpus
- Breaking: new candidate pool + nested weight format (v6.0.0, old payloads do not decode)

Spec: `docs/superpowers/specs/2026-04-15-structural-shell-design.md`

## Test plan

- [x] All 39 existing round-trip tests pass
- [x] New tests: scope-bucket derivation, import/export round-trip, distribution fuzz
- [x] `bun run knip` passes
- [x] `bun run typecheck` passes
- [x] Playground builds

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Wait for CI**

```bash
gh run list --limit 2
```

Wait for both CI and Deploy workflows to go green before considering the task complete.

---

## Self-review notes

**Spec coverage check (done during planning):**
- § 1 (new candidates) → Tasks 11, 14, 15, 16
- § 2 (scope buckets) → Tasks 1, 2, 5, 6
- § 3 (weight format) → Tasks 3, 4
- § 4 (cosmetic data additions) → Tasks 9, 10
- § 5 (corpus scraper) → Tasks 7, 8
- § 6 (version) → Task 18
- Implementation notes § (sync rule) → reinforced in Tasks 5, 6

**Known follow-ups (explicitly deferred, not in this plan):**
- Namespace imports, mixed imports, re-exports, `export *`
- TypeScript import types, JSX, dynamic imports
- Finer-grained buckets (per `(inFunction, inLoop, inAsync, blockDepth)` tuple)
- Global built-in method cosmetics (Array.isArray, Object.keys, etc. at max-depth leaf)
