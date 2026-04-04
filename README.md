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
// -> 'open:fail:tick:switch(CUBEUV_TEXEL_WIDTH){case $e: ...'

const bytes = decode(js)
new TextDecoder().decode(bytes) // -> 'attack at dawn'

// With options: custom seed, pool factories, shared pools
const js2 = encode(new TextEncoder().encode('hello'), {
  seed: 42,
  identifiers: (rand) => `myVar_${rand % 100}`,  // or ['foo', 'bar']
  strings: ['custom_str', 'another'],
  numbers: [1337, 9001],
})

// Custom pools (must match between encode and decode)
import { DEFAULT_POOLS } from '@zojize/dead-drop'
const pools = { ...DEFAULT_POOLS, varNames: ['x', 'y', 'z', ...DEFAULT_POOLS.varNames.slice(3)] }
const js3 = encode(msg, { pools })
const out = decode(js3, { pools })  // same pools → correct decode
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

Each node type stores its variant in a parser-safe property:

| Node type | Variant stored in | Example |
| --- | --- | --- |
| `NumericLiteral` | `.value` from a pool of 76 numbers | `42`, `3.14`, `65535` |
| `Identifier` | `.name` from a pool of 64 names | `$emit`, `Fog`, `AnimationClip` |
| `StringLiteral` | `.value` from a pool of 32 words | `"DataView"`, `"IMG"`, `"vue"` |
| `BinaryExpression` | `.operator` (16 operators) | `+`, `>>>`, `in` |
| `VariableDeclaration` | `.kind` + declarator `.name` | `const ref = ...` |
| `LabeledStatement` | `.label.name` from a pool of 56 | `retry: ...` |
| `IfStatement` | `.alternate === null` (2 entries) | `if(x){...}` vs `if(x){...}else{...}` |
| `ForStatement` | null-combo of init/test/update (8) | `for(;;)`, `for(x;y;)` |
| `SwitchStatement` | `.cases.length` (0-15) | `switch(x){case a:case b:}` |
| `TryStatement` | catch param `.name` (6 names) | `try{...}catch(err){...}` |

Identifier and literal pools are scraped from real minified codebases (React,
Vue, Lodash, Three.js) so the output resembles authentic obfuscated code.

When the message bytes run out, a seeded PRNG generates varied leaf
expressions as padding. The length prefix tells the decoder exactly where the
real data ends.

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

### Expression table layout

```text
Byte        Type                 Count   Children
----------- -------------------- ------- ------------------
0x00-0x4B   NumericLiteral       76      (leaf)
0x4C-0x8B   Identifier           64      (leaf)
0x8C-0x9B   BinaryExpression     16      [expr, expr]
0x9C-0xA2   UnaryExpression      7       [expr]
0xA3        ConditionalExpression 1      [expr, expr, expr]
0xA4-0xB3   CallExpression       16      [expr, N*expr]
0xB4-0xBB   MemberExpression     8       [expr] (non-computed)
0xBC        MemberExpression     1       [expr, expr] (computed)
0xBD-0xDC   StringLiteral        32      (leaf)
0xDD-0xEC   AssignmentExpression 16      [expr]
0xED-0xF4   ArrayExpression      8       [N*expr]
0xF5-0xFC   ObjectExpression     8       [N*(expr,expr)]
0xFD        BooleanLiteral:true  1       (leaf)
0xFE        BooleanLiteral:false 1       (leaf)
0xFF        NullLiteral          1       (leaf)
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

- **Data lives in AST structure, not literal values.** The byte→node mapping
  uses node types, operators, child counts, and pool indices as variants.
  Literal values (identifier names, strings, numbers) are looked up from
  pools — changing the pool changes the output appearance but not the data.

- **Scope-aware declarations.** The encoder tracks `let`/`const` declarations
  per block scope and labels per scope chain. On conflict, appends a `$N`
  suffix that the decoder strips to recover the base pool name.

- **Shared pools.** Both `encode()` and `decode()` accept a `pools` option.
  Encoder and decoder must use matching pools for correct round-trips. Custom
  pools let you control the output vocabulary. Default pools are scraped from
  real minified codebases.

- **`errorRecovery` parsing.** Babel's `errorRecovery` mode tolerates
  edge cases in the generated code.

- **Customizable padding.** `encode()` accepts custom identifier/string/number
  pools for padding — either static arrays or factory functions
  `(rand: number) => T`.

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
