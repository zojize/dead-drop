/**
 * Minifier-style name generators for default pools.
 * Produces sequences like: _a, _b, ..., _Z, _aa, _ab, ...
 */

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Generate prefixed names: _a, _b, ..., _Z, _aa, _ab, ... */
export function genPrefixed(prefix: string, count: number): string[] {
  const names: string[] = []
  for (let i = 0; i < ALPHA.length && names.length < count; i++) {
    names.push(prefix + ALPHA[i])
  }
  for (let i = 0; i < ALPHA.length && names.length < count; i++) {
    for (let j = 0; j < ALPHA.length && names.length < count; j++) {
      names.push(prefix + ALPHA[i] + ALPHA[j])
    }
  }
  return names
}
