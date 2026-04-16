# Structural Shell + Scope-Dependent Weights (v6.0.0)

**Date:** 2026-04-15
**Branch:** `feat/structural-shell`
**Goal:** Improve steganographic quality of encoded output by making it resemble real JavaScript modules — with imports, exports, and context-aware statement distributions — while preserving encoding efficiency (structural shell carries bits, not overhead).

## Context

Current output (v5.2.0) is a top-level soup of statements. Cosmetic identifiers, strings, numbers, and property names are now corpus-derived, but the *structural* shape is uniform: every program is a flat list of statements chosen from one global candidate pool with one flat weight distribution. This fails a casual sniff test — real JS files have imports, exports, function wrappers, and context-sensitive statement distributions (returns inside functions, continue/break inside loops).

Arithmetic coding work is parked on `feat/arithmetic-coding` branch (stashed). This spec does not interact with that branch.

## Non-goals

- No compatibility with pre-v6 encoded outputs.
- No security properties (explicitly out of scope per project goals).
- No TypeScript, JSX, or dynamic-import syntax.
- No namespace imports, mixed imports, re-exports, or `export *`. Deferred.

## Design

### 1. New candidates (top-level only)

Six new structural keys, gated by `ctx.scopeBucket === 'top-level'`:

| Key | Emitted shape | Variants | Structural bits |
|---|---|---|---|
| `ImportDeclaration:sideEffect` | `import '<pkg>'` | 1 | 0 |
| `ImportDeclaration:default` | `import <id> from '<pkg>'` | 1 | 0 |
| `ImportDeclaration:named` | `import { <id>, ... } from '<pkg>'` | 4 (1–4 specifiers) | 2 |
| `ExportNamedDeclaration:function` | `export function ...` wraps FunctionDeclaration | 1 | 0 (+ inner) |
| `ExportNamedDeclaration:variable` | `export var ...` wraps VariableDeclaration | 1 | 0 (+ inner) |
| `ExportDefaultDeclaration` | `export default <expr>` | 1 | 0 (+ inner) |

Package names, specifier identifiers, and the default-import local name are cosmetic (zero bits). The specifier *count* for `named` imports is the only structural bit-carrier in the new candidate set.

**Export wrappers:** The top-level candidate pool contains both plain `FunctionDeclaration` and `ExportNamedDeclaration:function` as distinct entries — they compete for the same slot, and the bits in the stream determine which is chosen. The encoder, when `ExportNamedDeclaration:function` is chosen, emits the `export` prefix and then directly builds a FunctionDeclaration body (the inner decl is *not* re-selected from the pool — it's built as-if it were chosen). The decoder, when it sees `node.type === ExportNamedDeclaration` at the top level, maps it to the export candidate key for reverse-lookup, strips the wrapper, and then processes the inner declaration's children (params, body) using function-body context — no additional top-level pool lookup for the inner decl. This keeps the decoder's top-level dispatch simple: look at node type, reverse-lookup as either wrapped or plain, process children.

**Specifier count encoding:** For `ImportDeclaration:named` the `variant` field (0..3) maps to specifier count 1..4. The encoder chooses variant based on the current bits in the stream (same as any other variant candidate). The decoder reads `specifiers.length - 1`.

**Identifier binding:** Import specifiers introduce bindings into the top-level scope (the `local` name of each specifier). `default` imports bind their single identifier. Side-effect imports bind nothing. These bindings must be added to `ctx.scope` so subsequent statements can reference them.

### 2. Scope buckets

New context field `ctx.scopeBucket: 'top-level' | 'function-body' | 'loop-body' | 'block-body'`.

Derived from the **immediately enclosing structural parent** — not a full-stack query:

| Immediate parent | Bucket |
|---|---|
| `Program.body` | `top-level` |
| `FunctionDeclaration.body` / `FunctionExpression.body` / `ArrowFunctionExpression.body` (block form) | `function-body` |
| `ForStatement.body` / `WhileStatement.body` / `DoWhileStatement.body` / `ForOfStatement.body` / `ForInStatement.body` | `loop-body` |
| `BlockStatement.body` (anywhere else) / `IfStatement.consequent` / `IfStatement.alternate` / `TryStatement.block` / `CatchClause.body` / `SwitchCase.consequent` | `block-body` |

`inFunction`, `inLoop`, `inAsync` remain as separate legality flags (they gate whether `await`/`return`/`break`/`continue` are syntactically valid). `scopeBucket` only affects weight lookup, never candidate filtering for legality.

Encoder and decoder must both compute `scopeBucket` identically at each statement boundary. Encoder sets it when entering a block; decoder's work stack pushes `bucket-enter` / `bucket-exit` items alongside the existing scope-save/restore items.

### 3. Weight format

`corpus-weights.json` changes from flat to bucketed:

```json
{
  "top-level": { "ImportDeclaration:named": 45.2, "FunctionDeclaration:0": 12.1, ... },
  "function-body": { "VariableDeclaration:0": 18.5, "ReturnStatement:0": 8.2, ... },
  "loop-body": { ... },
  "block-body": { ... },
  "global": { ... }
}
```

Lookup precedence in the encoder/decoder weight function:
```
weights[ctx.scopeBucket]?.[key] ?? weights.global[key] ?? 1
```

The `global` key is the current v5 flat distribution, preserved as a fallback for sparse bucket cells and any future candidate that doesn't yet have bucket-specific data.

### 4. Cosmetic data additions

`cosmetic-data.json` gains two fields:

- `packageNames: string[]` — top 200 package strings scraped from `import ... from <literal>` sources across the corpus.
- `importedNames: string[]` — top 200 identifiers from import specifiers (useState, merge, debounce, etc.). Distinct distribution from general identifiers (e, i, t).

These are drawn from the same 55-package corpus as the rest of `cosmetic-data.json` (scraped via `scripts/scrape-cosmetics.ts`).

### 5. Corpus scraper changes

`scripts/analyze-corpus.ts`:
- Maintains a context stack during AST walk.
- At each node, increments `counts[currentBucket][nodeKey]`.
- Emits nested JSON matching the new weight format.
- Also maintains the `global` totals (sum across all buckets) as the fallback.

`scripts/scrape-cosmetics.ts`:
- Collects `ImportDeclaration.source.value` into `packageNames`.
- Collects specifier local names into `importedNames`.

### 6. Version

v6.0.0. Breaking: new top-level candidates, new weight file format. Pre-v6 encoded payloads will not decode with v6 and vice versa.

## Implementation notes

- **Ambiguous parent**: an arrow function with an expression body (`x => y`) has no BlockStatement to inspect. These don't introduce a new statement-level scope bucket; the arrow expression itself is an expression, not a statement, so `scopeBucket` never changes for it.
- **SwitchCase**: `case X: stmt1; stmt2` — the consequent is an array of statements. Classified as `block-body`.
- **Program body of length 0**: still `top-level` for the initial context.
- **Decoder sync rule (reinforced)**: every `ctx` mutation the encoder performs must be mirrored by the decoder's work stack in identical order. Adding `scopeBucket` adds `bucket-enter`/`bucket-exit` work items. These must push before child work items and pop after.

## Test plan

- **Round-trip**: all 39 existing tests continue to pass.
- **New round-trip cases**: messages whose first statement must be an import (probe the new candidates explicitly via structural hash manipulation if needed).
- **Distribution inspection**: encode 100 random messages, verify the top-level statement-type histogram roughly matches corpus weights (not exact — the message bits drive selection — but proportional over many runs).
- **Scope bucket correctness**: unit test that `scopeBucket` is correctly assigned for each of the Program/Function/Loop/Block/If/Try/Switch cases.
- **Snapshot**: existing snapshot file will change entirely. Regenerate.
- **Fuzz**: extend existing fuzz test with more iterations on the new top-level candidate mix.

## Open questions resolved during brainstorming

- **Granularity**: 4 buckets (top-level / function-body / loop-body / block-body). Full context-tuple granularity deferred.
- **Export wrappers**: cleanest approach is decoder-side branching, not a new "mandatory slot" encoder mechanism.
- **Specifier count**: structural (bit-carrying). 1–4 specifiers = 2 bits.

## File map changes

```
packages/core/src/
  context.ts          — add scopeBucket field, refactor weight lookup
  encode.ts           — add import/export candidate builders, scope-bucket transitions
  decode.ts           — add bucket-enter/exit work items, export wrapper branching
  codegen.ts          — emit ImportDeclaration, ExportNamedDeclaration, ExportDefaultDeclaration
  corpus-weights.json — new nested format
  cosmetic-data.json  — + packageNames, importedNames

scripts/
  analyze-corpus.ts   — bucket-aware counting
  scrape-cosmetics.ts — collect package names + specifier names

packages/core/test/
  roundtrip.test.ts   — new tests for imports/exports, scope bucket assignment
  tables.test.ts      — update for new candidate set
```
