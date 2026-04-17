import { TextEncoder } from 'node:util'
import { parse } from '@babel/parser'
import { describe, expect, it } from 'vitest'
import { generateCompact } from '../src/codegen'
import { decode } from '../src/decode'
import { encode } from '../src/encode'
import { createCodec } from '../src/lib'

function testRoundTrip(input: Uint8Array) {
  const js = encode(input)
  const output = decode(js)
  expect(Array.from(output)).toEqual(Array.from(input))
}

describe('round-trip', () => {
  it('empty message', () => {
    testRoundTrip(new Uint8Array([]))
  })

  it('single byte — all 256 values', () => {
    for (let b = 0; b < 256; b++) {
      testRoundTrip(new Uint8Array([b]))
    }
  })

  it('all bytes sequential', () => {
    testRoundTrip(Uint8Array.from({ length: 256 }, (_, i) => i))
  })

  it('repeated 0xFF bytes', () => {
    testRoundTrip(new Uint8Array(50).fill(0xFF))
  })

  it('repeated 0x00 bytes', () => {
    testRoundTrip(new Uint8Array(50).fill(0x00))
  })
})

describe('snapshots', () => {
  it('hello, world!', () => {
    const js = encode(new TextEncoder().encode('Hello, world!'))
    expect(js).toMatchSnapshot()
    testRoundTrip(new TextEncoder().encode('Hello, world!'))
  })

  it('short: "hi"', () => {
    const js = encode(new TextEncoder().encode('hi'))
    expect(js).toMatchSnapshot()
    testRoundTrip(new TextEncoder().encode('hi'))
  })

  it('single byte 0x42', () => {
    const js = encode(new Uint8Array([0x42]))
    expect(js).toMatchSnapshot()
    testRoundTrip(new Uint8Array([0x42]))
  })

  it('binary: deadbeef', () => {
    const js = encode(new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]))
    expect(js).toMatchSnapshot()
    testRoundTrip(new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]))
  })

  it('sentence', () => {
    const js = encode(new TextEncoder().encode('The quick brown fox'))
    expect(js).toMatchSnapshot()
    testRoundTrip(new TextEncoder().encode('The quick brown fox'))
  })

  it('url', () => {
    const js = encode(new TextEncoder().encode('https://example.com/api'))
    expect(js).toMatchSnapshot()
    testRoundTrip(new TextEncoder().encode('https://example.com/api'))
  })

  it('json-like', () => {
    const js = encode(new TextEncoder().encode('{"key":"value","n":42}'))
    expect(js).toMatchSnapshot()
    testRoundTrip(new TextEncoder().encode('{"key":"value","n":42}'))
  })

  it('all printable ASCII', () => {
    const chars = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')
    const js = encode(new TextEncoder().encode(chars))
    expect(js).toMatchSnapshot()
    testRoundTrip(new TextEncoder().encode(chars))
  })
})

describe('fuzz', () => {
  it('random payloads — 100 iterations, sizes 1-30', () => {
    for (let i = 0; i < 100; i++) {
      const len = Math.floor(Math.random() * 30) + 1
      const data = new Uint8Array(len)
      crypto.getRandomValues(data)
      testRoundTrip(data)
    }
  })

  it('adversarial: all same byte for each value', () => {
    for (let b = 0; b < 256; b++) {
      testRoundTrip(new Uint8Array(10).fill(b))
    }
  })

  it('deterministic: same input always produces same output', () => {
    const msg = new TextEncoder().encode('determinism check')
    const a = encode(msg)
    const b = encode(msg)
    expect(a).toBe(b)
  })

  it('different seeds round-trip the same input', () => {
    const msg = new TextEncoder().encode('the quick brown fox jumps over the lazy dog')
    for (let seed = 0; seed < 50; seed++) {
      const js = encode(msg, { seed })
      const out = decode(js)
      expect(Array.from(out)).toEqual(Array.from(msg))
    }
  })

  it('different seeds produce different output for the same input', () => {
    const msg = new TextEncoder().encode('hello world')
    const outputs = new Set<string>()
    for (let seed = 0; seed < 20; seed++) {
      outputs.add(encode(msg, { seed }))
    }
    expect(outputs.size).toBe(20)
  })

  it('seed + fuzz', () => {
    for (let seed = 0; seed < 20; seed++) {
      const len = 20 + seed * 5
      const data = new Uint8Array(len)
      crypto.getRandomValues(data)
      const js = encode(data, { seed })
      const out = decode(js)
      expect(Array.from(out)).toEqual(Array.from(data))
    }
  })

  it('key affects candidate selection — decode needs matching key', () => {
    const msg = new TextEncoder().encode('hello world')
    for (let key = 0; key < 20; key++) {
      const js = encode(msg, { key })
      const out = decode(js, { key })
      expect(Array.from(out)).toEqual(Array.from(msg))
    }
  })

  it('different keys produce different output', () => {
    const msg = new TextEncoder().encode('hello world')
    const outputs = new Set<string>()
    for (let key = 0; key < 20; key++) {
      outputs.add(encode(msg, { key }))
    }
    expect(outputs.size).toBe(20)
  })
})

// ─── Data-in-AST invariant tests ────────────────────────────────────────────
// Confirm that ALL expression data is encoded in the AST structure, not in
// literal values. Seed is cosmetic only — decode never needs the seed.
// Encoding with different seeds must always decode to the same bytes.

describe('data lives in AST structure, not literal values', () => {
  it('same message, different seeds -> same decoded bytes', () => {
    const msg = new TextEncoder().encode('the quick brown fox')
    for (let seed = 0; seed < 20; seed++) {
      const js = encode(msg, { seed })
      const out = decode(js)
      expect(Array.from(out)).toEqual(Array.from(msg))
    }
  })

  it('fuzz: random data x different seeds (100 iterations)', () => {
    for (let i = 0; i < 100; i++) {
      const len = Math.floor(Math.random() * 30) + 1
      const data = new Uint8Array(len)
      crypto.getRandomValues(data)
      const seed = i * 7 + 13
      const js = encode(data, { seed })
      const out = decode(js)
      expect(Array.from(out)).toEqual(Array.from(data))
    }
  })

  it('adversarial: all same byte x different seeds', () => {
    for (let b = 0; b < 256; b++) {
      const data = new Uint8Array(10).fill(b)
      const js = encode(data, { seed: b * 31 })
      const out = decode(js)
      expect(Array.from(out)).toEqual(Array.from(data))
    }
  })

  it('cosmetic values do not affect decoding', () => {
    const msg = new TextEncoder().encode('hello world')
    const expected = Array.from(msg)
    for (let seed = 0; seed < 50; seed++) {
      const js = encode(msg, { seed })
      const out = decode(js)
      expect(Array.from(out)).toEqual(expected)
    }
  })

  it('randomize all names, literals, and labels — decode still works', () => {
    // This is the definitive test: encode a message, parse the output,
    // walk the AST and randomize EVERY cosmetic value (identifier names,
    // string literal values, numeric literal values, regex patterns,
    // bigint values, template strings, labels, var names, catch params),
    // regenerate JS from the mutated AST, and verify decode still works.

    function randomizeName(): string {
      // _ prefix guarantees it's never a JS keyword
      const chars = 'abcdefghijklmnopqrstuvwxyz'
      const len = 1 + Math.floor(Math.random() * 5)
      let s = '_'
      for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]
      return s
    }

    let nameCounter = 0
    const paramNodes = new Set()
    function walk(node: any): void {
      if (!node || typeof node !== 'object')
        return

      // For function/arrow params: assign unique names to avoid clash
      if ((node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') && node.params) {
        for (const p of node.params) {
          if (p.type === 'Identifier') {
            p.name = `_r${nameCounter++}`
            paramNodes.add(p)
          }
        }
      }

      // Randomize cosmetic values (skip param identifiers — already handled)
      if (node.type === 'Identifier' && typeof node.name === 'string' && !paramNodes.has(node)) {
        node.name = randomizeName()
      }
      if (node.type === 'NumericLiteral' && typeof node.value === 'number') {
        node.value = Math.floor(Math.random() * 99999)
        delete node.extra
      }
      if (node.type === 'StringLiteral' && typeof node.value === 'string') {
        node.value = randomizeName()
        delete node.extra
      }
      if (node.type === 'BigIntLiteral' && typeof node.value === 'string') {
        node.value = String(Math.floor(Math.random() * 99999))
        delete node.extra
      }
      if (node.type === 'RegExpLiteral') {
        node.pattern = randomizeName()
        delete node.extra
      }
      if (node.type === 'TemplateElement' && node.value) {
        const raw = randomizeName()
        node.value = { raw, cooked: raw }
      }
      // Recurse
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc')
          continue
        const val = node[key]
        if (Array.isArray(val))
          val.forEach(walk)
        else if (val && typeof val === 'object' && val.type)
          walk(val)
      }
    }

    for (let i = 0; i < 50; i++) {
      const len = Math.floor(Math.random() * 15) + 1
      const data = new Uint8Array(len)
      crypto.getRandomValues(data)

      const js = encode(data)

      // Parse → randomize → regenerate
      const ast = parse(js, {
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        plugins: [['optionalChainingAssign', { version: '2023-07' }]],
      })
      walk(ast.program)
      const randomized = generateCompact(ast.program)

      // Decode the randomized JS — must still produce the same bytes
      const out = decode(randomized)
      expect(Array.from(out)).toEqual(Array.from(data))
    }
  })
})

describe('encode output validity', () => {
  it('produces strictly parseable JavaScript (no errorRecovery needed)', () => {
    const msgs = [
      new Uint8Array([]),
      new TextEncoder().encode('test'),
      new TextEncoder().encode('hello world'),
    ]
    for (const msg of msgs) {
      const js = encode(msg)
      expect(() => parse(js)).not.toThrow()
    }
  })

  it('decode length matches input length', () => {
    for (let len = 0; len <= 30; len++) {
      const data = new Uint8Array(len).fill(0x42)
      const js = encode(data)
      const decoded = decode(js)
      expect(decoded.length).toBe(len)
    }
  })
})

describe('import candidates', () => {
  it('round-trips messages with import-candidate eligibility', () => {
    for (let seed = 0; seed < 50; seed++) {
      const msg = new Uint8Array([seed, (seed * 7) & 0xFF, (seed * 13) & 0xFF])
      const codec = createCodec({ seed })
      const js = codec.encode(msg)
      const back = codec.decode(js)
      expect(back).toEqual(msg)
    }
  })
})

describe('maxExprDepth', () => {
  it('round-trips with depth 10', () => {
    for (let i = 0; i < 50; i++) {
      const len = Math.floor(Math.random() * 20) + 1
      const data = new Uint8Array(len)
      crypto.getRandomValues(data)
      const js = encode(data, { maxExprDepth: 10 })
      const out = decode(js, { maxExprDepth: 10 })
      expect(Array.from(out)).toEqual(Array.from(data))
    }
  })

  it('round-trips with depth 20', () => {
    for (let i = 0; i < 50; i++) {
      const len = Math.floor(Math.random() * 30) + 1
      const data = new Uint8Array(len)
      crypto.getRandomValues(data)
      const js = encode(data, { maxExprDepth: 20 })
      const out = decode(js, { maxExprDepth: 20 })
      expect(Array.from(out)).toEqual(Array.from(data))
    }
  })

  it('round-trips with depth 50', () => {
    for (let i = 0; i < 50; i++) {
      const len = Math.floor(Math.random() * 50) + 1
      const data = new Uint8Array(len)
      crypto.getRandomValues(data)
      const js = encode(data, { maxExprDepth: 50 })
      const out = decode(js, { maxExprDepth: 50 })
      expect(Array.from(out)).toEqual(Array.from(data))
    }
  })

  it('single byte — all 256 values with depth 10', () => {
    for (let b = 0; b < 256; b++) {
      const data = new Uint8Array([b])
      const js = encode(data, { maxExprDepth: 10 })
      const out = decode(js, { maxExprDepth: 10 })
      expect(Array.from(out)).toEqual(Array.from(data))
    }
  })

  it('different depths produce different output for same input', () => {
    const msg = new TextEncoder().encode('hello')
    const outputs = new Set<string>()
    for (const d of [5, 10, 15, 20, 50]) {
      outputs.add(encode(msg, { maxExprDepth: d }))
    }
    expect(outputs.size).toBeGreaterThanOrEqual(2)
  })

  it('round-trips messages that may encode as ExportDefaultDeclaration', () => {
    for (let seed = 100; seed < 150; seed++) {
      const msg = new Uint8Array([seed, (seed * 11) & 0xFF, 0xAB, 0xCD])
      const codec = createCodec({ seed })
      const js = codec.encode(msg)
      const back = codec.decode(js)
      expect(back).toEqual(msg)
    }
  })

  it('top-level output contains import/export statements across many keys', { timeout: 30_000 }, () => {
    let hasImport = 0
    let hasExport = 0
    const N = 200
    for (let k = 0; k < N; k++) {
      const msg = new Uint8Array(Array.from({ length: 16 }, (_, i) => (k * 13 + i * 7) & 0xFF))
      const codec = createCodec({ key: k })
      const js = codec.encode(msg)
      if (/\bimport\s/.test(js))
        hasImport++
      if (/\bexport\s/.test(js))
        hasExport++
      const back = codec.decode(js)
      expect(Array.from(back)).toEqual(Array.from(msg))
    }
    // Lower bounds — corpus weights drive appearance. If these fail, corpus
    // weights may have drifted or the bucket transitions aren't firing.
    expect(hasImport + hasExport).toBeGreaterThan(N * 0.02)
  })

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
          if (i < totalLines / 2)
            importsInFirstHalf++
        }
      }
      const back = codec.decode(js)
      expect(Array.from(back)).toEqual(Array.from(msg))
    }
    if (importsTotal > 10)
      expect(importsInFirstHalf / importsTotal).toBeGreaterThan(0.5)
  })

  it('lorem roundtrips with depth 64', () => {
    const msg = `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Fusce imperdiet magna consequat lectus lobortis, efficitur efficitur metus blandit. Vestibulum efficitur massa ligula. Curabitur mi nulla, tempus eget posuere eu, venenatis vitae lectus. Nulla facilisi. Donec non rhoncus dui. Integer nisi dolor, mattis sed ullamcorper non, tempus sed eros. Ut et metus sit amet neque tempus aliquet tempor non ligula. Maecenas sit amet dapibus erat. Fusce et risus quis nunc ornare dignissim. Maecenas ac libero eu ex porttitor mollis non in ligula.`
    const data = new TextEncoder().encode(msg)
    const js = encode(data, { maxExprDepth: 64 })
    const out = decode(js, { maxExprDepth: 64 })
    expect(Array.from(out)).toEqual(Array.from(data))
  })
})
