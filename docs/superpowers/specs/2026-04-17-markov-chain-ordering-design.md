# Markov Chain Statement Ordering Design

**Goal:** Replace independent per-position statement weights with bigram transition probabilities P(candidate | bucket, previous_candidate) so that generated JS exhibits realistic statement ordering (imports cluster at top, returns at bottom of functions, etc.).

**Breaking change:** v7.0.0 — transition weights change candidate selection, so v6-encoded output won't decode with v7.

## Design decisions

### Coarsened bigram keys

All expression candidates in statement context map to `ExpressionStatement:0` for transition lookup. Statement candidates keep their full key (`IfStatement:1`, `VariableDeclaration:2`, etc.). Rationale: the specific expression type within an ExpressionStatement doesn't affect ordering plausibility. This keeps the transition matrix to ~30x30 per bucket instead of ~200x200.

A helper function `bigramKey(candidateKey, isStatement)` performs this mapping.

### Weight replacement, not multiplication

Bigram transition weights replace the unigram weight directly. If `ReturnStatement` never follows `ImportDeclaration` in real code, the weight should be near-zero — not "unigram weight x small multiplier." Fallback to unigram weight only when the (prev, next) pair has no transition data at all.

### Per-block previous tracking

`prevStmtKey` tracks the previous sibling statement in the current block, not across nesting levels. Entering a nested block resets prev to `<START>`. Exiting restores the outer block's prev (implicitly, because the encoder iterates the block and the decoder sets prev per work item from the AST).

```
block [
  ImportDeclaration:named:1,    // prev = <START>
  ImportDeclaration:default,    // prev = ImportDeclaration:named:1
  VariableDeclaration:2,        // prev = ImportDeclaration:default
  IfStatement:1 {               // prev = VariableDeclaration:2
    // nested block: prev = <START>
    ReturnStatement:0,          // prev = <START>
  }
  ExpressionStatement:0         // prev = IfStatement:1
]
```

## Data format

### New file: `corpus-transitions.json`

```json
{
  "top-level": {
    "<START>": { "ImportDeclaration:named:1": 5.2, "ImportDeclaration:default": 3.1, "...": "..." },
    "ImportDeclaration:named:1": { "ImportDeclaration:default": 4.0, "ExpressionStatement:0": 1.2, "...": "..." },
    "VariableDeclaration:2": { "ExpressionStatement:0": 3.5, "VariableDeclaration:2": 2.1, "...": "..." }
  },
  "function-body": {},
  "loop-body": {},
  "block-body": {}
}
```

Weights normalized same as `corpus-weights.json`: max=10 within each (prev, bucket) group, min=0.01.

### `corpus-weights.json` unchanged

Still used for:
- Expression-level weights within expressions (no "previous statement" concept there)
- Fallback when a (prev, next) pair has no transition data

## Component changes

### Scraper (`analyze-corpus.ts`)

Track consecutive statement pairs per bucket. For each block of statements:
- Emit `(<START>, stmtKey(first))` as a transition
- Emit `(stmtKey(stmt[i-1]), stmtKey(stmt[i]))` for i > 0

Uses existing `stmtKey()` which already coarsens expressions to `ExpressionStatement:0`. Transparent BlockStatement flattening for function/loop bodies still applies. Output to `packages/core/src/corpus-transitions.json`.

### Context (`context.ts`)

- New field: `EncodingContext.prevStmtKey: string` initialized to `'<START>'`
- New function: `lookupTransitionWeight(prev, candidateKey, bucket) → number | null` — returns transition weight or null (triggers unigram fallback)
- New helper: `bigramKey(candidateKey, isStatement) → string` — maps expression candidates to `ExpressionStatement:0`
- `filterCandidates` updated: after computing base weight, check transition table. If transition weight found, use it; if null, keep unigram weight.

### Encoder (`encode.ts`)

- `buildBlock(parentType, slot)`: track `prevKey` across iterations. Starts at `'<START>'`, updates to `bigramKey(c.key, c.isStatement)` after each statement. Set `ctx.prevStmtKey = prevKey` before each `buildTopLevel()` call.
- Main encode loop: same pattern — track `prevKey` across top-level statements.

### Decoder (`decode.ts`)

- `stmt` work item gets new field: `prev: string`
- `block` handler: compute prev for each child at push time. Decoder has the AST, so it knows all stmtKeys upfront. First child gets `'<START>'`, subsequent children get the coarsened key of their predecessor.
- Top-level seeding: compute prev from directive/body sequence at seed time.
- Before processing each `stmt` item: set `ctx.prevStmtKey = item.prev`.

## Encoder/decoder sync

Both sides see the same `prevStmtKey` at each position because:
- Encoder: prev is the bigramKey of the candidate it just selected
- Decoder: prev is the bigramKey of the node it just parsed
- These are identical by the round-trip guarantee

No save/restore complexity for prevStmtKey. The decoder sets it fresh per stmt work item from data computed at block-push time. No mutable state drift risk.

## What does NOT change

- Expression-level candidate selection within expressions (still unigram)
- Block count encoding (still raw byte)
- Cosmetic generation (names, strings, numbers)
- The structural hash chain (`mixHash`)
- `filterCandidates` context gates (inFunction, inLoop, scopeBucket, type safety)
- Power-of-2 table construction (`buildTable`)
