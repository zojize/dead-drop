import { describe, expect, it } from 'vitest'
import { parse } from '@babel/parser'
import { TextEncoder } from 'node:util'
import { encode } from '../src/encode'
import { decode } from '../src/decode'

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
  it('Hello, world!', () => {
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
  it('random payloads — 200 iterations, sizes 1-200', () => {
    for (let i = 0; i < 200; i++) {
      const len = Math.floor(Math.random() * 200) + 1
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
})

// ─── Data-in-AST invariant tests ────────────────────────────────────────────
// Confirm that ALL expression data is encoded in the AST structure, not in
// literal values. The decoder takes ONLY a string — no pools, no options.
// Encoding with different seeds (which changes cosmetic values like identifier
// names, numbers, strings) must always decode to the same bytes.

describe('data lives in AST structure, not literal values', () => {
  it('decode signature takes only a string', () => {
    const js = encode(new TextEncoder().encode('test'))
    // decode(jsSource: string): Uint8Array — no second param
    const result = decode(js)
    expect(result).toBeInstanceOf(Uint8Array)
  })

  it('same message, different seeds -> same decoded bytes', () => {
    const msg = new TextEncoder().encode('the quick brown fox')
    for (let seed = 0; seed < 20; seed++) {
      const js = encode(msg, { seed })
      const out = decode(js)
      expect(Array.from(out)).toEqual(Array.from(msg))
    }
  })

  it('fuzz: random data x different seeds (500 iterations)', () => {
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(Math.random() * 100) + 1
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
    // Encode the same message with many different seeds — all cosmetic
    // values (identifier names, numbers, strings) will be different,
    // but decode must always return the same bytes.
    const msg = new TextEncoder().encode('hello world')
    const expected = Array.from(msg)
    for (let seed = 0; seed < 50; seed++) {
      const js = encode(msg, { seed })
      const out = decode(js)
      expect(Array.from(out)).toEqual(expected)
    }
  })

  it('scope tracking: repeated let/const declarations', () => {
    // Byte 0x42 = VariableDeclaration. Repeating tests scope suffix handling.
    const data = new Uint8Array(20).fill(0x42)
    testRoundTrip(data)
  })

  it('scope tracking: repeated labels', () => {
    // Byte 0x60 = LabeledStatement. Repeating tests label suffix handling.
    const data = new Uint8Array(15).fill(0x60)
    testRoundTrip(data)
  })

  it('scope tracking: repeated let/const with different seeds', () => {
    for (let seed = 0; seed < 20; seed++) {
      const data = new Uint8Array(20).fill(0x42)
      const js = encode(data, { seed })
      const out = decode(js)
      expect(Array.from(out)).toEqual(Array.from(data))
    }
  })

  it('scope tracking: repeated labels with different seeds', () => {
    for (let seed = 0; seed < 20; seed++) {
      const data = new Uint8Array(15).fill(0x60)
      const js = encode(data, { seed })
      const out = decode(js)
      expect(Array.from(out)).toEqual(Array.from(data))
    }
  })
})

describe('encode output validity', () => {
  it('produces parseable JavaScript (with errorRecovery)', () => {
    const msgs = [
      new Uint8Array([]),
      new TextEncoder().encode('test'),
      Uint8Array.from({ length: 50 }, (_, i) => i),
    ]
    for (const msg of msgs) {
      const js = encode(msg)
      const ast = parse(js, { allowReturnOutsideFunction: true, errorRecovery: true })
      expect(ast.program.body.length).toBeGreaterThan(0)
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
