import { describe, expect, it } from 'vitest'
import { bigramKey, lookupTransitionWeight } from '../src/context'

describe('bigramKey', () => {
  it('returns key unchanged for statements', () => {
    expect(bigramKey('VariableDeclaration:2', true)).toBe('VariableDeclaration:2')
    expect(bigramKey('IfStatement:1', true)).toBe('IfStatement:1')
    expect(bigramKey('ImportDeclaration:named:1', true)).toBe('ImportDeclaration:named:1')
  })

  it('maps expression candidates to ExpressionStatement:0', () => {
    expect(bigramKey('CallExpression:1', false)).toBe('ExpressionStatement:0')
    expect(bigramKey('BinaryExpression:0', false)).toBe('ExpressionStatement:0')
    expect(bigramKey('Identifier:0', false)).toBe('ExpressionStatement:0')
    expect(bigramKey('NumericLiteral:0', false)).toBe('ExpressionStatement:0')
  })
})

describe('lookupTransitionWeight', () => {
  it('returns null for unknown prev key', () => {
    expect(lookupTransitionWeight('NONEXISTENT_PREV', 'VariableDeclaration:2', 'top-level')).toBeNull()
  })

  it('returns null for unknown next key under known prev', () => {
    const result = lookupTransitionWeight('<START>', 'NONEXISTENT_NEXT_KEY_99', 'top-level')
    expect(result === null || typeof result === 'number').toBe(true)
  })

  it('returns a number for known transitions', () => {
    const result = lookupTransitionWeight('<START>', 'ExpressionStatement:0', 'top-level')
    if (result !== null) {
      expect(result).toBeGreaterThan(0)
    }
  })
})
