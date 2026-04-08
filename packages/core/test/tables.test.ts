import { describe, expect, it } from 'vitest'
import {
  bitWidth,
  buildReverseTable,
  buildTable,
  filterCandidates,
  initialContext,
} from '../src/context'

describe('dynamic table generation', () => {
  it('builds a power-of-2 table from candidates', () => {
    const ctx = initialContext()
    const candidates = filterCandidates(ctx)
    const table = buildTable(candidates, 0)
    // Table size is 2^bitWidth(uniqueCount)
    const bits = bitWidth(table.length)
    expect(table.length).toBe(1 << bits)
    expect(table.length).toBeGreaterThanOrEqual(128)
  })

  it('reverse table maps candidate keys back to indices', () => {
    const ctx = initialContext()
    const candidates = filterCandidates(ctx)
    const table = buildTable(candidates, 42)
    const rev = buildReverseTable(table)
    for (const [key, idx] of rev) {
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(table.length)
      expect(table[idx].key).toBe(key)
    }
  })

  it('different hashes produce different table orderings', () => {
    const ctx = initialContext()
    const candidates = filterCandidates(ctx)
    const t1 = buildTable(candidates, 0)
    const t2 = buildTable(candidates, 12345)
    const len = Math.min(t1.length, t2.length)
    let diffs = 0
    for (let i = 0; i < len; i++) {
      if (t1[i].key !== t2[i].key)
        diffs++
    }
    expect(diffs).toBeGreaterThan(50)
  })

  it('expression-only context excludes statements', () => {
    const ctx = { ...initialContext(), expressionOnly: true }
    const candidates = filterCandidates(ctx)
    const hasStatement = candidates.some(c => c.isStatement)
    expect(hasStatement).toBe(false)
  })

  it('context-gated entries only appear in correct context', () => {
    const base = filterCandidates(initialContext())
    expect(base.some(c => c.nodeType === 'ReturnStatement')).toBe(false)
    expect(base.some(c => c.nodeType === 'BreakStatement')).toBe(false)
    expect(base.some(c => c.nodeType === 'AwaitExpression')).toBe(false)

    const inFn = filterCandidates({ ...initialContext(), inFunction: true })
    expect(inFn.some(c => c.nodeType === 'ReturnStatement')).toBe(true)

    const inLoop = filterCandidates({ ...initialContext(), inLoop: true })
    expect(inLoop.some(c => c.nodeType === 'BreakStatement')).toBe(true)
    expect(inLoop.some(c => c.nodeType === 'ContinueStatement')).toBe(true)

    const inAsync = filterCandidates({ ...initialContext(), inAsync: true })
    expect(inAsync.some(c => c.nodeType === 'AwaitExpression')).toBe(true)
  })
})
