import { describe, expect, it } from 'vitest'
import { deriveScopeBucket, initialContext } from '../src/context'

describe('scope bucket', () => {
  it('initial context is top-level', () => {
    const ctx = initialContext()
    expect(ctx.scopeBucket).toBe('top-level')
  })
})

describe('deriveScopeBucket', () => {
  it('program body → top-level', () => {
    expect(deriveScopeBucket('Program', 'body')).toBe('top-level')
  })

  it('functionDeclaration body → function-body', () => {
    expect(deriveScopeBucket('FunctionDeclaration', 'body')).toBe('function-body')
  })

  it('functionExpression body → function-body', () => {
    expect(deriveScopeBucket('FunctionExpression', 'body')).toBe('function-body')
  })

  it('arrowFunctionExpression body → function-body', () => {
    expect(deriveScopeBucket('ArrowFunctionExpression', 'body')).toBe('function-body')
  })

  it('forStatement body → loop-body', () => {
    expect(deriveScopeBucket('ForStatement', 'body')).toBe('loop-body')
  })

  it('whileStatement body → loop-body', () => {
    expect(deriveScopeBucket('WhileStatement', 'body')).toBe('loop-body')
  })

  it('doWhileStatement body → loop-body', () => {
    expect(deriveScopeBucket('DoWhileStatement', 'body')).toBe('loop-body')
  })

  it('forOfStatement body → loop-body', () => {
    expect(deriveScopeBucket('ForOfStatement', 'body')).toBe('loop-body')
  })

  it('forInStatement body → loop-body', () => {
    expect(deriveScopeBucket('ForInStatement', 'body')).toBe('loop-body')
  })

  it('ifStatement consequent → block-body', () => {
    expect(deriveScopeBucket('IfStatement', 'consequent')).toBe('block-body')
  })

  it('ifStatement alternate → block-body', () => {
    expect(deriveScopeBucket('IfStatement', 'alternate')).toBe('block-body')
  })

  it('blockStatement body → block-body', () => {
    expect(deriveScopeBucket('BlockStatement', 'body')).toBe('block-body')
  })

  it('tryStatement block → block-body', () => {
    expect(deriveScopeBucket('TryStatement', 'block')).toBe('block-body')
  })

  it('catchClause body → block-body', () => {
    expect(deriveScopeBucket('CatchClause', 'body')).toBe('block-body')
  })

  it('switchCase consequent → block-body', () => {
    expect(deriveScopeBucket('SwitchCase', 'consequent')).toBe('block-body')
  })

  it('labeledStatement body → block-body', () => {
    expect(deriveScopeBucket('LabeledStatement', 'body')).toBe('block-body')
  })

  it('unknown parent → block-body (fallback)', () => {
    expect(deriveScopeBucket('Unknown', 'whatever')).toBe('block-body')
  })
})
