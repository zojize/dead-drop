/**
 * Pool types for statement-level name mapping.
 *
 * Statement pools (var names, labels, catch params, member props) are
 * hardcoded in DEFAULT_STMT_POOLS and used by both encoder and decoder.
 * No pool parameter is needed for decoding.
 *
 * Expression encoding is fully structural — no pools needed.
 */

/** Statement-level pools: hardcoded in both encoder and decoder. */
export interface StatementPools {
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
