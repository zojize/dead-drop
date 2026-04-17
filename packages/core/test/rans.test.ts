import type { CDF } from '../src/context'
import { describe, expect, it } from 'vitest'
import { buildBlockCDF, buildCDF, RANS_L, ransDecode, ransEncode } from '../src/context'

describe('buildCDF', () => {
  it('builds CDF from weighted candidates', () => {
    const candidates = [
      { key: 'A', nodeType: 'A', variant: 0, children: [], weight: 3, isStatement: false },
      { key: 'B', nodeType: 'B', variant: 0, children: [], weight: 1, isStatement: false },
    ]
    const cdf = buildCDF(candidates)
    expect(cdf.total).toBe(1 << 12)
    expect(cdf.cumFreqs[0]).toBe(0)
    expect(cdf.freqs.length).toBe(2)
    expect(cdf.freqs[0]).toBeGreaterThan(cdf.freqs[1])
    expect(cdf.freqs[0] + cdf.freqs[1]).toBe(cdf.total)
    expect(cdf.candidates).toEqual(candidates)
  })

  it('assigns minimum frequency 1 to low-weight candidates', () => {
    const candidates = [
      { key: 'Big', nodeType: 'Big', variant: 0, children: [], weight: 1000, isStatement: false },
      { key: 'Tiny', nodeType: 'Tiny', variant: 0, children: [], weight: 0.001, isStatement: false },
    ]
    const cdf = buildCDF(candidates)
    expect(cdf.freqs[1]).toBeGreaterThanOrEqual(1)
    expect(cdf.freqs[0] + cdf.freqs[1]).toBe(cdf.total)
  })

  it('handles single candidate', () => {
    const candidates = [
      { key: 'Only', nodeType: 'Only', variant: 0, children: [], weight: 5, isStatement: false },
    ]
    const cdf = buildCDF(candidates)
    expect(cdf.freqs[0]).toBe(cdf.total)
    expect(cdf.cumFreqs[0]).toBe(0)
  })

  it('builds reverse map from candidate key to index', () => {
    const candidates = [
      { key: 'A:0', nodeType: 'A', variant: 0, children: [], weight: 3, isStatement: false },
      { key: 'B:1', nodeType: 'B', variant: 1, children: [], weight: 1, isStatement: false },
    ]
    const cdf = buildCDF(candidates)
    expect(cdf.reverseMap.get('A:0')).toBe(0)
    expect(cdf.reverseMap.get('B:1')).toBe(1)
  })

  it('is deterministic', () => {
    const candidates = [
      { key: 'X', nodeType: 'X', variant: 0, children: [], weight: 2, isStatement: false },
      { key: 'Y', nodeType: 'Y', variant: 0, children: [], weight: 3, isStatement: false },
      { key: 'Z', nodeType: 'Z', variant: 0, children: [], weight: 1, isStatement: false },
    ]
    const a = buildCDF(candidates)
    const b = buildCDF(candidates)
    expect(a.freqs).toEqual(b.freqs)
    expect(a.cumFreqs).toEqual(b.cumFreqs)
  })
})

describe('rANS encode/decode', () => {
  it('single symbol round-trips', () => {
    const candidates = [
      { key: 'A', nodeType: 'A', variant: 0, children: [], weight: 3, isStatement: false },
      { key: 'B', nodeType: 'B', variant: 0, children: [], weight: 1, isStatement: false },
    ]
    const cdf = buildCDF(candidates)
    let x = RANS_L
    const bits: number[] = []
    x = ransEncode(x, 0, cdf, bits)
    const { newState: _newState, symbol } = ransDecode(x, cdf, bits)
    expect(symbol).toBe(0)
  })

  it('sequence round-trips via backward decode', () => {
    const candidates = [
      { key: 'A', nodeType: 'A', variant: 0, children: [], weight: 5, isStatement: false },
      { key: 'B', nodeType: 'B', variant: 0, children: [], weight: 3, isStatement: false },
      { key: 'C', nodeType: 'C', variant: 0, children: [], weight: 2, isStatement: false },
    ]
    const cdf = buildCDF(candidates)
    const symbols = [0, 1, 2, 0, 1, 0, 2, 1]

    let x = RANS_L
    const bits: number[] = []
    for (const s of symbols)
      x = ransEncode(x, s, cdf, bits)

    const recovered: number[] = []
    for (let i = symbols.length - 1; i >= 0; i--) {
      const result = ransDecode(x, cdf, bits)
      x = result.newState
      recovered.unshift(result.symbol)
    }
    expect(recovered).toEqual(symbols)
  })

  it('round-trips with varying CDFs per position', () => {
    const cdf1 = buildCDF([
      { key: 'X', nodeType: 'X', variant: 0, children: [], weight: 7, isStatement: false },
      { key: 'Y', nodeType: 'Y', variant: 0, children: [], weight: 3, isStatement: false },
    ])
    const cdf2 = buildCDF([
      { key: 'P', nodeType: 'P', variant: 0, children: [], weight: 1, isStatement: false },
      { key: 'Q', nodeType: 'Q', variant: 0, children: [], weight: 1, isStatement: false },
      { key: 'R', nodeType: 'R', variant: 0, children: [], weight: 1, isStatement: false },
    ])
    const pairs: { cdf: CDF, symbol: number }[] = [
      { cdf: cdf1, symbol: 0 },
      { cdf: cdf2, symbol: 2 },
      { cdf: cdf1, symbol: 1 },
      { cdf: cdf2, symbol: 0 },
    ]

    let x = RANS_L
    const bits: number[] = []
    for (const p of pairs)
      x = ransEncode(x, p.symbol, p.cdf, bits)

    const recovered: { symbol: number }[] = []
    for (let i = pairs.length - 1; i >= 0; i--) {
      const result = ransDecode(x, pairs[i].cdf, bits)
      x = result.newState
      recovered.unshift({ symbol: result.symbol })
    }
    expect(recovered.map(r => r.symbol)).toEqual(pairs.map(p => p.symbol))
  })
})

describe('buildBlockCDF', () => {
  it('returns a CDF covering block counts 0–255', () => {
    const cdf = buildBlockCDF()
    expect(cdf.candidates.length).toBe(256)
    expect(cdf.total).toBe(1 << 12)
    expect(cdf.freqs.reduce((s, f) => s + f, 0)).toBe(cdf.total)
    expect(cdf.reverseMap.get('block:0')).toBe(0)
    expect(cdf.reverseMap.get('block:255')).toBe(255)
  })

  it('is cached (returns same reference)', () => {
    expect(buildBlockCDF()).toBe(buildBlockCDF())
  })

  it('assigns higher frequency to smaller block counts', () => {
    const cdf = buildBlockCDF()
    expect(cdf.freqs[0]).toBeGreaterThan(cdf.freqs[1])
    expect(cdf.freqs[1]).toBeGreaterThanOrEqual(cdf.freqs[10])
  })
})
