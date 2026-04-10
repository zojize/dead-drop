# dead-drop

[![npm](https://img.shields.io/npm/v/@zojize/dead-drop)](https://www.npmjs.com/package/@zojize/dead-drop)

Steganographic message encoding via JavaScript ASTs. Hides arbitrary byte
sequences inside syntactically valid JavaScript source code, and decodes
them back losslessly. All data is encoded in AST structure — literal values
are purely cosmetic.

**[Try the live playground](https://zojize.github.io/dead-drop/)**

## Install

```bash
npm install @zojize/dead-drop
```

## Quick start

```typescript
import { createCodec, decode, encode } from '@zojize/dead-drop'

// Zero-config
const js = encode(new TextEncoder().encode('attack at dawn'))
const bytes = decode(js)
new TextDecoder().decode(bytes) // -> 'attack at dawn'

// With cosmetic seed (changes appearance, not decoded data)
encode(new TextEncoder().encode('hello'), { seed: 42 })

// Factory: shared config for encoder + decoder
const codec = createCodec({ seed: 42, maxExprDepth: 30 })
const encoded = codec.encode(new TextEncoder().encode('secret'))
const decoded = codec.decode(encoded) // round-trips correctly
```

## CLI

```bash
# Encode a text message
bunx @zojize/dead-drop encode "secret message"

# Decode from stdin
bunx @zojize/dead-drop encode "secret" | bunx @zojize/dead-drop decode

# Decode from a file
bunx @zojize/dead-drop decode encoded.js

# Quick self-test
bunx @zojize/dead-drop test
```

## How it works

### Dynamic context-dependent tables

Instead of a fixed lookup table, the encoder builds a **256-entry table
dynamically** at each byte position based on context. Both encoder and
decoder maintain identical context state, so they always agree on which
table entry maps to which byte.

```text
             encode                          decode
bytes ──────────────> JS source ──────────────> bytes
     dynamic table       print     parse AST     dynamic table
     (from context)                               (from context)
```

### Context tracking

The table changes as the program is built:

| Context | Candidates added |
| --- | --- |
| Top-level | ExpressionStatement, VariableDeclaration, if/while/for, functions, blocks, try/catch, switch, labels, throw |
| Inside function | + ReturnStatement |
| Inside loop | + BreakStatement, ContinueStatement |
| Inside async | + AwaitExpression |
| Expression slot | Expression-only candidates (operators, calls, literals, etc.) |

After a `VariableDeclaration`, the declared name is added to scope and
becomes available for future Identifier references and assignment LHS.

### Table construction

At each position:

1. **Filter** the candidate pool (~300 entries) by current context
2. **Weight** entries using corpus-derived frequencies (22.8M nodes from 83 npm packages)
3. **Size** the table: `2^floor(log2(N))` where N = unique candidates
4. **Select** that many unique entries (bijective — each value maps to exactly one candidate)
5. **Shuffle** deterministically using a running structural hash

The encoder/decoder read/write variable-width values (not always full
bytes). When the context has 300+ candidates, the table is 256 entries
(8 bits). At max expression depth with ~12 leaf types, it shrinks to
8 entries (3 bits). Both sides compute the same bit width from context,
so the bitstream stays in sync.

### Structural variants

All data is recovered from **structural** AST properties only. Literal
values (identifier names, strings, numbers) are cosmetic:

| Category | Structural property | Entries |
| --- | --- | --- |
| RegExpLiteral | node type alone | 1 |
| Binary/Logical/Assign/Unary ops | `.operator` | 42 |
| Call/New/Array/Object/Sequence | child count | 82 |
| Arrow/Function expressions | `.params.length` | 32 |
| Template/TaggedTemplate | `.expressions.length` | 16 |
| Update expression | `.operator` × `.prefix` | 4 |
| Boolean/Class/Member variants | boolean flags | 8 |
| Leaf types | node type alone | 8 |
| Statements | node type + structural properties | ~40 |

### Name generation

Variable names, labels, and catch params are derived from
`hash(position)` — cosmetic but deterministic. The decoder computes the
same hash at the same position, so it never needs to know pool values.

### Decoding

`decode()` takes **only a string** — no options, pools, or shared secrets.

```text
for each top-level statement:
    rebuild the dynamic table from context + hash
    identify the node's candidate key from structural properties
    reverse-lookup the key in the table → recover the byte
    process children in the same order as the encoder

extract length from first 4 bytes
return bytes[4 .. 4+length]
```

## Design decisions

- **All data is in AST structure.** Literal values are cosmetic — the
  decoder ignores them. You can randomize every name, string, and number
  in the encoded JS and `decode()` still returns the same bytes.

- **Runtime-safe output.** Generated JS runs without errors. The encoder
  tracks the inferred type of each declared variable (`function`, `array`,
  `object`, etc.) and only offers operations when their operand types are
  available — e.g. `CallExpression` only when scope has a callable.

- **Dynamic tables from context.** The candidate pool includes both
  statement and expression types, filtered and shuffled per-position.
  Type-gated candidates produce realistic, runnable JS with control flow,
  declarations, and scope-aware variable references.

- **Deterministic hash-based shuffle.** The table ordering at each position
  depends on a running structural hash mixed with each consumed byte.
  Both encoder and decoder maintain identical hash state.

- **`createCodec` factory.** Shared configuration between encoder and
  decoder: `createCodec({ seed, maxExprDepth })` returns `{ encode, decode }`.
  `maxExprDepth` hard-caps expression nesting depth — at the limit, all
  expression children become cosmetic (non-data-carrying). This keeps the
  AST shallow enough for browser parsers (which use recursive descent and
  overflow on deep trees).

- **Custom code generator.** Handles 20+ AST node types with correct
  parenthesization, regex adjacency, and object/block disambiguation.

- **No encryption.** This is steganography only. For actual security,
  encrypt the message before encoding.

## Development

```bash
bun install
bun run lint          # lint (uses @antfu/eslint-config)
bun run lint:fix      # auto-fix lint issues
bun run test          # 38 tests including fuzz and randomization invariant
bun run typecheck     # typecheck all packages
bun run knip          # check for unused deps/exports
```

## License

[MIT](LICENSE)
