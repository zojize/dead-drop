/**
 * Bijective mapping tables: byte <-> AST node configuration.
 *
 * Two contexts: statement slots and expression slots.
 * Each of the 256 byte values maps to exactly one node config in each table.
 * Every config is RECOVERABLE from the parsed AST purely from structure.
 *
 * EXPRESSION TABLE: fully structural — the decoder recovers every byte from
 * node types, operators, child counts, boolean flags, and regex flag combos.
 * Literal values (identifier names, string values, numbers) are cosmetic.
 *
 * NO STATEMENT TABLE: all data is encoded through expressions only.
 * The program body is a sequence of ExpressionStatements.
 */

// ─── Operator Pools ───────────────────────────────────────────────────────────

export const BINARY_OP_POOL = [
  '+', '-', '*', '/', '%', '|', '&', '^',
  '<<', '>>', '>>>', '==', '!=', '<', '>', 'in',
] as const

export const LOGICAL_OP_POOL = ['&&', '||', '??'] as const

export const UNARY_OP_POOL = [
  '-', '+', '~', '!', 'typeof', 'void', 'delete',
] as const

export const UPDATE_OP_POOL = ['++', '--'] as const

export const ASSIGN_OP_POOL = [
  '=', '+=', '-=', '*=', '/=', '%=', '|=', '&=',
  '^=', '<<=', '>>=', '>>>=', '**=', '??=', '||=', '&&=',
] as const

/**
 * The 6 RegExp flags. Each flag is either present or absent,
 * giving 2^6 = 64 structural variants for RegExpLiteral.
 */
export const REGEXP_FLAGS = ['d', 'g', 'i', 'm', 's', 'u'] as const

/** Fixed LHS for AssignmentExpression (must NOT collide with cosmetic names) */
export const ASSIGN_LHS_NAME = '_lval'

// ─── Types ────────────────────────────────────────────────────────────────────

interface NodeConfig {
  nodeType: string
  variant: number
  children: Array<{ kind: 'expr' }>
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPRESSION TABLE (256 entries) — ALL structural
//
// Byte Range  | Node Type                     | Count | Variant recovered from
// ------------|-------------------------------|-------|----------------------
// 0x00        | NumericLiteral                | 1     | just node type
// 0x01        | StringLiteral                 | 1     | just node type
// 0x02        | Identifier                    | 1     | just node type
// 0x03        | BooleanLiteral:true           | 1     | node.value
// 0x04        | BooleanLiteral:false          | 1     | node.value
// 0x05        | NullLiteral                   | 1     | just node type
// 0x06        | BigIntLiteral                 | 1     | just node type
// 0x07        | ThisExpression                | 1     | just node type
// 0x08-0x47   | RegExpLiteral                 | 64    | flags combo (6 flags -> 2^6)
// 0x48-0x57   | BinaryExpression              | 16    | operator
// 0x58-0x5A   | LogicalExpression             | 3     | operator (&&, ||, ??)
// 0x5B-0x6A   | AssignmentExpression          | 16    | operator
// 0x6B-0x71   | UnaryExpression               | 7     | operator
// 0x72-0x75   | UpdateExpression              | 4     | operator x prefix
// 0x76        | ConditionalExpression         | 1     | just type
// 0x77-0x89   | CallExpression                | 19    | arg count 0-18
// 0x8A-0x99   | NewExpression                 | 16    | arg count 0-15
// 0x9A        | MemberExpression:computed     | 1     | node.computed=true
// 0x9B        | MemberExpression:non-computed | 1     | node.computed=false
// 0x9C        | OptionalMemberExpression:comp | 1     | node.computed=true
// 0x9D        | OptionalMemberExpression:nc   | 1     | node.computed=false
// 0x9E-0xAD   | ArrayExpression               | 16    | element count 0-15
// 0xAE-0xBD   | ObjectExpression              | 16    | prop count 0-15
// 0xBE-0xCC   | SequenceExpression            | 15    | element count 2-16
// 0xCD-0xD4   | TemplateLiteral               | 8     | expression count 0-7
// 0xD5-0xDC   | TaggedTemplateExpression      | 8     | expression count 0-7
// 0xDD-0xEC   | ArrowFunctionExpression       | 16    | param count 0-15
// 0xED-0xFC   | FunctionExpression            | 16    | param count 0-15
// 0xFD        | SpreadElement                 | 1     | just type
// 0xFE        | ClassExpression:no-super      | 1     | superClass===null
// 0xFF        | ClassExpression:super         | 1     | superClass!==null
// ═══════════════════════════════════════════════════════════════════════════════

export const EXPR_TABLE: NodeConfig[] = new Array(256)

// 0x00-0x07: simple leaves
EXPR_TABLE[0x00] = { nodeType: 'NumericLiteral', variant: 0, children: [] }
EXPR_TABLE[0x01] = { nodeType: 'StringLiteral', variant: 0, children: [] }
EXPR_TABLE[0x02] = { nodeType: 'Identifier', variant: 0, children: [] }
EXPR_TABLE[0x03] = { nodeType: 'BooleanLiteral', variant: 1, children: [] }   // true
EXPR_TABLE[0x04] = { nodeType: 'BooleanLiteral', variant: 0, children: [] }   // false
EXPR_TABLE[0x05] = { nodeType: 'NullLiteral', variant: 0, children: [] }
EXPR_TABLE[0x06] = { nodeType: 'BigIntLiteral', variant: 0, children: [] }
EXPR_TABLE[0x07] = { nodeType: 'ThisExpression', variant: 0, children: [] }

// 0x08-0x47: RegExpLiteral — 64 entries, variant = flags bitmask
for (let b = 0x08; b <= 0x47; b++) {
  EXPR_TABLE[b] = { nodeType: 'RegExpLiteral', variant: b - 0x08, children: [] }
}

// 0x48-0x57: BinaryExpression — 16 operators
for (let b = 0x48; b <= 0x57; b++) {
  EXPR_TABLE[b] = { nodeType: 'BinaryExpression', variant: b - 0x48, children: [{ kind: 'expr' }, { kind: 'expr' }] }
}

// 0x58-0x5A: LogicalExpression — 3 operators
for (let b = 0x58; b <= 0x5A; b++) {
  EXPR_TABLE[b] = { nodeType: 'LogicalExpression', variant: b - 0x58, children: [{ kind: 'expr' }, { kind: 'expr' }] }
}

// 0x5B-0x6A: AssignmentExpression — 16 operators
for (let b = 0x5B; b <= 0x6A; b++) {
  EXPR_TABLE[b] = { nodeType: 'AssignmentExpression', variant: b - 0x5B, children: [{ kind: 'expr' }] }
}

// 0x6B-0x71: UnaryExpression — 7 operators
for (let b = 0x6B; b <= 0x71; b++) {
  EXPR_TABLE[b] = { nodeType: 'UnaryExpression', variant: b - 0x6B, children: [{ kind: 'expr' }] }
}

// 0x72-0x75: UpdateExpression — 4 variants (operator x prefix)
// variant 0: ++, prefix=true
// variant 1: ++, prefix=false
// variant 2: --, prefix=true
// variant 3: --, prefix=false
for (let b = 0x72; b <= 0x75; b++) {
  EXPR_TABLE[b] = { nodeType: 'UpdateExpression', variant: b - 0x72, children: [{ kind: 'expr' }] }
}

// 0x76: ConditionalExpression
EXPR_TABLE[0x76] = { nodeType: 'ConditionalExpression', variant: 0, children: [{ kind: 'expr' }, { kind: 'expr' }, { kind: 'expr' }] }

// 0x77-0x89: CallExpression — 19 entries (arg count 0-18)
for (let b = 0x77; b <= 0x89; b++) {
  EXPR_TABLE[b] = { nodeType: 'CallExpression', variant: b - 0x77, children: [] }
}

// 0x8A-0x99: NewExpression — 16 entries (arg count 0-15)
for (let b = 0x8A; b <= 0x99; b++) {
  EXPR_TABLE[b] = { nodeType: 'NewExpression', variant: b - 0x8A, children: [] }
}

// 0x9A-0x9B: MemberExpression
EXPR_TABLE[0x9A] = { nodeType: 'MemberExpression', variant: 1, children: [{ kind: 'expr' }, { kind: 'expr' }] }  // computed: obj[prop]
EXPR_TABLE[0x9B] = { nodeType: 'MemberExpression', variant: 0, children: [{ kind: 'expr' }] }                    // non-computed: obj.prop (1 data child)

// 0x9C-0x9D: OptionalMemberExpression
EXPR_TABLE[0x9C] = { nodeType: 'OptionalMemberExpression', variant: 1, children: [{ kind: 'expr' }, { kind: 'expr' }] }  // computed: obj?.[prop]
EXPR_TABLE[0x9D] = { nodeType: 'OptionalMemberExpression', variant: 0, children: [{ kind: 'expr' }] }                    // non-computed: obj?.prop (1 data child)

// 0x9E-0xAD: ArrayExpression — 16 entries (element count 0-15)
for (let b = 0x9E; b <= 0xAD; b++) {
  EXPR_TABLE[b] = { nodeType: 'ArrayExpression', variant: b - 0x9E, children: [] }
}

// 0xAE-0xBD: ObjectExpression — 16 entries (prop count 0-15)
for (let b = 0xAE; b <= 0xBD; b++) {
  EXPR_TABLE[b] = { nodeType: 'ObjectExpression', variant: b - 0xAE, children: [] }
}

// 0xBE-0xCC: SequenceExpression — 15 entries (element count 2-16)
for (let b = 0xBE; b <= 0xCC; b++) {
  EXPR_TABLE[b] = { nodeType: 'SequenceExpression', variant: b - 0xBE, children: [] }
}

// 0xCD-0xD4: TemplateLiteral — 8 entries (expression count 0-7)
for (let b = 0xCD; b <= 0xD4; b++) {
  EXPR_TABLE[b] = { nodeType: 'TemplateLiteral', variant: b - 0xCD, children: [] }
}

// 0xD5-0xDC: TaggedTemplateExpression — 8 entries (expression count 0-7)
for (let b = 0xD5; b <= 0xDC; b++) {
  EXPR_TABLE[b] = { nodeType: 'TaggedTemplateExpression', variant: b - 0xD5, children: [] }
}

// 0xDD-0xEC: ArrowFunctionExpression — 16 entries (param count 0-15)
for (let b = 0xDD; b <= 0xEC; b++) {
  EXPR_TABLE[b] = { nodeType: 'ArrowFunctionExpression', variant: b - 0xDD, children: [] }
}

// 0xED-0xFC: FunctionExpression — 16 entries (param count 0-15)
for (let b = 0xED; b <= 0xFC; b++) {
  EXPR_TABLE[b] = { nodeType: 'FunctionExpression', variant: b - 0xED, children: [] }
}

// 0xFD: SpreadElement
EXPR_TABLE[0xFD] = { nodeType: 'SpreadElement', variant: 0, children: [{ kind: 'expr' }] }

// 0xFE-0xFF: ClassExpression
EXPR_TABLE[0xFE] = { nodeType: 'ClassExpression', variant: 0, children: [] }   // no super
EXPR_TABLE[0xFF] = { nodeType: 'ClassExpression', variant: 1, children: [] }   // has super

// ─── Reverse Lookup ───────────────────────────────────────────────────────────

export function exprNodeKey(nodeType: string, variant: number): string {
  return `${nodeType}:${variant}`
}

export const REVERSE_EXPR_TABLE = new Map<string, number>()
for (let b = 0; b < 256; b++) {
  const cfg = EXPR_TABLE[b]
  REVERSE_EXPR_TABLE.set(exprNodeKey(cfg.nodeType, cfg.variant), b)
}
