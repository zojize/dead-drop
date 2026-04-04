import { describe, expect, it } from 'vitest'
import { parse } from '@babel/parser'
import { TextEncoder } from 'node:util'
import { encode } from '../src/encode'
import { decode } from '../src/decode'
import { DEFAULT_POOLS } from '../src/tables'
import type { Pools } from '../src/pools'

function testRoundTrip(input: Uint8Array) {
  const js = encode(input)
  const output = decode(js)
  expect(Array.from(output)).toEqual(Array.from(input))
}

function testRoundTripWithPools(input: Uint8Array, pools: Pools) {
  const js = encode(input, { pools })
  const output = decode(js, { pools })
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

// ─── Data-in-AST invariant tests ────────────────────────────────────────────
// Confirm that ALL data is encoded in the AST structure, not in literal values.
// Changing pools (identifier names, strings, numbers, var names, labels, etc.)
// must not affect the decoded output — only the JS appearance changes.

describe('data lives in AST structure, not literal values', () => {
  /** Generate a completely randomized pool set. */
  function randomPools(seed: number): Pools {
    const rng = mulberry32(seed)
    const randStr = (prefix: string, n: number) => {
      const set = new Set<string>()
      while (set.size < n) set.add(`${prefix}_${rng()}_${set.size}`)
      return [...set]
    }
    const randNums = (n: number) => {
      const set = new Set<number>()
      while (set.size < n) set.add(rng() % 1000000)
      return [...set]
    }
    return {
      identifiers: randStr('id', 64),
      strings: randStr('s', 32),
      numbers: randNums(76),
      varNames: randStr('v', 54),
      labels: randStr('L', 56),
      catchParams: randStr('err', 6),
      memberProps: randStr('p', 8),
    }
  }

  function mulberry32(seed: number) {
    let s = seed | 0
    return () => {
      s = s + 0x6D2B79F5 | 0
      let z = Math.imul(s ^ s >>> 15, 1 | s)
      z = z + Math.imul(z ^ z >>> 7, 61 | z) ^ z
      return ((z ^ z >>> 14) >>> 0)
    }
  }

  it('round-trips with completely randomized pools', () => {
    const msg = new TextEncoder().encode('data in AST, not in names')
    for (let seed = 0; seed < 30; seed++) {
      const pools = randomPools(seed)
      testRoundTripWithPools(msg, pools)
    }
  })

  it('same message, different pools → same decoded bytes', () => {
    const msg = new TextEncoder().encode('the quick brown fox')
    for (let seed = 0; seed < 20; seed++) {
      const pools = randomPools(seed)
      const js = encode(msg, { pools })
      const out = decode(js, { pools })
      expect(Array.from(out)).toEqual(Array.from(msg))
    }
  })

  it('same message, different pools → different JS output', () => {
    const msg = new TextEncoder().encode('hello world')
    const outputs = new Set<string>()
    for (let seed = 0; seed < 10; seed++) {
      outputs.add(encode(msg, { pools: randomPools(seed) }))
    }
    expect(outputs.size).toBe(10)
  })

  it('fuzz: random data × random pools (500 iterations)', () => {
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(Math.random() * 100) + 1
      const data = new Uint8Array(len)
      crypto.getRandomValues(data)
      const pools = randomPools(i)
      testRoundTripWithPools(data, pools)
    }
  })

  it('adversarial: all same byte × random pools', () => {
    for (let b = 0; b < 256; b++) {
      const data = new Uint8Array(10).fill(b)
      const pools = randomPools(b)
      testRoundTripWithPools(data, pools)
    }
  })

  it('swapping only identifiers preserves round-trip', () => {
    const msg = new TextEncoder().encode('identifier swap test')
    const pools: Pools = {
      ...DEFAULT_POOLS,
      identifiers: Array.from({ length: 64 }, (_, i) => `custom_ident_${i}`),
    }
    testRoundTripWithPools(msg, pools)
  })

  it('swapping only var names preserves round-trip', () => {
    const msg = new TextEncoder().encode('var name swap test')
    const pools: Pools = {
      ...DEFAULT_POOLS,
      varNames: Array.from({ length: 54 }, (_, i) => `x${i}`),
    }
    testRoundTripWithPools(msg, pools)
  })

  it('swapping only labels preserves round-trip', () => {
    const msg = new TextEncoder().encode('label swap test')
    const pools: Pools = {
      ...DEFAULT_POOLS,
      labels: Array.from({ length: 56 }, (_, i) => `lbl${i}`),
    }
    testRoundTripWithPools(msg, pools)
  })

  it('swapping only numbers preserves round-trip', () => {
    const msg = new TextEncoder().encode('number swap test')
    const pools: Pools = {
      ...DEFAULT_POOLS,
      numbers: Array.from({ length: 76 }, (_, i) => i * 1000 + 7),
    }
    testRoundTripWithPools(msg, pools)
  })

  it('swapping only strings preserves round-trip', () => {
    const msg = new TextEncoder().encode('string swap test')
    const pools: Pools = {
      ...DEFAULT_POOLS,
      strings: Array.from({ length: 32 }, (_, i) => `word_${i}`),
    }
    testRoundTripWithPools(msg, pools)
  })

  it('swapping only member props preserves round-trip', () => {
    const msg = new TextEncoder().encode('member prop swap test')
    const pools: Pools = {
      ...DEFAULT_POOLS,
      memberProps: ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh'],
    }
    testRoundTripWithPools(msg, pools)
  })

  it('swapping only catch params preserves round-trip', () => {
    const msg = new TextEncoder().encode('catch param swap test')
    const pools: Pools = {
      ...DEFAULT_POOLS,
      catchParams: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'],
    }
    testRoundTripWithPools(msg, pools)
  })

  it('scope tracking: repeated let/const with random pools', () => {
    // Byte 0x42 = VariableDeclaration const tmp. Repeating it tests scope suffix handling.
    for (let poolSeed = 0; poolSeed < 20; poolSeed++) {
      const pools = randomPools(poolSeed)
      const data = new Uint8Array(20).fill(0x42)
      testRoundTripWithPools(data, pools)
    }
  })

  it('scope tracking: repeated labels with random pools', () => {
    // Byte 0x60 = LabeledStatement. Repeating tests label suffix handling.
    for (let poolSeed = 0; poolSeed < 20; poolSeed++) {
      const pools = randomPools(poolSeed)
      const data = new Uint8Array(15).fill(0x60)
      testRoundTripWithPools(data, pools)
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
