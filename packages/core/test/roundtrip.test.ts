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

  it('custom pools round-trip correctly', () => {
    const msg = new TextEncoder().encode('custom pool test')
    const js = encode(msg, {
      identifiers: ['myVar', 'customFunc', 'specialName'],
      strings: ['custom_str', 'pool_val'],
      numbers: [9999, 7777, 5555],
    })
    const out = decode(js)
    expect(Array.from(out)).toEqual(Array.from(msg))
  })

  it('factory functions round-trip correctly', () => {
    const msg = new TextEncoder().encode('factory test')
    const js = encode(msg, {
      identifiers: (rand) => `id_${rand % 100}`,
      strings: (rand) => `str_${rand % 50}`,
      numbers: (rand) => rand % 10000,
    })
    const out = decode(js)
    expect(Array.from(out)).toEqual(Array.from(msg))
  })

  it('factory output appears in encoded JS', () => {
    const msg = new TextEncoder().encode('hello world, this needs enough padding')
    const js = encode(msg, {
      seed: 42,
      strings: () => 'CUSTOM_VALUE',
    })
    expect(js.includes('CUSTOM_VALUE')).toBe(true)
  })

  it('seed + custom pools + fuzz', () => {
    for (let seed = 0; seed < 20; seed++) {
      const len = 20 + seed * 5
      const data = new Uint8Array(len)
      crypto.getRandomValues(data)
      const js = encode(data, {
        seed,
        identifiers: ['alpha', 'beta', 'gamma'],
        strings: ['test_str'],
        numbers: [42424, 13131],
      })
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
