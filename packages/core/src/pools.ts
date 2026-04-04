/**
 * Pool configuration shared between encoder and decoder.
 * Pools map variant indices to display values. The AST structure (which
 * variant index was chosen) carries the data; the display values are cosmetic.
 */
export interface Pools {
  identifiers: readonly string[]   // 64 entries (expression Identifier names)
  strings: readonly string[]       // 32 entries (StringLiteral values)
  numbers: readonly number[]       // 76 entries (NumericLiteral values)
  varNames: readonly string[]      // 54 entries (VariableDeclaration declarator names)
  labels: readonly string[]        // 56 entries (LabeledStatement label names)
  catchParams: readonly string[]   // 6 entries (TryStatement catch param names)
  memberProps: readonly string[]   // 8 entries (non-computed MemberExpression property names)
}

/** Suffix separator used for scope-conflict renaming. */
export const SCOPE_SUFFIX_SEP = '$'

/** Strip scope-conflict suffix from a name to recover the base pool name. */
export function stripSuffix(name: string): string {
  const idx = name.indexOf(SCOPE_SUFFIX_SEP)
  return idx === -1 ? name : name.slice(0, idx)
}
