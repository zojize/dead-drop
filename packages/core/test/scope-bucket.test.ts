import { describe, expect, it } from 'vitest'
import { deriveScopeBucket, initialContext } from '../src/context'

describe('scope bucket', () => {
  it('initial context is top-level', () => {
    const ctx = initialContext()
    expect(ctx.scopeBucket).toBe('top-level')
  })
})

describe('deriveScopeBucket', () => {
  it('Program body → top-level', () => {
    expect(deriveScopeBucket('Program', 'body')).toBe('top-level')
  })

  it('FunctionDeclaration body → function-body', () => {
    expect(deriveScopeBucket('FunctionDeclaration', 'body')).toBe('function-body')
  })

  it('FunctionExpression body → function-body', () => {
    expect(deriveScopeBucket('FunctionExpression', 'body')).toBe('function-body')
  })

  it('ArrowFunctionExpression body → function-body', () => {
    expect(deriveScopeBucket('ArrowFunctionExpression', 'body')).toBe('function-body')
  })

  it('ForStatement body → loop-body', () => {
    expect(deriveScopeBucket('ForStatement', 'body')).toBe('loop-body')
  })

  it('WhileStatement body → loop-body', () => {
    expect(deriveScopeBucket('WhileStatement', 'body')).toBe('loop-body')
  })

  it('DoWhileStatement body → loop-body', () => {
    expect(deriveScopeBucket('DoWhileStatement', 'body')).toBe('loop-body')
  })

  it('ForOfStatement body → loop-body', () => {
    expect(deriveScopeBucket('ForOfStatement', 'body')).toBe('loop-body')
  })

  it('ForInStatement body → loop-body', () => {
    expect(deriveScopeBucket('ForInStatement', 'body')).toBe('loop-body')
  })

  it('IfStatement consequent → block-body', () => {
    expect(deriveScopeBucket('IfStatement', 'consequent')).toBe('block-body')
  })

  it('IfStatement alternate → block-body', () => {
    expect(deriveScopeBucket('IfStatement', 'alternate')).toBe('block-body')
  })

  it('BlockStatement body → block-body', () => {
    expect(deriveScopeBucket('BlockStatement', 'body')).toBe('block-body')
  })

  it('TryStatement block → block-body', () => {
    expect(deriveScopeBucket('TryStatement', 'block')).toBe('block-body')
  })

  it('CatchClause body → block-body', () => {
    expect(deriveScopeBucket('CatchClause', 'body')).toBe('block-body')
  })

  it('SwitchCase consequent → block-body', () => {
    expect(deriveScopeBucket('SwitchCase', 'consequent')).toBe('block-body')
  })

  it('LabeledStatement body → block-body', () => {
    expect(deriveScopeBucket('LabeledStatement', 'body')).toBe('block-body')
  })

  it('unknown parent → block-body (fallback)', () => {
    expect(deriveScopeBucket('Unknown', 'whatever')).toBe('block-body')
  })
})
