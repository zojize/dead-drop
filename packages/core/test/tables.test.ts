import { describe, expect, it } from 'vitest'
import {
  initialContext,
  filterCandidates,
  buildTable,
  buildReverseTable,
} from '../src/context'

describe('dynamic table generation', () => {
  it('builds a 256-entry table from candidates', () => {
    const ctx = initialContext()
    const candidates = filterCandidates(ctx)
    const table = buildTable(candidates, 0)
    expect(table.length).toBe(256)
  })

  it('reverse table maps candidate keys back to bytes', () => {
    const ctx = initialContext()
    const candidates = filterCandidates(ctx)
    const table = buildTable(candidates, 42)
    const rev = buildReverseTable(table)
    // Every key in reverse table should point to a valid byte
    for (const [key, byte] of rev) {
      expect(byte).toBeGreaterThanOrEqual(0)
      expect(byte).toBeLessThan(256)
      expect(table[byte].key).toBe(key)
    }
  })

  it('different hashes produce different table orderings', () => {
    const ctx = initialContext()
    const candidates = filterCandidates(ctx)
    const t1 = buildTable(candidates, 0)
    const t2 = buildTable(candidates, 12345)
    // At least some entries should differ
    let diffs = 0
    for (let i = 0; i < 256; i++) {
      if (t1[i].key !== t2[i].key) diffs++
    }
    expect(diffs).toBeGreaterThan(50) // should be significantly shuffled
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
