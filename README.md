# dead-drop

[![npm](https://img.shields.io/npm/v/@zojize/dead-drop)](https://www.npmjs.com/package/@zojize/dead-drop)

Steganographic message encoding via JavaScript ASTs. Hides arbitrary byte
sequences inside syntactically valid (but semantically bogus) JavaScript
source code, and decodes them back losslessly.

**[Try the live playground](https://zojize.github.io/dead-drop/)**

## Install

```bash
npm install @zojize/dead-drop
```

## Quick start

```typescript
import { encode, decode } from '@zojize/dead-drop'

const js = encode(new TextEncoder().encode('attack at dawn'))
// -> '501;56n;const _c=(_lval>>=(+((+((typeof ...'

const bytes = decode(js)  // no options needed — data is in the AST structure
new TextDecoder().decode(bytes) // -> 'attack at dawn'

// Optional: custom seed changes cosmetic values (names, numbers, strings)
// but the decoded bytes are always the same
const js2 = encode(new TextEncoder().encode('hello'), { seed: 42 })
```

## CLI

```bash
# Encode a text message
bunx dead-drop encode "secret message"

# Encode from a file
bunx dead-drop encode --file secret.bin

# Decode from stdin
bunx dead-drop encode "secret" | bunx dead-drop decode

# Decode from a file
bunx dead-drop decode encoded.js

# Quick self-test
bunx dead-drop test
```

## How it works

### The core idea

Message bytes drive a deterministic construction of a JavaScript AST. Each
byte selects a node type and variant from a lookup table. The node's shape
(how many children, their types) is fixed, so the encoder knows exactly how
many more bytes to consume. The decoder parses the JS back to an AST and
walks it in the same order to recover the original bytes.

```text
             encode                          decode
bytes ──────────────> JS source ──────────────> bytes
        build AST       print      parse AST     walk
```

### Two tables, two contexts

The encoder always knows whether it's filling a **statement** slot or an
**expression** slot. Two separate 256-entry lookup tables map each possible
byte value to an AST node configuration:

```text
STMT_TABLE[byte] -> { nodeType, variant, children }
EXPR_TABLE[byte] -> { nodeType, variant, children }
```

The **variant** is the piece of the node that distinguishes it from other
entries of the same type. It must be a property that Babel's parser preserves
after a generate-then-parse round-trip.

### Encoding: bytes to AST

The encoder prepends a 4-byte big-endian length prefix, then builds the AST
iteratively by consuming bytes:

```text
prefixed = [length_hi, length_mid_hi, length_mid_lo, length_lo, ...message]

while (bytes remain):
    byte = next byte
    config = STMT_TABLE[byte]
    build the node described by config, processing children:
        'expr' child  -> consume a byte from EXPR_TABLE
        'block' child -> consume a count byte, then that many statements
```

Each expression byte is recovered from **structural** AST properties — literal
values (names, strings, numbers) are cosmetic:

| Node type | Variant recovered from | Count |
| --- | --- | --- |
| `RegExpLiteral` | flag combo (d,g,i,m,s,u = 2^6) | 64 |
| `BinaryExpression` | `.operator` | 16 |
| `CallExpression` | `.arguments.length` | 19 |
| `NewExpression` | `.arguments.length` | 16 |
| `AssignmentExpression` | `.operator` | 16 |
| `ArrayExpression` | `.elements.length` | 16 |
| `ObjectExpression` | `.properties.length` | 16 |
| `ArrowFunctionExpression` | `.params.length` | 16 |
| `FunctionExpression` | `.params.length` | 16 |
| `SequenceExpression` | `.expressions.length` | 15 |
| `UnaryExpression` | `.operator` | 7 |
| `UpdateExpression` | `.operator` × `.prefix` | 4 |
| `LogicalExpression` | `.operator` | 3 |
| `BooleanLiteral` | `.value` (true/false) | 2 |
| Leaf types | just node type | 6 |

The decoder takes only a string — `decode(js)` — no pools or options needed.

When the message bytes run out, a seeded PRNG generates cosmetic leaf
expressions as padding. The length prefix tells the decoder where data ends.

### Decoding: AST to bytes

The decoder parses the JS source with Babel (using `errorRecovery: true` to
tolerate `let`/`const` redeclarations and duplicate labels), then walks the
AST iteratively in the same pre-order traversal:

```text
for each top-level statement:
    identify node type -> look up variant -> push byte
    process children in the same order the encoder built them

extract length from first 4 bytes
return bytes[4 .. 4+length]
```

The critical invariant: **every byte is fully recoverable from the AST node
it produced.** The mapping is bijective — each byte value maps to exactly
one (node_type, variant) pair and vice versa.

### Statement table layout

The 256 statement byte values are distributed to maximize variety in output:

```text
Byte        Type                 Count   Children
----------- -------------------- ------- ---------------------------
0x00        ExpressionStatement  1       [expr]
0x01        IfStatement:else     1       [expr, block, block]
0x02        IfStatement:no-else  1       [expr, block]
0x03        WhileStatement       1       [expr, stmt]
0x04-0x0B   ForStatement         8       [optional exprs, stmt]
0x0C        DoWhileStatement     1       [expr, stmt]
0x0D        ReturnStatement      1       [expr]
0x0E        ThrowStatement       1       [expr]
0x0F        BlockStatement       1       [block]
0x10        EmptyStatement       1       (leaf)
0x11        DebuggerStatement    1       (leaf)
0x12-0x17   TryStatement         6       [block, block]
0x18-0x27   SwitchStatement      16      [expr, N*(expr,block)]
0x28-0x3F   LabeledStatement     24      [stmt]
0x40-0x5F   VariableDeclaration  32      [expr]
0x60-0x7F   LabeledStatement     32      [stmt]
0x80-0xFF   VariableDeclaration  128     [expr]
```

### Expression table layout (fully structural)

All 256 entries are recoverable from AST structure alone — no literal values:

```text
Byte        Type                        Count  Variant
----------- --------------------------- ------ -----------------------
0x00-0x07   Leaf types                  8      node type only
0x08-0x47   RegExpLiteral               64     flag combo (2^6)
0x48-0x57   BinaryExpression            16     operator
0x58-0x5A   LogicalExpression           3      operator
0x5B-0x6A   AssignmentExpression        16     operator
0x6B-0x71   UnaryExpression             7      operator
0x72-0x75   UpdateExpression            4      operator × prefix
0x76        ConditionalExpression       1      type
0x77-0x89   CallExpression              19     arg count
0x8A-0x99   NewExpression               16     arg count
0x9A-0x9D   Member/OptionalMember       4      computed flag
0x9E-0xAD   ArrayExpression             16     element count
0xAE-0xBD   ObjectExpression            16     prop count
0xBE-0xCC   SequenceExpression          15     element count
0xCD-0xDC   Template/TaggedTemplate     16     expression count
0xDD-0xEC   ArrowFunctionExpression     16     param count
0xED-0xFC   FunctionExpression          16     param count
0xFD        SpreadElement               1      type
0xFE-0xFF   ClassExpression             2      has/no superclass
```

## Design decisions

- **Code doesn't need to run.** It just needs to parse. No type correctness,
  no runtime semantics.

- **Fully iterative.** Encoder, decoder, and code generator all use explicit
  work stacks instead of recursion, so large messages (10KB+) don't overflow
  the call stack.

- **Custom code generator.** Replaced `@babel/generator` with an iterative
  codegen that handles our AST subset with correct parenthesization for
  operator precedence, numeric member access, and object/block ambiguity.

- **All expression data is in AST structure.** The 256 expression table
  entries are distinguished purely by node type, operator, child count,
  boolean flags, and regex flag combos. Literal values (identifier names,
  string values, numbers) are cosmetic — the decoder ignores them entirely.
  `decode()` takes only a string, no options.

- **Scope-aware declarations.** The encoder tracks `let`/`const` declarations
  globally and labels per scope chain. On conflict, appends a `$N` suffix
  that the decoder strips to recover the base name.

- **`errorRecovery` parsing.** Babel's `errorRecovery` mode tolerates
  edge cases in the generated code.

- **All statement bodies use blocks.** IfStatement, WhileStatement,
  ForStatement, DoWhileStatement, and LabeledStatement wrap bodies in `{...}`
  to prevent lexical-declaration-in-single-statement-context errors.

- **Minifier-style default pools.** Short generated names (`a`, `b`, `aa`,
  `_a`, `_b`, `La`, `Lb`, etc.) that look like real minified code. Padding
  expressions reference previously-declared variables for realism.

- **No encryption.** This is steganography only. For actual security,
  encrypt the message (e.g. AES-256-CTR) before encoding.

## Development

```bash
bun install
bun run test          # run all tests (26 tests, fuzz + adversarial)
bun run typecheck     # typecheck all packages
bun run knip          # check for unused deps/exports
```

## License

[MIT](LICENSE)
