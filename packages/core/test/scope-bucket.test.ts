import { describe, expect, it } from 'vitest'
import { initialContext } from '../src/context'

describe('scope bucket', () => {
  it('initial context is top-level', () => {
    const ctx = initialContext()
    expect(ctx.scopeBucket).toBe('top-level')
  })
})
