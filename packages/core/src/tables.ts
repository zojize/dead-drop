/**
 * Bijective mapping tables: byte <-> AST node configuration.
 *
 * Two contexts: statement slots and expression slots.
 * Each of the 256 byte values maps to exactly one node config in each table.
 * Every config is RECOVERABLE from the parsed AST.
 */

// ─── Pools (scraped from real codebases via scripts/scrape-names.ts) ──────────

import scrapedNames from './scraped-names.json'

/** 76 numeric values scraped from minified React/Vue/Lodash/Three.js */
const NUMERIC_POOL: readonly number[] = scrapedNames.numbers.slice(0, 76)

/** 64 identifier names scraped from minified codebases */
const IDENT_POOL: readonly string[] = scrapedNames.identifiers
  .filter((n: string) => !n.startsWith('__'))
  .slice(0, 64)

/** 32 string literals scraped from minified codebases */
const STRING_POOL: readonly string[] = scrapedNames.strings.slice(0, 32)

/** 54 short var names for VariableDeclaration */
const VAR_DECL_NAME_POOL = [
  'tmp', 'val', 'ref', 'key', 'obj', 'arr', 'fn', 'cb',
  'acc', 'cur', 'prev', 'next', 'head', 'tail', 'root', 'leaf',
  'min', 'max', 'sum', 'avg', 'len', 'pos', 'idx', 'ptr',
  'src', 'dst', 'lhs', 'rhs', 'op', 'res', 'ret', 'err',
  'buf', 'str', 'num', 'bool', 'char', 'word', 'line', 'col',
  'row', 'tag', 'cls', 'sel', 'elm', 'doc', 'win', 'req',
  'env', 'ctx', 'cfg', 'opt', 'arg', 'msg',
] as const

/** 56 label names for LabeledStatement */
const LABEL_POOL = [
  'top', 'outer', 'inner', 'loop', 'next', 'retry', 'step', 'phase',
  'begin', 'end', 'init', 'main', 'run', 'exec', 'start', 'stop',
  'skip', 'done', 'exit', 'bail', 'check', 'test', 'scan', 'read',
  'write', 'send', 'recv', 'wait', 'poll', 'tick', 'mark', 'pass',
  'fail', 'warn', 'log', 'emit', 'fire', 'call', 'trap', 'hook',
  'push', 'pull', 'load', 'save', 'open', 'shut', 'lock', 'free',
  'get', 'set', 'put', 'del', 'add', 'sub', 'mul', 'div',
] as const

/** 6 catch clause param names */
const CATCH_PARAM_POOL = ['err', 'error', 'ex', 'e', 'caught', 'fault'] as const

// ─── Operator Pools ───────────────────────────────────────────────────────────

export const BINARY_OP_POOL = [
  '+', '-', '*', '/', '%', '|', '&', '^',
  '<<', '>>', '>>>', '==', '!=', '<', '>', 'in',
] as const

export const UNARY_OP_POOL = [
  '-', '+', '~', '!', 'typeof', 'void', 'delete',
] as const

export const ASSIGN_OP_POOL = [
  '=', '+=', '-=', '*=', '/=', '%=', '|=', '&=',
  '^=', '<<=', '>>=', '>>>=', '**=', '??=', '||=', '&&=',
] as const

export const VAR_KIND_POOL = ['var', 'let', 'const'] as const

/** 8 property names for non-computed MemberExpression */
const MEMBER_PROP_POOL = ['log', 'map', 'push', 'keys', 'call', 'bind', 'sort', 'from'] as const

/** Fixed LHS for AssignmentExpression (must NOT be in IDENT_POOL) */
export const ASSIGN_LHS_NAME = '_lval'

import type { Pools } from './pools'

export const DEFAULT_POOLS: Pools = {
  identifiers: IDENT_POOL,
  strings: STRING_POOL,
  numbers: NUMERIC_POOL,
  varNames: VAR_DECL_NAME_POOL,
  labels: LABEL_POOL,
  catchParams: CATCH_PARAM_POOL,
  memberProps: MEMBER_PROP_POOL,
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ChildKind = 'expr' | 'stmt' | 'block'

interface NodeConfig {
  nodeType: string
  variant: number
  children: Array<{ kind: ChildKind }>
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATEMENT TABLE (256 entries)
//
// Byte       | Node Type            | Count | Variant
// -----------|----------------------|-------|--------
// 0x00       | ExpressionStatement  | 1     | -
// 0x01       | IfStatement:else     | 1     | 0 (has alternate)
// 0x02       | IfStatement:no-else  | 1     | 1 (no alternate)
// 0x03       | WhileStatement       | 1     | -
// 0x04-0x0B  | ForStatement         | 8     | bits: init|test|update present
// 0x0C       | DoWhileStatement     | 1     | -
// 0x0D       | ReturnStatement      | 1     | -
// 0x0E       | ThrowStatement       | 1     | -
// 0x0F       | BlockStatement       | 1     | -
// 0x10       | EmptyStatement       | 1     | -
// 0x11       | DebuggerStatement    | 1     | -
// 0x12-0x17  | TryStatement         | 6     | catch param name
// 0x18-0x27  | SwitchStatement      | 16    | case count 0-15
// 0x28-0x3F  | LabeledStatement     | 24    | label name 0-23
// 0x40-0x5F  | VariableDeclaration  | 32    | kind × name (0-31)
// 0x60-0x7F  | LabeledStatement     | 32    | label name 24-55
// 0x80-0xFF  | VariableDeclaration  | 128   | kind × name (32-159)
// ═══════════════════════════════════════════════════════════════════════════════

export const STMT_TABLE: NodeConfig[] = new Array(256)

STMT_TABLE[0x00] = { nodeType: 'ExpressionStatement', variant: 0, children: [{ kind: 'expr' }] }
STMT_TABLE[0x01] = { nodeType: 'IfStatement', variant: 0, children: [{ kind: 'expr' }, { kind: 'block' }, { kind: 'block' }] }
STMT_TABLE[0x02] = { nodeType: 'IfStatement', variant: 1, children: [{ kind: 'expr' }, { kind: 'block' }] }
STMT_TABLE[0x03] = { nodeType: 'WhileStatement', variant: 0, children: [{ kind: 'expr' }, { kind: 'stmt' }] }

for (let b = 0x04; b <= 0x0B; b++) {
  STMT_TABLE[b] = { nodeType: 'ForStatement', variant: b - 0x04, children: [] }
}

STMT_TABLE[0x0C] = { nodeType: 'DoWhileStatement', variant: 0, children: [{ kind: 'expr' }, { kind: 'stmt' }] }
STMT_TABLE[0x0D] = { nodeType: 'ReturnStatement', variant: 0, children: [{ kind: 'expr' }] }
STMT_TABLE[0x0E] = { nodeType: 'ThrowStatement', variant: 0, children: [{ kind: 'expr' }] }
STMT_TABLE[0x0F] = { nodeType: 'BlockStatement', variant: 0, children: [{ kind: 'block' }] }
STMT_TABLE[0x10] = { nodeType: 'EmptyStatement', variant: 0, children: [] }
STMT_TABLE[0x11] = { nodeType: 'DebuggerStatement', variant: 0, children: [] }

for (let b = 0x12; b <= 0x17; b++) {
  STMT_TABLE[b] = { nodeType: 'TryStatement', variant: b - 0x12, children: [{ kind: 'block' }, { kind: 'block' }] }
}

for (let b = 0x18; b <= 0x27; b++) {
  STMT_TABLE[b] = { nodeType: 'SwitchStatement', variant: b - 0x18, children: [] }
}

for (let b = 0x28; b <= 0x3F; b++) {
  STMT_TABLE[b] = { nodeType: 'LabeledStatement', variant: b - 0x28, children: [{ kind: 'stmt' }] }
}

for (let b = 0x40; b <= 0x5F; b++) {
  STMT_TABLE[b] = { nodeType: 'VariableDeclaration', variant: b - 0x40, children: [{ kind: 'expr' }] }
}

for (let b = 0x60; b <= 0x7F; b++) {
  STMT_TABLE[b] = { nodeType: 'LabeledStatement', variant: (b - 0x60) + 24, children: [{ kind: 'stmt' }] }
}

for (let b = 0x80; b <= 0xFF; b++) {
  STMT_TABLE[b] = { nodeType: 'VariableDeclaration', variant: (b - 0x80) + 32, children: [{ kind: 'expr' }] }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPRESSION TABLE (256 entries)
//
// Byte Range  | Node Type              | Count | Variant stored in
// ------------|------------------------|-------|-------------------
// 0x00-0x4B   | NumericLiteral         | 76    | NUMERIC_POOL index
// 0x4C-0x8B   | Identifier             | 64    | IDENT_POOL index
// 0x8C-0x9B   | BinaryExpression       | 16    | operator
// 0x9C-0xA2   | UnaryExpression        | 7     | operator
// 0xA3        | ConditionalExpression  | 1     | -
// 0xA4-0xB3   | CallExpression         | 16    | arg count
// 0xB4-0xBB   | MemberExpression:nc    | 8     | property name
// 0xBC        | MemberExpression:c     | 1     | computed
// 0xBD-0xDC   | StringLiteral          | 32    | STRING_POOL index
// 0xDD-0xEC   | AssignmentExpression   | 16    | operator
// 0xED-0xF4   | ArrayExpression        | 8     | element count
// 0xF5-0xFC   | ObjectExpression       | 8     | property count
// 0xFD        | BooleanLiteral:true    | 1     | value
// 0xFE        | BooleanLiteral:false   | 1     | value
// 0xFF        | NullLiteral            | 1     | -
// ═══════════════════════════════════════════════════════════════════════════════

export const EXPR_TABLE: NodeConfig[] = new Array(256)

for (let b = 0x00; b <= 0x4B; b++) {
  EXPR_TABLE[b] = { nodeType: 'NumericLiteral', variant: b, children: [] }
}

for (let b = 0x4C; b <= 0x8B; b++) {
  EXPR_TABLE[b] = { nodeType: 'Identifier', variant: b - 0x4C, children: [] }
}

for (let b = 0x8C; b <= 0x9B; b++) {
  EXPR_TABLE[b] = { nodeType: 'BinaryExpression', variant: b - 0x8C, children: [{ kind: 'expr' }, { kind: 'expr' }] }
}

for (let b = 0x9C; b <= 0xA2; b++) {
  EXPR_TABLE[b] = { nodeType: 'UnaryExpression', variant: b - 0x9C, children: [{ kind: 'expr' }] }
}

EXPR_TABLE[0xA3] = { nodeType: 'ConditionalExpression', variant: 0, children: [{ kind: 'expr' }, { kind: 'expr' }, { kind: 'expr' }] }

for (let b = 0xA4; b <= 0xB3; b++) {
  EXPR_TABLE[b] = { nodeType: 'CallExpression', variant: b - 0xA4, children: [] }
}

for (let b = 0xB4; b <= 0xBB; b++) {
  EXPR_TABLE[b] = { nodeType: 'MemberExpression', variant: b - 0xB4, children: [{ kind: 'expr' }] }
}

EXPR_TABLE[0xBC] = { nodeType: 'MemberExpression', variant: 8, children: [{ kind: 'expr' }, { kind: 'expr' }] }

for (let b = 0xBD; b <= 0xDC; b++) {
  EXPR_TABLE[b] = { nodeType: 'StringLiteral', variant: b - 0xBD, children: [] }
}

for (let b = 0xDD; b <= 0xEC; b++) {
  EXPR_TABLE[b] = { nodeType: 'AssignmentExpression', variant: b - 0xDD, children: [{ kind: 'expr' }] }
}

for (let b = 0xED; b <= 0xF4; b++) {
  EXPR_TABLE[b] = { nodeType: 'ArrayExpression', variant: b - 0xED, children: [] }
}

for (let b = 0xF5; b <= 0xFC; b++) {
  EXPR_TABLE[b] = { nodeType: 'ObjectExpression', variant: b - 0xF5, children: [] }
}

EXPR_TABLE[0xFD] = { nodeType: 'BooleanLiteral', variant: 1, children: [] }
EXPR_TABLE[0xFE] = { nodeType: 'BooleanLiteral', variant: 0, children: [] }
EXPR_TABLE[0xFF] = { nodeType: 'NullLiteral', variant: 0, children: [] }

// ─── Reverse Lookup ───────────────────────────────────────────────────────────

export function exprNodeKey(nodeType: string, variant: number): string {
  return `${nodeType}:${variant}`
}

export function stmtNodeKey(nodeType: string, variant: number): string {
  return `${nodeType}:${variant}`
}

export const REVERSE_EXPR_TABLE = new Map<string, number>()
for (let b = 0; b < 256; b++) {
  const cfg = EXPR_TABLE[b]
  REVERSE_EXPR_TABLE.set(exprNodeKey(cfg.nodeType, cfg.variant), b)
}

export const REVERSE_STMT_TABLE = new Map<string, number>()
for (let b = 0; b < 256; b++) {
  const cfg = STMT_TABLE[b]
  REVERSE_STMT_TABLE.set(stmtNodeKey(cfg.nodeType, cfg.variant), b)
}
