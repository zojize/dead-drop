/**
 * Minifier-style name generators for default pools.
 * Produces sequences like: a, b, ..., z, A, ..., Z, aa, ab, ...
 */

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Generate minifier-style identifier names: a, b, ..., Z, aa, ab, ... */
export function genIdents(count: number): string[] {
  const names: string[] = []
  for (let i = 0; i < ALPHA.length && names.length < count; i++) {
    names.push(ALPHA[i])
  }
  for (let i = 0; i < ALPHA.length && names.length < count; i++) {
    for (let j = 0; j < ALPHA.length && names.length < count; j++) {
      names.push(ALPHA[i] + ALPHA[j])
    }
  }
  return names
}

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

/** Generate short string literals: "a", "b", ..., "0", "1", ... */
export function genStrings(count: number): string[] {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const strs: string[] = []
  for (let i = 0; i < chars.length && strs.length < count; i++) {
    strs.push(chars[i])
  }
  for (let i = 0; i < chars.length && strs.length < count; i++) {
    for (let j = 0; j < chars.length && strs.length < count; j++) {
      strs.push(chars[i] + chars[j])
    }
  }
  return strs
}

/** Generate sequential integers: 0, 1, 2, ... */
export function genNumbers(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i)
}
