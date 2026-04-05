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
import { encode, decode } from '@zojize/dead-drop'

const js = encode(new TextEncoder().encode('attack at dawn'))
// -> '67;833;787;"ru";/x/dmu;...'

const bytes = decode(js)  // just a string — no options needed
new TextDecoder().decode(bytes) // -> 'attack at dawn'

// Optional seed changes cosmetic values (names, numbers, strings)
// but decoded bytes are always the same
const js2 = encode(new TextEncoder().encode('hello'), { seed: 42 })
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

### The core idea

Message bytes drive a deterministic construction of a JavaScript AST. Each
byte maps to a structurally unique expression node — distinguished by node
type, operator, child count, regex flags, or boolean value. The decoder
parses the JS back to an AST and recovers bytes from the structure alone.
Literal values (identifier names, strings, numbers) are cosmetic noise.

```text
             encode                          decode
bytes ──────────────> JS source ──────────────> bytes
        build AST       print      parse AST     walk
```

### Expression-only encoding

The program body is a flat sequence of `ExpressionStatement`s. Each byte
is consumed by `buildExpression()` which looks up the expression table:

```text
EXPR_TABLE[byte] -> { nodeType, variant, children }
```

A 4-byte big-endian length prefix precedes the message. The encoder
processes bytes iteratively (explicit work stack, no recursion):

```text
prefixed = [length_hi, length_mid_hi, length_mid_lo, length_lo, ...message]

while (bytes remain):
    byte = next byte
    config = EXPR_TABLE[byte]
    build the expression, processing children recursively
    wrap in ExpressionStatement
```

### Structural variants

Every expression byte is recovered from **structural** AST properties only.
The decoder ignores all literal values:

| Node type | Variant recovered from | Count |
| --- | --- | --- |
| `RegExpLiteral` | flag combo (d,g,i,m,s,u = 2^6) | 64 |
| `CallExpression` | `.arguments.length` | 19 |
| `BinaryExpression` | `.operator` | 16 |
| `NewExpression` | `.arguments.length` | 16 |
| `AssignmentExpression` | `.operator` | 16 |
| `ArrayExpression` | `.elements.length` | 16 |
| `ObjectExpression` | `.properties.length` | 16 |
| `ArrowFunctionExpression` | `.params.length` | 16 |
| `FunctionExpression` | `.params.length` | 16 |
| `SequenceExpression` | `.expressions.length` | 15 |
| `TemplateLiteral` | `.expressions.length` | 8 |
| `TaggedTemplateExpression` | `.quasi.expressions.length` | 8 |
| `UnaryExpression` | `.operator` | 7 |
| `UpdateExpression` | `.operator` × `.prefix` | 4 |
| `LogicalExpression` | `.operator` | 3 |
| `BooleanLiteral` | `.value` (true/false) | 2 |
| `ClassExpression` | `.superClass` null/present | 2 |
| `MemberExpression` | `.computed` | 2 |
| `OptionalMemberExpression` | `.computed` | 2 |
| Leaf types (8) | node type alone | 8 |
| `SpreadElement` | node type | 1 |
| `ConditionalExpression` | node type | 1 |

### Decoding

The decoder parses the JS source with Babel, then walks each
ExpressionStatement's expression tree iteratively:

```text
for each ExpressionStatement:
    identify expression node type → look up structural variant → push byte
    process children in the same order the encoder built them

extract length from first 4 bytes
return bytes[4 .. 4+length]
```

`decode()` takes **only a string** — no pools, options, or shared secrets.

### Expression table layout

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

- **All data is in AST structure.** The 256 expression table entries are
  distinguished purely by node type, operator, child count, boolean flags,
  and regex flag combos. Literal values are cosmetic — the decoder ignores
  them. `decode()` takes only a string.

- **Expression-only encoding.** No statement table. The program body is a
  flat sequence of ExpressionStatements. This eliminates name-based variants
  (labels, variable names, catch params) that would leak data into literals.

- **Fully iterative.** Encoder, decoder, and code generator all use explicit
  work stacks instead of recursion, so large messages (10KB+) don't overflow
  the call stack.

- **Custom code generator.** Replaced `@babel/generator` with an iterative
  codegen that handles our AST subset with correct parenthesization for
  operator precedence, numeric member access, and object/block ambiguity.

- **No encryption.** This is steganography only. For actual security,
  encrypt the message (e.g. AES-256-CTR) before encoding.

## Development

```bash
bun install
bun run test          # 31 tests including structural-invariant fuzz
bun run typecheck     # typecheck all packages
bun run knip          # check for unused deps/exports
```

## License

[MIT](LICENSE)
