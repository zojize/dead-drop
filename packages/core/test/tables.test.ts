import { describe, expect, it } from 'vitest'
import {
  EXPR_TABLE,
  STMT_TABLE,
  REVERSE_EXPR_TABLE,
  REVERSE_STMT_TABLE,
  exprNodeKey,
  stmtNodeKey,
} from '../src/tables'

describe('tables bijectivity', () => {
  it('STMT_TABLE has 256 entries', () => {
    expect(STMT_TABLE.length).toBe(256)
    for (let i = 0; i < 256; i++) {
      expect(STMT_TABLE[i]).toBeDefined()
    }
  })

  it('EXPR_TABLE has 256 entries', () => {
    expect(EXPR_TABLE.length).toBe(256)
    for (let i = 0; i < 256; i++) {
      expect(EXPR_TABLE[i]).toBeDefined()
    }
  })

  it('STMT_TABLE maps each byte to a unique (nodeType, variant) key', () => {
    const seen = new Set<string>()
    for (let b = 0; b < 256; b++) {
      const cfg = STMT_TABLE[b]
      const key = stmtNodeKey(cfg.nodeType, cfg.variant)
      expect(seen.has(key), `duplicate stmt key at byte 0x${b.toString(16)}: ${key}`).toBe(false)
      seen.add(key)
    }
    expect(seen.size).toBe(256)
  })

  it('EXPR_TABLE maps each byte to a unique (nodeType, variant) key', () => {
    const seen = new Set<string>()
    for (let b = 0; b < 256; b++) {
      const cfg = EXPR_TABLE[b]
      const key = exprNodeKey(cfg.nodeType, cfg.variant)
      expect(seen.has(key), `duplicate expr key at byte 0x${b.toString(16)}: ${key}`).toBe(false)
      seen.add(key)
    }
    expect(seen.size).toBe(256)
  })

  it('REVERSE_STMT_TABLE round-trips every byte', () => {
    for (let b = 0; b < 256; b++) {
      const cfg = STMT_TABLE[b]
      const key = stmtNodeKey(cfg.nodeType, cfg.variant)
      expect(REVERSE_STMT_TABLE.get(key)).toBe(b)
    }
  })

  it('REVERSE_EXPR_TABLE round-trips every byte', () => {
    for (let b = 0; b < 256; b++) {
      const cfg = EXPR_TABLE[b]
      const key = exprNodeKey(cfg.nodeType, cfg.variant)
      expect(REVERSE_EXPR_TABLE.get(key)).toBe(b)
    }
  })

  it('REVERSE_STMT_TABLE has exactly 256 entries', () => {
    expect(REVERSE_STMT_TABLE.size).toBe(256)
  })

  it('REVERSE_EXPR_TABLE has exactly 256 entries', () => {
    expect(REVERSE_EXPR_TABLE.size).toBe(256)
  })
})
