/**
 * Dynamic encoding context. Tracks scope, nesting, and generates
 * deterministic context-dependent tables for each byte position.
 *
 * Both encoder and decoder maintain identical context state.
 */
import corpusTransitions from './corpus-transitions.json'
import corpusWeights from './corpus-weights.json'

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
export const MAX_EXPR_DEPTH = Infinity // default — override via createCodec for browser use

export type ScopeBucket = 'top-level' | 'function-body' | 'loop-body' | 'block-body'

/**
 * Derive the scope bucket for code entering a parent node's slot.
 * Encoder and decoder must agree on this mapping identically.
 */
export function deriveScopeBucket(parentType: string, slot: string): ScopeBucket {
  if (parentType === 'Program')
    return 'top-level'
  if (parentType === 'FunctionDeclaration' || parentType === 'FunctionExpression' || parentType === 'ArrowFunctionExpression')
    return slot === 'body' ? 'function-body' : 'block-body'
  if (parentType === 'ForStatement' || parentType === 'WhileStatement' || parentType === 'DoWhileStatement' || parentType === 'ForOfStatement' || parentType === 'ForInStatement')
    return slot === 'body' ? 'loop-body' : 'block-body'
  return 'block-body'
}

export interface EncodingContext {
  inFunction: boolean
  inAsync: boolean
  inLoop: boolean
  scope: string[]
  typedScope: ScopeEntry[]
  expressionOnly: boolean
  exprDepth: number
  maxExprDepth: number
  blockDepth: number
  scopeBucket: ScopeBucket
  prevStmtKey: string
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
    blockDepth: 0,
    scopeBucket: 'top-level',
    prevStmtKey: '<START>',
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

// ─── Bitstream I/O ─────────────────────────────────────────────────────────

/** Compute how many bits to read/write for a given number of unique candidates. */
export function bitWidth(uniqueCount: number): number {
  if (uniqueCount <= 1)
    return 0
  return Math.floor(Math.log2(uniqueCount))
}

/** Writes variable-width values into a bit buffer. */
export class BitWriter {
  private bits: number[] = []

  /** Write `width` least-significant bits of `value`. */
  write(value: number, width: number): void {
    for (let i = width - 1; i >= 0; i--)
      this.bits.push((value >>> i) & 1)
  }

  /** Flush to a Uint8Array (zero-padded to byte boundary). */
  toBytes(): Uint8Array {
    const len = Math.ceil(this.bits.length / 8)
    const out = new Uint8Array(len)
    for (let i = 0; i < this.bits.length; i++)
      out[i >>> 3] |= this.bits[i] << (7 - (i & 7))
    return out
  }
}

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
export { ASSIGN_OPS, BINARY_OPS, LOGICAL_OPS, UNARY_OPS, UPDATE_OPS }

type WeightTable = Record<string, number>
interface BucketedWeights {
  'top-level': WeightTable
  'function-body': WeightTable
  'loop-body': WeightTable
  'block-body': WeightTable
  'global': WeightTable
}

const W = corpusWeights as BucketedWeights

type TransitionTable = Record<string, Record<string, Record<string, number>>>
const T = corpusTransitions as TransitionTable

/**
 * Corpus-derived weight for a candidate key in a given bucket.
 * Falls through: bucket-specific → global → 0.01 default.
 */
function lookupWeight(key: string, bucket: ScopeBucket = 'top-level'): number {
  return W[bucket]?.[key] ?? W.global[key] ?? 0.01
}

/**
 * Map a candidate key to its coarsened bigram key for transition lookup.
 * Expression candidates map to synthetic aggregate key 'ExpressionStatement:0'
 * (not a real candidate — ExpressionStatement is never in the pool directly).
 * Corpus scraper emits this same key for ExpressionStatement nodes.
 */
export function bigramKey(candidateKey: string, isStatement: boolean): string {
  return isStatement ? candidateKey : 'ExpressionStatement:0'
}

/**
 * Look up the bigram transition weight for (prev → candidateKey) in a bucket.
 * Returns the weight if found, or null to signal unigram fallback.
 */
export function lookupTransitionWeight(
  prev: string,
  candidateKey: string,
  bucket: ScopeBucket,
): number | null {
  return T[bucket]?.[prev]?.[candidateKey] ?? null
}

/** Build the full candidate pool (all possible entries across all contexts). */
function buildAllCandidates(): Candidate[] {
  const c: Candidate[] = []

  // ── Expression candidates (always available in expression context) ──

  // Leaves
  c.push({ key: 'NumericLiteral:0', nodeType: 'NumericLiteral', variant: 0, children: [], weight: lookupWeight('NumericLiteral:0'), isStatement: false })
  c.push({ key: 'StringLiteral:0', nodeType: 'StringLiteral', variant: 0, children: [], weight: lookupWeight('StringLiteral:0'), isStatement: false })
  c.push({ key: 'Identifier:0', nodeType: 'Identifier', variant: 0, children: [], weight: lookupWeight('Identifier:0'), isStatement: false })
  c.push({ key: 'BooleanLiteral:1', nodeType: 'BooleanLiteral', variant: 1, children: [], weight: lookupWeight('BooleanLiteral:1'), isStatement: false })
  c.push({ key: 'BooleanLiteral:0', nodeType: 'BooleanLiteral', variant: 0, children: [], weight: lookupWeight('BooleanLiteral:0'), isStatement: false })
  c.push({ key: 'NullLiteral:0', nodeType: 'NullLiteral', variant: 0, children: [], weight: lookupWeight('NullLiteral:0'), isStatement: false })
  c.push({ key: 'BigIntLiteral:0', nodeType: 'BigIntLiteral', variant: 0, children: [], weight: lookupWeight('BigIntLiteral:0'), isStatement: false })
  c.push({ key: 'ThisExpression:0', nodeType: 'ThisExpression', variant: 0, children: [], weight: lookupWeight('ThisExpression:0'), isStatement: false })

  // RegExpLiteral — single leaf entry (flags are cosmetic, randomized by encoder)
  c.push({ key: 'RegExpLiteral:0', nodeType: 'RegExpLiteral', variant: 0, children: [], weight: lookupWeight('RegExpLiteral:0'), isStatement: false })

  // Binary operators (weight 1, 2 children)
  for (let i = 0; i < BINARY_OPS.length; i++) {
    c.push({ key: `BinaryExpression:${i}`, nodeType: 'BinaryExpression', variant: i, children: ['expr', 'expr'], weight: lookupWeight(`BinaryExpression:${i}`), isStatement: false })
  }

  // Logical operators (weight 1, 2 children)
  for (let i = 0; i < LOGICAL_OPS.length; i++) {
    c.push({ key: `LogicalExpression:${i}`, nodeType: 'LogicalExpression', variant: i, children: ['expr', 'expr'], weight: lookupWeight(`LogicalExpression:${i}`), isStatement: false })
  }

  // Assignment operators (weight 1, 1 child — LHS is cosmetic)
  for (let i = 0; i < ASSIGN_OPS.length; i++) {
    c.push({ key: `AssignmentExpression:${i}`, nodeType: 'AssignmentExpression', variant: i, children: ['expr'], weight: lookupWeight(`AssignmentExpression:${i}`), isStatement: false })
  }

  // Unary operators (weight 1.5, 1 child)
  for (let i = 0; i < UNARY_OPS.length; i++) {
    c.push({ key: `UnaryExpression:${i}`, nodeType: 'UnaryExpression', variant: i, children: ['expr'], weight: lookupWeight(`UnaryExpression:${i}`), isStatement: false })
  }

  // Update operators (weight 1.5, 1 child — 4 combos: ++/-- × prefix/postfix)
  for (let i = 0; i < 4; i++) {
    c.push({ key: `UpdateExpression:${i}`, nodeType: 'UpdateExpression', variant: i, children: [], weight: lookupWeight(`UpdateExpression:${i}`), isStatement: false })
  }

  // Conditional (weight 0.8, 3 children)
  c.push({ key: 'ConditionalExpression:0', nodeType: 'ConditionalExpression', variant: 0, children: ['expr', 'expr', 'expr'], weight: lookupWeight('ConditionalExpression:0'), isStatement: false })

  // Call/New expression — arg count as variant (type-gated: only when scope has callable/constructable)
  for (let n = 0; n < 19; n++) {
    const ch: SlotKind[] = ['expr', ...Array.from<SlotKind>({ length: n }).fill('expr')]
    c.push({ key: `CallExpression:${n}`, nodeType: 'CallExpression', variant: n, children: ch, weight: lookupWeight(`CallExpression:${n}`), isStatement: false })
  }
  for (let n = 0; n < 16; n++) {
    const ch: SlotKind[] = ['expr', ...Array.from<SlotKind>({ length: n }).fill('expr')]
    c.push({ key: `NewExpression:${n}`, nodeType: 'NewExpression', variant: n, children: ch, weight: lookupWeight(`NewExpression:${n}`), isStatement: false })
  }

  // OptionalCallExpression — type-gated: expr?.(args) throws if expr is non-null non-callable
  for (let n = 0; n < 19; n++) {
    const ch: SlotKind[] = ['expr', ...Array.from<SlotKind>({ length: n }).fill('expr')]
    c.push({ key: `OptionalCallExpression:${n}`, nodeType: 'OptionalCallExpression', variant: n, children: ch, weight: lookupWeight(`OptionalCallExpression:${n}`), isStatement: false })
  }

  // Member expressions (type-gated: only when scope has member-safe types)
  c.push({ key: 'MemberExpression:0', nodeType: 'MemberExpression', variant: 0, children: ['expr'], weight: lookupWeight('MemberExpression:0'), isStatement: false })
  c.push({ key: 'MemberExpression:1', nodeType: 'MemberExpression', variant: 1, children: ['expr', 'expr'], weight: lookupWeight('MemberExpression:1'), isStatement: false })
  // OptionalMemberExpression — always safe (?.  never throws)
  c.push({ key: 'OptionalMemberExpression:0', nodeType: 'OptionalMemberExpression', variant: 0, children: ['expr'], weight: lookupWeight('OptionalMemberExpression:0'), isStatement: false })
  c.push({ key: 'OptionalMemberExpression:1', nodeType: 'OptionalMemberExpression', variant: 1, children: ['expr', 'expr'], weight: lookupWeight('OptionalMemberExpression:1'), isStatement: false })

  // Array/Object — element/prop count (extended to 0-31 for more unique candidates)
  for (let n = 0; n < 32; n++) {
    c.push({ key: `ArrayExpression:${n}`, nodeType: 'ArrayExpression', variant: n, children: Array.from<SlotKind>({ length: n }).fill('expr'), weight: lookupWeight(`ArrayExpression:${n}`), isStatement: false })
  }
  for (let n = 0; n < 32; n++) {
    const ch: SlotKind[] = []
    for (let j = 0; j < n; j++) {
      ch.push('expr', 'expr')
    }
    c.push({ key: `ObjectExpression:${n}`, nodeType: 'ObjectExpression', variant: n, children: ch, weight: lookupWeight(`ObjectExpression:${n}`), isStatement: false })
  }

  // Sequence expression (count 2-29, extended range)
  for (let n = 2; n <= 29; n++) {
    c.push({ key: `SequenceExpression:${n - 2}`, nodeType: 'SequenceExpression', variant: n - 2, children: Array.from<SlotKind>({ length: n }).fill('expr'), weight: lookupWeight(`SequenceExpression:${n - 2}`), isStatement: false })
  }

  // Template literals (extended to 0-16)
  for (let n = 0; n < 17; n++) {
    c.push({ key: `TemplateLiteral:${n}`, nodeType: 'TemplateLiteral', variant: n, children: Array.from<SlotKind>({ length: n }).fill('expr'), weight: lookupWeight(`TemplateLiteral:${n}`), isStatement: false })
  }
  // TaggedTemplateExpression (type-gated: tag must be callable)
  for (let n = 0; n < 8; n++) {
    c.push({ key: `TaggedTemplateExpression:${n}`, nodeType: 'TaggedTemplateExpression', variant: n, children: ['expr', ...Array.from<SlotKind>({ length: n }).fill('expr')], weight: lookupWeight(`TaggedTemplateExpression:${n}`), isStatement: false })
  }

  // Arrow/Function expression — param count (extended to 0-23)
  for (let n = 0; n < 24; n++) {
    c.push({ key: `ArrowFunctionExpression:${n}`, nodeType: 'ArrowFunctionExpression', variant: n, children: ['expr'], weight: lookupWeight(`ArrowFunctionExpression:${n}`), isStatement: false })
  }
  for (let n = 0; n < 24; n++) {
    c.push({ key: `FunctionExpression:${n}`, nodeType: 'FunctionExpression', variant: n, children: ['expr'], weight: lookupWeight(`FunctionExpression:${n}`), isStatement: false })
  }

  // SpreadElement (weight 0.5)
  c.push({ key: 'SpreadElement:0', nodeType: 'SpreadElement', variant: 0, children: ['expr'], weight: lookupWeight('SpreadElement:0'), isStatement: false })

  // ClassExpression (weight 0.3)
  c.push({ key: 'ClassExpression:0', nodeType: 'ClassExpression', variant: 0, children: [], weight: lookupWeight('ClassExpression:0'), isStatement: false })
  c.push({ key: 'ClassExpression:1', nodeType: 'ClassExpression', variant: 1, children: ['expr'], weight: lookupWeight('ClassExpression:1'), isStatement: false })

  // ── Statement candidates (only available in statement context) ──

  // ExpressionStatement is NOT a candidate — expression candidates in statement context
  // are wrapped in ExpressionStatement automatically by the encoder's default case.
  // Having ExpressionStatement:0 as a separate candidate creates ambiguity in the decoder
  // (can't distinguish "expression selected directly" from "ExpressionStatement selected + inner expr").

  // VariableDeclaration: var/let/const (weight 2)
  c.push({ key: 'VariableDeclaration:0', nodeType: 'VariableDeclaration', variant: 0, children: ['expr'], weight: lookupWeight('VariableDeclaration:0'), isStatement: true }) // var
  c.push({ key: 'VariableDeclaration:1', nodeType: 'VariableDeclaration', variant: 1, children: ['expr'], weight: lookupWeight('VariableDeclaration:1'), isStatement: true }) // let
  c.push({ key: 'VariableDeclaration:2', nodeType: 'VariableDeclaration', variant: 2, children: ['expr'], weight: lookupWeight('VariableDeclaration:2'), isStatement: true }) // const

  // IfStatement: with/without else (weight 1.5)
  c.push({ key: 'IfStatement:0', nodeType: 'IfStatement', variant: 0, children: ['expr', 'block', 'block'], weight: lookupWeight('IfStatement:0'), isStatement: true })
  c.push({ key: 'IfStatement:1', nodeType: 'IfStatement', variant: 1, children: ['expr', 'block'], weight: lookupWeight('IfStatement:1'), isStatement: true })

  // WhileStatement (weight 1)
  c.push({ key: 'WhileStatement:0', nodeType: 'WhileStatement', variant: 0, children: ['expr', 'block'], weight: lookupWeight('WhileStatement:0'), isStatement: true })

  // ForStatement × 8 null combos (weight 0.8)
  for (let v = 0; v < 8; v++) {
    const ch: SlotKind[] = []
    if (v & 1)
      ch.push('expr')
    if (v & 2)
      ch.push('expr')
    if (v & 4)
      ch.push('expr')
    ch.push('block')
    c.push({ key: `ForStatement:${v}`, nodeType: 'ForStatement', variant: v, children: ch, weight: lookupWeight(`ForStatement:${v}`), isStatement: true })
  }

  // DoWhileStatement (weight 0.8)
  c.push({ key: 'DoWhileStatement:0', nodeType: 'DoWhileStatement', variant: 0, children: ['expr', 'block'], weight: lookupWeight('DoWhileStatement:0'), isStatement: true })

  // BlockStatement (weight 0.5)
  c.push({ key: 'BlockStatement:0', nodeType: 'BlockStatement', variant: 0, children: ['block'], weight: lookupWeight('BlockStatement:0'), isStatement: true })

  // TryStatement (weight 0.5)
  c.push({ key: 'TryStatement:0', nodeType: 'TryStatement', variant: 0, children: ['block', 'block'], weight: lookupWeight('TryStatement:0'), isStatement: true })

  // SwitchStatement × case counts 0-15 (weight varies)
  for (let n = 0; n <= 15; n++) {
    const ch: SlotKind[] = ['expr']
    for (let j = 0; j < n; j++) {
      ch.push('expr', 'block')
    }
    c.push({ key: `SwitchStatement:${n}`, nodeType: 'SwitchStatement', variant: n, children: ch, weight: lookupWeight(`SwitchStatement:${n}`), isStatement: true })
  }

  // LabeledStatement (weight 0.5)
  c.push({ key: 'LabeledStatement:0', nodeType: 'LabeledStatement', variant: 0, children: ['block'], weight: lookupWeight('LabeledStatement:0'), isStatement: true })

  // ThrowStatement (weight 0.5)
  c.push({ key: 'ThrowStatement:0', nodeType: 'ThrowStatement', variant: 0, children: ['expr'], weight: lookupWeight('ThrowStatement:0'), isStatement: true })

  // EmptyStatement (weight 0.25 — leaf)
  c.push({ key: 'EmptyStatement:0', nodeType: 'EmptyStatement', variant: 0, children: [], weight: lookupWeight('EmptyStatement:0'), isStatement: true })

  // DebuggerStatement (weight 0.25 — leaf)
  c.push({ key: 'DebuggerStatement:0', nodeType: 'DebuggerStatement', variant: 0, children: [], weight: lookupWeight('DebuggerStatement:0'), isStatement: true })

  // Context-gated statements (added dynamically):
  // ReturnStatement (weight 1, only in function)
  c.push({ key: 'ReturnStatement:0', nodeType: 'ReturnStatement', variant: 0, children: ['expr'], weight: lookupWeight('ReturnStatement:0'), isStatement: true })

  // BreakStatement (weight 0.3, only in loop)
  c.push({ key: 'BreakStatement:0', nodeType: 'BreakStatement', variant: 0, children: [], weight: lookupWeight('BreakStatement:0'), isStatement: true })

  // ContinueStatement (weight 0.3, only in loop)
  c.push({ key: 'ContinueStatement:0', nodeType: 'ContinueStatement', variant: 0, children: [], weight: lookupWeight('ContinueStatement:0'), isStatement: true })

  // AwaitExpression (weight 1, only in async function)
  c.push({ key: 'AwaitExpression:0', nodeType: 'AwaitExpression', variant: 0, children: ['expr'], weight: lookupWeight('AwaitExpression:0'), isStatement: false })

  // ImportDeclaration — top-level only
  // variant 0 = side-effect import: `import 'pkg'`
  // variant 1 = default import: `import x from 'pkg'`
  // variants 2..5 = named imports with 1..4 specifiers: `import { a, b } from 'pkg'`
  c.push({ key: 'ImportDeclaration:sideEffect', nodeType: 'ImportDeclaration', variant: 0, children: [], weight: lookupWeight('ImportDeclaration:sideEffect'), isStatement: true })
  c.push({ key: 'ImportDeclaration:default', nodeType: 'ImportDeclaration', variant: 1, children: [], weight: lookupWeight('ImportDeclaration:default'), isStatement: true })
  for (let n = 1; n <= 4; n++) {
    c.push({ key: `ImportDeclaration:named:${n}`, nodeType: 'ImportDeclaration', variant: 1 + n, children: [], weight: lookupWeight(`ImportDeclaration:named:${n}`), isStatement: true })
  }

  // ExportDefaultDeclaration — top-level only; wraps an expression (data-carrying child)
  c.push({ key: 'ExportDefaultDeclaration:0', nodeType: 'ExportDefaultDeclaration', variant: 0, children: ['expr'], weight: lookupWeight('ExportDefaultDeclaration:0'), isStatement: true })

  // ExportNamedDeclaration wrapping VariableDeclaration — top-level only; 3 variants for var/let/const
  c.push({ key: 'ExportNamedDeclaration:variable:0', nodeType: 'ExportNamedDeclaration', variant: 0, children: ['expr'], weight: lookupWeight('ExportNamedDeclaration:variable:0'), isStatement: true })
  c.push({ key: 'ExportNamedDeclaration:variable:1', nodeType: 'ExportNamedDeclaration', variant: 1, children: ['expr'], weight: lookupWeight('ExportNamedDeclaration:variable:1'), isStatement: true })
  c.push({ key: 'ExportNamedDeclaration:variable:2', nodeType: 'ExportNamedDeclaration', variant: 2, children: ['expr'], weight: lookupWeight('ExportNamedDeclaration:variable:2'), isStatement: true })

  // ExportNamedDeclaration wrapping FunctionDeclaration — top-level only; 4 variants for param count 0..3
  for (let n = 0; n <= 3; n++) {
    c.push({
      key: `ExportNamedDeclaration:function:${n}`,
      nodeType: 'ExportNamedDeclaration',
      variant: 10 + n,
      children: ['block'],
      weight: lookupWeight(`ExportNamedDeclaration:function:${n}`),
      isStatement: true,
    })
  }

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

  return ALL_CANDIDATES.filter((c) => {
    // Block depth limit: filter out block-containing statements when deep
    if (ctx.maxExprDepth < Infinity && ctx.blockDepth >= Math.floor(ctx.maxExprDepth / 3)) {
      if (c.isStatement && c.children.includes('block'))
        return false
    }

    // Expression depth limit: filter out non-leaf EXPRESSIONS when deep.
    // Statement candidates are NOT affected (they always start a fresh expr tree at depth 0).
    // Expression candidates with children are filtered → only leaves remain.
    // We have ~12 leaf expressions + ~200 total → always >= 12 unique after filter.
    // But we need 256! So also keep all STATEMENT candidates (non-expression-only context).
    // In expression-only context, we need >= 256 leaves — we DON'T have that.
    // So for expression-only at max depth: keep the non-leaf candidates but with tiny weight.
    // The weight scaling already handles this (10000x leaf bias).

    // Expression-only context: only expressions
    if (ctx.expressionOnly && c.isStatement)
      return false

    // Statement context: BOTH statements and expressions are available.
    // Expressions are implicitly wrapped in ExpressionStatement by the encoder.
    // The decoder identifies them from the ExpressionStatement's inner expression.

    // Top-level-only candidates: imports and exports are legal only at program root
    if (
      (c.nodeType === 'ImportDeclaration'
        || c.nodeType === 'ExportNamedDeclaration'
        || c.nodeType === 'ExportDefaultDeclaration')
      && ctx.scopeBucket !== 'top-level'
    ) {
      return false
    }

    // Context-gated entries
    if (c.nodeType === 'ReturnStatement' && !ctx.inFunction)
      return false
    if (c.nodeType === 'BreakStatement' && !ctx.inLoop)
      return false
    if (c.nodeType === 'ContinueStatement' && !ctx.inLoop)
      return false
    if (c.nodeType === 'AwaitExpression' && !ctx.inAsync)
      return false

    // Type-safety gates: filter candidates that would cause runtime errors
    if (c.nodeType === 'CallExpression' && !hasCallable)
      return false
    if (c.nodeType === 'OptionalCallExpression' && !hasCallable)
      return false
    if (c.nodeType === 'NewExpression' && !hasConstructable)
      return false
    if (c.nodeType === 'MemberExpression' && !hasMemberSafe)
      return false
    if (c.nodeType === 'TaggedTemplateExpression' && !hasCallable)
      return false
    if (c.nodeType === 'AssignmentExpression' && !hasAnyScope)
      return false
    if (c.nodeType === 'UpdateExpression' && !hasAnyScope)
      return false
    // ClassExpression with superClass — super must be constructable
    if (c.nodeType === 'ClassExpression' && c.variant === 1 && !hasConstructable)
      return false
    // SpreadElement — argument must be iterable, can't guarantee
    if (c.nodeType === 'SpreadElement')
      return false
    // 'in' operator (BINARY_OPS index 15) — RHS must be object, can't guarantee
    if (c.nodeType === 'BinaryExpression' && c.variant === 15)
      return false
    // 'delete' operator (UNARY_OPS index 6) — 'delete ident' is illegal in strict mode
    if (c.nodeType === 'UnaryExpression' && c.variant === 6)
      return false
    // BigIntLiteral — mixed BigInt/Number operations throw TypeError
    if (c.nodeType === 'BigIntLiteral')
      return false

    return true
  }).map((c) => {
    let w = lookupWeight(c.key, ctx.scopeBucket)

    // Dynamic weight: Identifier gets heavier with more scope entries
    if (c.nodeType === 'Identifier' && ctx.typedScope.length > 0) {
      w += ctx.typedScope.length * 0.5
    }

    // Bigram transition weight: replace unigram with transition weight if available
    if (ctx.prevStmtKey && !ctx.expressionOnly) {
      const bk = bigramKey(c.key, c.isStatement)
      const tw = lookupTransitionWeight(ctx.prevStmtKey, bk, ctx.scopeBucket)
      if (tw !== null) {
        w = tw
      }
    }

    // Depth-based weight scaling for expressions
    if (ctx.exprDepth > 0 && ctx.maxExprDepth < Infinity) {
      const depthRatio = ctx.exprDepth / ctx.maxExprDepth
      if (c.children.length === 0) {
        w *= 10 ** (depthRatio * 4)
      }
      else {
        w *= 0.1 ** (depthRatio * 4)
      }
    }

    return w !== c.weight ? { ...c, weight: w } : c
  })
}

/**
 * Build a bijective table from weighted candidates using hash as seed.
 * Size is 2^bitWidth(uniqueCount) — exactly matching the bits read/written.
 * Each slot maps to a UNIQUE candidate key. No duplicates, no padding.
 */
export function buildTable(candidates: Candidate[], hash: number): Candidate[] {
  if (candidates.length === 0)
    throw new Error('No candidates for context')

  // Deterministic PRNG
  let s = hash | 0
  function rng(): number {
    s = s + 0x6D2B79F5 | 0
    let z = Math.imul(s ^ s >>> 15, 1 | s)
    z = z + Math.imul(z ^ z >>> 7, 61 | z) ^ z
    return ((z ^ z >>> 14) >>> 0)
  }

  // Deduplicate candidates by key, keeping the highest weight per key
  const byKey = new Map<string, Candidate>()
  for (const c of candidates) {
    const existing = byKey.get(c.key)
    if (!existing || c.weight > existing.weight)
      byKey.set(c.key, c)
  }
  const unique = [...byKey.values()]

  // Table size = 2^floor(log2(uniqueCount)), guaranteed <= unique.length
  const bits = bitWidth(unique.length)
  const size = 1 << bits

  // Weight-biased selection: sort by (weight * random), take first `size`
  const scored = unique.map(c => ({ c, score: c.weight * (rng() % 1000 + 1) }))
  scored.sort((a, b) => b.score - a.score)

  const table: Candidate[] = scored.slice(0, size).map(s => s.c)

  // Fisher-Yates shuffle to distribute entries across the index range
  for (let i = table.length - 1; i > 0; i--) {
    const j = rng() % (i + 1)
    const tmp = table[i]
    table[i] = table[j]
    table[j] = tmp
  }

  return table
}

/** Build a reverse lookup: candidate key → index value. */
export function buildReverseTable(table: Candidate[]): Map<string, number> {
  const rev = new Map<string, number>()
  for (let i = 0; i < table.length; i++) {
    const key = table[i].key
    if (!rev.has(key))
      rev.set(key, i)
  }
  return rev
}
