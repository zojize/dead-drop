/**
 * Dynamic encoding context. Tracks scope, nesting, and generates
 * deterministic context-dependent tables for each byte position.
 *
 * Both encoder and decoder maintain identical context state.
 */

// ─── Candidate Entry ────────────────────────────────────────────────────────

export type SlotKind = 'expr' | 'block'

export interface Candidate {
  /** Unique key for this candidate (nodeType:variant or nodeType:variant:sub) */
  key: string
  /** AST node type */
  nodeType: string
  /** Structural variant (operator index, child count, flag combo, etc.) */
  variant: number
  /** Child slots this node requires (drives recursive byte consumption) */
  children: SlotKind[]
  /** Weight multiplier for table selection (higher = more likely to appear) */
  weight: number
  /** Is this a statement (vs expression)? */
  isStatement: boolean
}

// ─── Context State ──────────────────────────────────────────────────────────

type ScopeType = 'number' | 'string' | 'boolean' | 'function' | 'array' | 'object' | 'class' | 'regexp' | 'any'

export interface ScopeEntry {
  name: string
  type: ScopeType
}

/** Max expression nesting depth before forcing leaf-only candidates. */
export const MAX_EXPR_DEPTH = Infinity // default — configurable via createCodec

export interface EncodingContext {
  inFunction: boolean
  inAsync: boolean
  inLoop: boolean
  scope: string[]
  typedScope: ScopeEntry[]
  expressionOnly: boolean
  exprDepth: number
  maxExprDepth: number
}

export function initialContext(): EncodingContext {
  return {
    inFunction: false,
    inAsync: false,
    inLoop: false,
    scope: [],
    typedScope: [],
    expressionOnly: false,
    exprDepth: 0,
    maxExprDepth: MAX_EXPR_DEPTH,
  }
}

// ─── Type inference from candidate key ─────────────────────────────────────

/** Infer the type a VariableDeclaration's init expression produces, from its candidate key. */
export function inferTypeFromKey(candidateKey: string): ScopeType {
  const base = candidateKey.split(':')[0]
  switch (base) {
    case 'NumericLiteral': case 'BigIntLiteral': return 'number'
    case 'StringLiteral': case 'TemplateLiteral': return 'string'
    case 'BooleanLiteral': return 'boolean'
    case 'ArrowFunctionExpression': case 'FunctionExpression': return 'function'
    case 'ArrayExpression': return 'array'
    case 'ObjectExpression': return 'object'
    case 'ClassExpression': return 'class'
    case 'RegExpLiteral': return 'regexp'
    default: return 'any'
  }
}

/** Check if scope has an entry matching any of the given types. */
function scopeHasType(scope: ScopeEntry[], types: ReadonlySet<ScopeType>): boolean {
  return scope.some(e => types.has(e.type))
}

/** Types that support member access safely (won't throw on `.x`). */
const MEMBER_SAFE_TYPES: ReadonlySet<ScopeType> = new Set(['object', 'array', 'string', 'function', 'class', 'regexp', 'any'])
/** Types that are callable. */
const CALLABLE_TYPES: ReadonlySet<ScopeType> = new Set(['function', 'any'])
/** Types that can be used with `new`. */
const CONSTRUCTABLE_TYPES: ReadonlySet<ScopeType> = new Set(['function', 'class', 'any'])
// Note: IN_RHS_TYPES removed — 'in' operator is always filtered out since
// both operands are data children and RHS can't be guaranteed to be an object.

// ─── Running Structural Hash ────────────────────────────────────────────────

/** Simple deterministic hash (FNV-1a inspired). Mix in a byte after each node. */
export function mixHash(hash: number, byte: number): number {
  hash = hash ^ byte
  hash = Math.imul(hash, 0x01000193)
  return hash >>> 0
}

/** Derive a deterministic name from hash + index. */
export function nameFromHash(hash: number, index: number): string {
  const ALPHA = 'abcdefghijklmnopqrstuvwxyz'
  const h = mixHash(hash, index)
  const a = ALPHA[h % 26]
  const b = ALPHA[(h >>> 8) % 26]
  const c = ALPHA[(h >>> 16) % 26]
  return `_${a}${b}${c}`
}

/** Derive a label name from hash. */
export function labelFromHash(hash: number): string {
  const ALPHA = 'abcdefghijklmnopqrstuvwxyz'
  const a = ALPHA[hash % 26]
  const b = ALPHA[(hash >>> 5) % 26]
  return `L${a}${b}`
}

// ─── Candidate Pool ─────────────────────────────────────────────────────────

const BINARY_OPS = ['+', '-', '*', '/', '%', '|', '&', '^', '<<', '>>', '>>>', '==', '!=', '<', '>', 'in'] as const
const LOGICAL_OPS = ['&&', '||', '??'] as const
const UNARY_OPS = ['-', '+', '~', '!', 'typeof', 'void', 'delete'] as const
const UPDATE_OPS = ['++', '--'] as const
const ASSIGN_OPS = ['=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '<<=', '>>=', '>>>=', '**=', '??=', '||=', '&&='] as const
const REGEXP_FLAGS = ['d', 'g', 'i', 'm', 's', 'u'] as const

export { BINARY_OPS, LOGICAL_OPS, UNARY_OPS, UPDATE_OPS, ASSIGN_OPS, REGEXP_FLAGS }

/** Build the full candidate pool (all possible entries across all contexts). */
function buildAllCandidates(): Candidate[] {
  const c: Candidate[] = []

  // ── Expression candidates (always available in expression context) ──

  // Leaves (weight 4 — compact, realistic)
  c.push({ key: 'NumericLiteral:0', nodeType: 'NumericLiteral', variant: 0, children: [], weight: 8, isStatement: false })
  c.push({ key: 'StringLiteral:0', nodeType: 'StringLiteral', variant: 0, children: [], weight: 8, isStatement: false })
  c.push({ key: 'Identifier:0', nodeType: 'Identifier', variant: 0, children: [], weight: 8, isStatement: false })
  c.push({ key: 'BooleanLiteral:1', nodeType: 'BooleanLiteral', variant: 1, children: [], weight: 8, isStatement: false })
  c.push({ key: 'BooleanLiteral:0', nodeType: 'BooleanLiteral', variant: 0, children: [], weight: 8, isStatement: false })
  c.push({ key: 'NullLiteral:0', nodeType: 'NullLiteral', variant: 0, children: [], weight: 8, isStatement: false })
  c.push({ key: 'BigIntLiteral:0', nodeType: 'BigIntLiteral', variant: 0, children: [], weight: 6, isStatement: false })
  c.push({ key: 'ThisExpression:0', nodeType: 'ThisExpression', variant: 0, children: [], weight: 6, isStatement: false })

  // RegExpLiteral — single leaf entry (flags are cosmetic, randomized by encoder)
  c.push({ key: 'RegExpLiteral:0', nodeType: 'RegExpLiteral', variant: 0, children: [], weight: 6, isStatement: false })

  // Binary operators (weight 1, 2 children)
  for (let i = 0; i < BINARY_OPS.length; i++) {
    c.push({ key: `BinaryExpression:${i}`, nodeType: 'BinaryExpression', variant: i, children: ['expr', 'expr'], weight: 1, isStatement: false })
  }

  // Logical operators (weight 1, 2 children)
  for (let i = 0; i < LOGICAL_OPS.length; i++) {
    c.push({ key: `LogicalExpression:${i}`, nodeType: 'LogicalExpression', variant: i, children: ['expr', 'expr'], weight: 1, isStatement: false })
  }

  // Assignment operators (weight 1, 1 child — LHS is cosmetic)
  for (let i = 0; i < ASSIGN_OPS.length; i++) {
    c.push({ key: `AssignmentExpression:${i}`, nodeType: 'AssignmentExpression', variant: i, children: ['expr'], weight: 1, isStatement: false })
  }

  // Unary operators (weight 1.5, 1 child)
  for (let i = 0; i < UNARY_OPS.length; i++) {
    c.push({ key: `UnaryExpression:${i}`, nodeType: 'UnaryExpression', variant: i, children: ['expr'], weight: 1.5, isStatement: false })
  }

  // Update operators (weight 1.5, 1 child — 4 combos: ++/-- × prefix/postfix)
  for (let i = 0; i < 4; i++) {
    c.push({ key: `UpdateExpression:${i}`, nodeType: 'UpdateExpression', variant: i, children: [], weight: 1.5, isStatement: false })
  }

  // Conditional (weight 0.8, 3 children)
  c.push({ key: 'ConditionalExpression:0', nodeType: 'ConditionalExpression', variant: 0, children: ['expr', 'expr', 'expr'], weight: 0.8, isStatement: false })

  // Call/New expression — arg count as variant (type-gated: only when scope has callable/constructable)
  for (let n = 0; n < 19; n++) {
    const ch: SlotKind[] = ['expr', ...Array(n).fill('expr') as SlotKind[]]
    c.push({ key: `CallExpression:${n}`, nodeType: 'CallExpression', variant: n, children: ch, weight: n <= 3 ? 1.5 : n <= 8 ? 0.8 : 0.4, isStatement: false })
  }
  for (let n = 0; n < 16; n++) {
    const ch: SlotKind[] = ['expr', ...Array(n).fill('expr') as SlotKind[]]
    c.push({ key: `NewExpression:${n}`, nodeType: 'NewExpression', variant: n, children: ch, weight: n <= 3 ? 1.2 : 0.5, isStatement: false })
  }

  // OptionalCallExpression — type-gated: expr?.(args) throws if expr is non-null non-callable
  for (let n = 0; n < 19; n++) {
    const ch: SlotKind[] = ['expr', ...Array(n).fill('expr') as SlotKind[]]
    c.push({ key: `OptionalCallExpression:${n}`, nodeType: 'OptionalCallExpression', variant: n, children: ch, weight: n <= 3 ? 1.2 : n <= 8 ? 0.6 : 0.3, isStatement: false })
  }

  // Member expressions (type-gated: only when scope has member-safe types)
  c.push({ key: 'MemberExpression:0', nodeType: 'MemberExpression', variant: 0, children: ['expr'], weight: 1.5, isStatement: false })
  c.push({ key: 'MemberExpression:1', nodeType: 'MemberExpression', variant: 1, children: ['expr', 'expr'], weight: 1, isStatement: false })
  // OptionalMemberExpression — always safe (?.  never throws)
  c.push({ key: 'OptionalMemberExpression:0', nodeType: 'OptionalMemberExpression', variant: 0, children: ['expr'], weight: 1, isStatement: false })
  c.push({ key: 'OptionalMemberExpression:1', nodeType: 'OptionalMemberExpression', variant: 1, children: ['expr', 'expr'], weight: 0.8, isStatement: false })

  // Array/Object — element/prop count (extended to 0-31 for more unique candidates)
  for (let n = 0; n < 32; n++) {
    c.push({ key: `ArrayExpression:${n}`, nodeType: 'ArrayExpression', variant: n, children: Array(n).fill('expr') as SlotKind[], weight: n <= 3 ? 1.5 : n <= 8 ? 0.6 : 0.15, isStatement: false })
  }
  for (let n = 0; n < 32; n++) {
    const ch: SlotKind[] = []
    for (let j = 0; j < n; j++) { ch.push('expr', 'expr') }
    c.push({ key: `ObjectExpression:${n}`, nodeType: 'ObjectExpression', variant: n, children: ch, weight: n <= 3 ? 1.2 : n <= 8 ? 0.5 : 0.1, isStatement: false })
  }

  // Sequence expression (count 2-29, extended range)
  for (let n = 2; n <= 29; n++) {
    c.push({ key: `SequenceExpression:${n - 2}`, nodeType: 'SequenceExpression', variant: n - 2, children: Array(n).fill('expr') as SlotKind[], weight: n <= 4 ? 0.8 : 0.1, isStatement: false })
  }

  // Template literals (extended to 0-16)
  for (let n = 0; n < 17; n++) {
    c.push({ key: `TemplateLiteral:${n}`, nodeType: 'TemplateLiteral', variant: n, children: Array(n).fill('expr') as SlotKind[], weight: n <= 2 ? 1 : 0.15, isStatement: false })
  }
  // TaggedTemplateExpression (type-gated: tag must be callable)
  for (let n = 0; n < 8; n++) {
    c.push({ key: `TaggedTemplateExpression:${n}`, nodeType: 'TaggedTemplateExpression', variant: n, children: ['expr', ...Array(n).fill('expr') as SlotKind[]], weight: n <= 2 ? 0.8 : 0.3, isStatement: false })
  }

  // Arrow/Function expression — param count (extended to 0-23)
  for (let n = 0; n < 24; n++) {
    c.push({ key: `ArrowFunctionExpression:${n}`, nodeType: 'ArrowFunctionExpression', variant: n, children: ['expr'], weight: n <= 3 ? 1 : 0.15, isStatement: false })
  }
  for (let n = 0; n < 24; n++) {
    c.push({ key: `FunctionExpression:${n}`, nodeType: 'FunctionExpression', variant: n, children: ['expr'], weight: n <= 3 ? 0.8 : 0.15, isStatement: false })
  }

  // SpreadElement (weight 0.5)
  c.push({ key: 'SpreadElement:0', nodeType: 'SpreadElement', variant: 0, children: ['expr'], weight: 0.5, isStatement: false })

  // ClassExpression (weight 0.3)
  c.push({ key: 'ClassExpression:0', nodeType: 'ClassExpression', variant: 0, children: [], weight: 0.3, isStatement: false })
  c.push({ key: 'ClassExpression:1', nodeType: 'ClassExpression', variant: 1, children: ['expr'], weight: 0.3, isStatement: false })

  // ── Statement candidates (only available in statement context) ──

  // ExpressionStatement wraps an expression (weight 3 — very common)
  c.push({ key: 'ExpressionStatement:0', nodeType: 'ExpressionStatement', variant: 0, children: ['expr'], weight: 3, isStatement: true })

  // VariableDeclaration: var/let/const (weight 2)
  c.push({ key: 'VariableDeclaration:0', nodeType: 'VariableDeclaration', variant: 0, children: ['expr'], weight: 2, isStatement: true }) // var
  c.push({ key: 'VariableDeclaration:1', nodeType: 'VariableDeclaration', variant: 1, children: ['expr'], weight: 2, isStatement: true }) // let
  c.push({ key: 'VariableDeclaration:2', nodeType: 'VariableDeclaration', variant: 2, children: ['expr'], weight: 2, isStatement: true }) // const

  // IfStatement: with/without else (weight 1.5)
  c.push({ key: 'IfStatement:0', nodeType: 'IfStatement', variant: 0, children: ['expr', 'block', 'block'], weight: 1.5, isStatement: true })
  c.push({ key: 'IfStatement:1', nodeType: 'IfStatement', variant: 1, children: ['expr', 'block'], weight: 1.5, isStatement: true })

  // WhileStatement (weight 1)
  c.push({ key: 'WhileStatement:0', nodeType: 'WhileStatement', variant: 0, children: ['expr', 'block'], weight: 1, isStatement: true })

  // ForStatement × 8 null combos (weight 0.8)
  for (let v = 0; v < 8; v++) {
    const ch: SlotKind[] = []
    if (v & 1) ch.push('expr')
    if (v & 2) ch.push('expr')
    if (v & 4) ch.push('expr')
    ch.push('block')
    c.push({ key: `ForStatement:${v}`, nodeType: 'ForStatement', variant: v, children: ch, weight: 0.8, isStatement: true })
  }

  // DoWhileStatement (weight 0.8)
  c.push({ key: 'DoWhileStatement:0', nodeType: 'DoWhileStatement', variant: 0, children: ['expr', 'block'], weight: 0.8, isStatement: true })

  // BlockStatement (weight 0.5)
  c.push({ key: 'BlockStatement:0', nodeType: 'BlockStatement', variant: 0, children: ['block'], weight: 0.5, isStatement: true })

  // TryStatement (weight 0.5)
  c.push({ key: 'TryStatement:0', nodeType: 'TryStatement', variant: 0, children: ['block', 'block'], weight: 0.5, isStatement: true })

  // SwitchStatement × case counts 0-15 (weight varies)
  for (let n = 0; n <= 15; n++) {
    const ch: SlotKind[] = ['expr']
    for (let j = 0; j < n; j++) { ch.push('expr', 'block') }
    c.push({ key: `SwitchStatement:${n}`, nodeType: 'SwitchStatement', variant: n, children: ch, weight: n <= 3 ? 0.6 : 0.2, isStatement: true })
  }

  // LabeledStatement (weight 0.5)
  c.push({ key: 'LabeledStatement:0', nodeType: 'LabeledStatement', variant: 0, children: ['block'], weight: 0.5, isStatement: true })

  // ThrowStatement (weight 0.5)
  c.push({ key: 'ThrowStatement:0', nodeType: 'ThrowStatement', variant: 0, children: ['expr'], weight: 0.5, isStatement: true })

  // EmptyStatement (weight 0.25 — leaf)
  c.push({ key: 'EmptyStatement:0', nodeType: 'EmptyStatement', variant: 0, children: [], weight: 0.25, isStatement: true })

  // DebuggerStatement (weight 0.25 — leaf)
  c.push({ key: 'DebuggerStatement:0', nodeType: 'DebuggerStatement', variant: 0, children: [], weight: 0.25, isStatement: true })

  // Context-gated statements (added dynamically):
  // ReturnStatement (weight 1, only in function)
  c.push({ key: 'ReturnStatement:0', nodeType: 'ReturnStatement', variant: 0, children: ['expr'], weight: 1, isStatement: true })

  // BreakStatement (weight 0.3, only in loop)
  c.push({ key: 'BreakStatement:0', nodeType: 'BreakStatement', variant: 0, children: [], weight: 0.3, isStatement: true })

  // ContinueStatement (weight 0.3, only in loop)
  c.push({ key: 'ContinueStatement:0', nodeType: 'ContinueStatement', variant: 0, children: [], weight: 0.3, isStatement: true })

  // AwaitExpression (weight 1, only in async function)
  c.push({ key: 'AwaitExpression:0', nodeType: 'AwaitExpression', variant: 0, children: ['expr'], weight: 1, isStatement: false })

  return c
}

const ALL_CANDIDATES = buildAllCandidates()

// ─── Context-dependent table builder ────────────────────────────────────────

/** Filter candidates by current context. */
export function filterCandidates(ctx: EncodingContext): Candidate[] {
  const hasCallable = scopeHasType(ctx.typedScope, CALLABLE_TYPES)
  const hasConstructable = scopeHasType(ctx.typedScope, CONSTRUCTABLE_TYPES)
  const hasMemberSafe = scopeHasType(ctx.typedScope, MEMBER_SAFE_TYPES)
  const hasAnyScope = ctx.typedScope.length > 0

  return ALL_CANDIDATES.filter(c => {
    // Expression-only context: only expressions
    if (ctx.expressionOnly && c.isStatement) return false

    // Statement context: BOTH statements and expressions are available.
    // Expressions are implicitly wrapped in ExpressionStatement by the encoder.
    // The decoder identifies them from the ExpressionStatement's inner expression.

    // Context-gated entries
    if (c.nodeType === 'ReturnStatement' && !ctx.inFunction) return false
    if (c.nodeType === 'BreakStatement' && !ctx.inLoop) return false
    if (c.nodeType === 'ContinueStatement' && !ctx.inLoop) return false
    if (c.nodeType === 'AwaitExpression' && !ctx.inAsync) return false

    // Type-safety gates: filter candidates that would cause runtime errors
    if (c.nodeType === 'CallExpression' && !hasCallable) return false
    if (c.nodeType === 'OptionalCallExpression' && !hasCallable) return false
    if (c.nodeType === 'NewExpression' && !hasConstructable) return false
    if (c.nodeType === 'MemberExpression' && !hasMemberSafe) return false
    if (c.nodeType === 'TaggedTemplateExpression' && !hasCallable) return false
    if (c.nodeType === 'AssignmentExpression' && !hasAnyScope) return false
    if (c.nodeType === 'UpdateExpression' && !hasAnyScope) return false
    // ClassExpression with superClass — super must be constructable
    if (c.nodeType === 'ClassExpression' && c.variant === 1 && !hasConstructable) return false
    // SpreadElement — argument must be iterable, can't guarantee
    if (c.nodeType === 'SpreadElement') return false
    // 'in' operator (BINARY_OPS index 15) — RHS must be object, can't guarantee
    if (c.nodeType === 'BinaryExpression' && c.variant === 15) return false
    // 'delete' operator (UNARY_OPS index 6) — 'delete ident' is illegal in strict mode
    if (c.nodeType === 'UnaryExpression' && c.variant === 6) return false
    // BigIntLiteral — mixed BigInt/Number operations throw TypeError
    if (c.nodeType === 'BigIntLiteral') return false

    return true
  }).map(c => {
    let w = c.weight

    // Dynamic weight: Identifier gets heavier with more scope entries
    if (c.nodeType === 'Identifier' && ctx.typedScope.length > 0) {
      w += ctx.typedScope.length * 0.5
    }

    // Depth-based weight scaling: as depth approaches maxExprDepth,
    // heavily bias toward leaves to keep AST shallow
    if (ctx.exprDepth > 0 && ctx.maxExprDepth < Infinity) {
      const depthRatio = ctx.exprDepth / ctx.maxExprDepth // 0..1+
      if (c.children.length === 0) {
        // Leaves get exponentially heavier near the limit
        w *= 1 + depthRatio * 20
      } else {
        // Non-leaves get exponentially lighter
        w *= Math.max(0.01, 1 - depthRatio * 0.9)
      }
    }

    return w !== c.weight ? { ...c, weight: w } : c
  })
}

/** Build a BIJECTIVE 256-entry table from weighted candidates using hash as seed.
 *  Each byte 0-255 maps to a UNIQUE candidate key. No duplicates. */
export function buildTable(candidates: Candidate[], hash: number): Candidate[] {
  if (candidates.length === 0) throw new Error('No candidates for context')

  // Deterministic PRNG
  let s = hash | 0
  function rng(): number {
    s = s + 0x6D2B79F5 | 0
    let z = Math.imul(s ^ s >>> 15, 1 | s)
    z = z + Math.imul(z ^ z >>> 7, 61 | z) ^ z
    return ((z ^ z >>> 14) >>> 0)
  }

  // If we have >= 256 unique candidates, shuffle and take first 256
  // If < 256, use all candidates (table will be smaller — pad with wrapping)
  // BUT: we need exactly 256 UNIQUE entries for bijectivity.
  //
  // Strategy: shuffle candidates by weight-biased random, take first 256.
  // Weight bias: sort by (weight * random), higher weight → more likely to appear early.

  // Assign a sort key: weight * random (higher weight → higher priority)
  const scored = candidates.map(c => ({ c, score: c.weight * (rng() % 1000 + 1) }))
  scored.sort((a, b) => b.score - a.score)

  const table: Candidate[] = []
  const usedKeys = new Set<string>()

  // Take unique candidates in priority order
  for (const { c } of scored) {
    if (usedKeys.has(c.key)) continue
    usedKeys.add(c.key)
    table.push(c)
    if (table.length === 256) break
  }

  // If we still need more (< 256 unique candidates), this is a problem.
  // Shouldn't happen with our pool (~300+ entries), but handle gracefully:
  if (table.length < 256) {
    // Pad by reusing candidates with modified keys (add suffix)
    let padIdx = 0
    while (table.length < 256) {
      const base = candidates[padIdx % candidates.length]
      const padKey = `${base.key}:pad${padIdx}`
      table.push({ ...base, key: padKey })
      padIdx++
    }
  }

  // Final shuffle to distribute entries across byte range
  for (let i = table.length - 1; i > 0; i--) {
    const j = rng() % (i + 1)
    const tmp = table[i]
    table[i] = table[j]
    table[j] = tmp
  }

  return table
}

/** Build a reverse lookup: candidate key → byte value. */
export function buildReverseTable(table: Candidate[]): Map<string, number> {
  const rev = new Map<string, number>()
  // First occurrence wins (for duplicate candidates from weighting)
  for (let b = 0; b < 256; b++) {
    const key = table[b].key
    if (!rev.has(key)) rev.set(key, b)
  }
  return rev
}
