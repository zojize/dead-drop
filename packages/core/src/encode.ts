import * as t from '@babel/types'
import { generateCompact } from './codegen'
import {
  EXPR_TABLE,
  STMT_TABLE,
  BINARY_OP_POOL,
  LOGICAL_OP_POOL,
  UNARY_OP_POOL,
  UPDATE_OP_POOL,
  ASSIGN_OP_POOL,
  VAR_KIND_POOL,
  REGEXP_FLAGS,
  ASSIGN_LHS_NAME,
  DEFAULT_STMT_POOLS,
} from './tables'
import { type StatementPools, SCOPE_SUFFIX_SEP } from './pools'

function createPadRng(seed: number) {
  let s = seed | 0
  return () => {
    s = s + 0x6D2B79F5 | 0
    let z = Math.imul(s ^ s >>> 15, 1 | s)
    z = z + Math.imul(z ^ z >>> 7, 61 | z) ^ z
    return ((z ^ z >>> 14) >>> 0)
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EncodeOptions {
  /** Seed for the PRNG that generates padding expressions. Defaults to message length. */
  seed?: number
}

// ─── Scope tracking ─────────────────────────────────────────────────────────

class ScopeStack {
  private allDecls = new Set<string>()
  private labelScopes: Set<string>[] = [new Set()]

  push() { this.labelScopes.push(new Set()) }
  pop() { this.labelScopes.pop() }

  hasDeclInScope(name: string): boolean {
    return this.allDecls.has(name)
  }

  private declList: string[] = []

  declare(name: string) {
    this.allDecls.add(name)
    this.declList.push(name)
  }

  pickDeclared(rand: number): string | null {
    return this.declList.length > 0 ? this.declList[rand % this.declList.length] : null
  }

  hasLabel(name: string): boolean {
    for (let i = this.labelScopes.length - 1; i >= 0; i--) {
      if (this.labelScopes[i].has(name)) return true
    }
    return false
  }

  declareLabel(name: string) {
    this.labelScopes[this.labelScopes.length - 1].add(name)
  }
}

// ─── Cosmetic value generators ──────────────────────────────────────────────

/** Names used for cosmetic identifier/variable references in expressions */
const COSMETIC_IDENTS = [
  'x', 'y', 'z', 'w', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h',
  'i', 'j', 'k', 'n', 'm', 'o', 'val', 'tmp', 'res', 'idx', 'len', 'sum',
]

// ─── Iterative AST builder ──────────────────────────────────────────────────

type Slot<T> = { value: T }
type WorkItem =
  | { kind: 'expr'; slot: Slot<t.Expression> }
  | { kind: 'stmt'; slot: Slot<t.Statement> }
  | { kind: 'block'; slot: Slot<t.Statement[]> }
  | { kind: 'assemble'; fn: () => void }
  | { kind: 'scope-push' }
  | { kind: 'scope-pop' }

export function encode(message: Uint8Array, options?: EncodeOptions): string {
  const opts = options ?? {}
  const pools: StatementPools = DEFAULT_STMT_POOLS

  const length = message.length
  const prefixed = new Uint8Array(4 + length)
  prefixed[0] = (length >>> 24) & 0xFF
  prefixed[1] = (length >>> 16) & 0xFF
  prefixed[2] = (length >>> 8) & 0xFF
  prefixed[3] = length & 0xFF
  prefixed.set(message, 4)

  let cursor = 0
  const rng = createPadRng(opts.seed ?? length)
  const isPad = () => cursor >= prefixed.length
  const scope = new ScopeStack()

  function readByte(): number { return prefixed[cursor++] }

  /** Generate a cosmetic random identifier name */
  function cosmeticIdent(): string {
    return COSMETIC_IDENTS[rng() % COSMETIC_IDENTS.length]
  }

  /** Generate a cosmetic random number */
  function cosmeticNumber(): number {
    return rng() % 1000
  }

  /** Generate a cosmetic random string */
  function cosmeticString(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz'
    const len = 1 + (rng() % 4)
    let s = ''
    for (let i = 0; i < len; i++) s += chars[rng() % chars.length]
    return s
  }

  /**
   * Convert a 6-bit flags bitmask to a RegExp flags string.
   * Bit 0 = 'd', 1 = 'g', 2 = 'i', 3 = 'm', 4 = 's', 5 = 'u'
   */
  function flagsFromBitmask(bitmask: number): string {
    let flags = ''
    for (let i = 0; i < REGEXP_FLAGS.length; i++) {
      if (bitmask & (1 << i)) flags += REGEXP_FLAGS[i]
    }
    return flags
  }

  /**
   * Generate a unique var name. Appends $N suffix on conflict.
   */
  function uniqueVarName(baseName: string, _kind: string): string {
    if (!scope.hasDeclInScope(baseName)) {
      scope.declare(baseName)
      return baseName
    }
    for (let i = 1; i <= 100; i++) {
      const suffixed = `${baseName}${SCOPE_SUFFIX_SEP}${i}`
      if (!scope.hasDeclInScope(suffixed)) {
        scope.declare(suffixed)
        return suffixed
      }
    }
    return baseName
  }

  /** Generate a unique label name. Appends $N suffix on conflict. */
  function uniqueLabel(baseName: string): string {
    if (!scope.hasLabel(baseName)) {
      scope.declareLabel(baseName)
      return baseName
    }
    for (let i = 1; i <= 100; i++) {
      const suffixed = `${baseName}${SCOPE_SUFFIX_SEP}${i}`
      if (!scope.hasLabel(suffixed)) {
        scope.declareLabel(suffixed)
        return suffixed
      }
    }
    return baseName
  }

  function padLeafExpr(): t.Expression {
    const r = rng()
    if (r % 3 === 0) {
      const decl = scope.pickDeclared(rng())
      if (decl) return t.identifier(decl)
    }
    switch (r % 5) {
      case 0: return t.numericLiteral(cosmeticNumber())
      case 1: return t.identifier(cosmeticIdent())
      case 2: return t.stringLiteral(cosmeticString())
      case 3: return t.booleanLiteral(rng() % 2 === 0)
      default: return t.nullLiteral()
    }
  }

  /** Try to make a leaf expression for the given byte. Returns null if not a leaf. */
  function makeLeafExpr(byte: number): t.Expression | null {
    const config = EXPR_TABLE[byte]
    switch (config.nodeType) {
      case 'NumericLiteral': return t.numericLiteral(cosmeticNumber())
      case 'StringLiteral': return t.stringLiteral(cosmeticString())
      case 'Identifier': return t.identifier(cosmeticIdent())
      case 'BooleanLiteral': return t.booleanLiteral(config.variant === 1)
      case 'NullLiteral': return t.nullLiteral()
      case 'BigIntLiteral': return t.bigIntLiteral(String(rng() % 100))
      case 'ThisExpression': return t.thisExpression()
      case 'RegExpLiteral': {
        const flags = flagsFromBitmask(config.variant)
        // Use a simple cosmetic pattern
        const patterns = ['x', 'a', '\\d+', '\\w+', '.', 'ok', 'hi', 'ab']
        const pattern = patterns[rng() % patterns.length]
        return t.regExpLiteral(pattern, flags)
      }
      default: return null
    }
  }

  const work: WorkItem[] = []

  function slot<T>(initial?: T): Slot<T> { return { value: initial! } }
  function pushExpr(s: Slot<t.Expression>) { work.push({ kind: 'expr', slot: s }) }
  function pushStmt(s: Slot<t.Statement>) { work.push({ kind: 'stmt', slot: s }) }
  function pushBlock(s: Slot<t.Statement[]>) { work.push({ kind: 'block', slot: s }) }
  function pushAssemble(fn: () => void) { work.push({ kind: 'assemble', fn }) }

  /** Generate cosmetic parameter names for arrow/function expressions */
  function genParamNames(count: number): string[] {
    const names: string[] = []
    const base = 'abcdefghijklmnop'
    for (let i = 0; i < count; i++) {
      names.push(i < base.length ? base[i] : `p${i}`)
    }
    return names
  }

  function scheduleExpr(s: Slot<t.Expression>): void {
    if (isPad()) { s.value = padLeafExpr(); return }
    const byte = readByte()
    const leaf = makeLeafExpr(byte)
    if (leaf) { s.value = leaf; return }

    const config = EXPR_TABLE[byte]
    switch (config.nodeType) {
      case 'BinaryExpression': {
        const l = slot<t.Expression>(), r = slot<t.Expression>()
        pushAssemble(() => { s.value = t.binaryExpression(BINARY_OP_POOL[config.variant] as any, l.value, r.value) })
        pushExpr(r); pushExpr(l)
        break
      }
      case 'LogicalExpression': {
        const l = slot<t.Expression>(), r = slot<t.Expression>()
        pushAssemble(() => { s.value = t.logicalExpression(LOGICAL_OP_POOL[config.variant] as any, l.value, r.value) })
        pushExpr(r); pushExpr(l)
        break
      }
      case 'UnaryExpression': {
        const arg = slot<t.Expression>()
        pushAssemble(() => { s.value = t.unaryExpression(UNARY_OP_POOL[config.variant] as any, arg.value, true) })
        pushExpr(arg)
        break
      }
      case 'UpdateExpression': {
        // variant: 0=++prefix, 1=++postfix, 2=--prefix, 3=--postfix
        const opIdx = config.variant >> 1   // 0 or 1
        const prefix = (config.variant & 1) === 0
        const arg = slot<t.Expression>()
        pushAssemble(() => {
          // Build the update expression manually to avoid babel validation
          // (babel rejects non-LValue arguments, but we need arbitrary expressions)
          s.value = {
            type: 'UpdateExpression',
            operator: UPDATE_OP_POOL[opIdx],
            argument: arg.value,
            prefix,
          } as any as t.UpdateExpression
        })
        pushExpr(arg)
        break
      }
      case 'ConditionalExpression': {
        const test = slot<t.Expression>(), cons = slot<t.Expression>(), alt = slot<t.Expression>()
        pushAssemble(() => { s.value = t.conditionalExpression(test.value, cons.value, alt.value) })
        pushExpr(alt); pushExpr(cons); pushExpr(test)
        break
      }
      case 'CallExpression': {
        const callee = slot<t.Expression>()
        const argSlots = Array.from({ length: config.variant }, () => slot<t.Expression>())
        pushAssemble(() => { s.value = t.callExpression(callee.value, argSlots.map(a => a.value)) })
        for (let i = argSlots.length - 1; i >= 0; i--) pushExpr(argSlots[i])
        pushExpr(callee)
        break
      }
      case 'NewExpression': {
        const callee = slot<t.Expression>()
        const argSlots = Array.from({ length: config.variant }, () => slot<t.Expression>())
        pushAssemble(() => { s.value = t.newExpression(callee.value, argSlots.map(a => a.value)) })
        for (let i = argSlots.length - 1; i >= 0; i--) pushExpr(argSlots[i])
        pushExpr(callee)
        break
      }
      case 'MemberExpression': {
        if (config.variant === 1) {
          // computed: obj[prop] — 2 data children
          const obj = slot<t.Expression>(), prop = slot<t.Expression>()
          pushAssemble(() => { s.value = t.memberExpression(obj.value, prop.value, true) })
          pushExpr(prop); pushExpr(obj)
        } else {
          // non-computed: obj.prop — 1 data child (obj), property name is cosmetic
          const obj = slot<t.Expression>()
          pushAssemble(() => { s.value = t.memberExpression(obj.value, t.identifier(cosmeticIdent()), false) })
          pushExpr(obj)
        }
        break
      }
      case 'OptionalMemberExpression': {
        if (config.variant === 1) {
          // computed: obj?.[prop] — 2 data children
          const obj = slot<t.Expression>(), prop = slot<t.Expression>()
          pushAssemble(() => { s.value = t.optionalMemberExpression(obj.value, prop.value, true, true) })
          pushExpr(prop); pushExpr(obj)
        } else {
          // non-computed: obj?.prop — 1 data child (obj), property name is cosmetic
          const obj = slot<t.Expression>()
          pushAssemble(() => { s.value = t.optionalMemberExpression(obj.value, t.identifier(cosmeticIdent()), false, true) })
          pushExpr(obj)
        }
        break
      }
      case 'AssignmentExpression': {
        const rhs = slot<t.Expression>()
        pushAssemble(() => { s.value = t.assignmentExpression(ASSIGN_OP_POOL[config.variant] as any, t.identifier(ASSIGN_LHS_NAME), rhs.value) })
        pushExpr(rhs)
        break
      }
      case 'ArrayExpression': {
        const els = Array.from({ length: config.variant }, () => slot<t.Expression>())
        pushAssemble(() => { s.value = t.arrayExpression(els.map(e => e.value)) })
        for (let i = els.length - 1; i >= 0; i--) pushExpr(els[i])
        break
      }
      case 'ObjectExpression': {
        const pairs = Array.from({ length: config.variant }, () => ({ k: slot<t.Expression>(), v: slot<t.Expression>() }))
        pushAssemble(() => {
          s.value = t.objectExpression(pairs.map(p => {
            // Always use computed properties so both key and value are expression children
            return t.objectProperty(p.k.value, p.v.value, true)
          }))
        })
        for (let i = pairs.length - 1; i >= 0; i--) { pushExpr(pairs[i].v); pushExpr(pairs[i].k) }
        break
      }
      case 'SequenceExpression': {
        // variant = element count - 2 (min 2 elements)
        const count = config.variant + 2
        const els = Array.from({ length: count }, () => slot<t.Expression>())
        pushAssemble(() => { s.value = t.sequenceExpression(els.map(e => e.value)) })
        for (let i = els.length - 1; i >= 0; i--) pushExpr(els[i])
        break
      }
      case 'TemplateLiteral': {
        // variant = expression count (0-7)
        const exprCount = config.variant
        const exprSlots = Array.from({ length: exprCount }, () => slot<t.Expression>())
        pushAssemble(() => {
          // quasis always has exprCount + 1 elements
          const quasis = Array.from({ length: exprCount + 1 }, (_, i) =>
            t.templateElement({ raw: '', cooked: '' }, i === exprCount)
          )
          s.value = t.templateLiteral(quasis, exprSlots.map(e => e.value))
        })
        for (let i = exprSlots.length - 1; i >= 0; i--) pushExpr(exprSlots[i])
        break
      }
      case 'TaggedTemplateExpression': {
        // variant = expression count in the template (0-7)
        const exprCount = config.variant
        const tag = slot<t.Expression>()
        const exprSlots = Array.from({ length: exprCount }, () => slot<t.Expression>())
        pushAssemble(() => {
          const quasis = Array.from({ length: exprCount + 1 }, (_, i) =>
            t.templateElement({ raw: '', cooked: '' }, i === exprCount)
          )
          const tpl = t.templateLiteral(quasis, exprSlots.map(e => e.value))
          s.value = t.taggedTemplateExpression(tag.value, tpl)
        })
        for (let i = exprSlots.length - 1; i >= 0; i--) pushExpr(exprSlots[i])
        pushExpr(tag)
        break
      }
      case 'ArrowFunctionExpression': {
        // variant = param count (0-15)
        const paramCount = config.variant
        const body = slot<t.Expression>()
        pushAssemble(() => {
          const params = genParamNames(paramCount).map(n => t.identifier(n))
          s.value = t.arrowFunctionExpression(params, body.value)
        })
        pushExpr(body)
        break
      }
      case 'FunctionExpression': {
        // variant = param count (0-15)
        const paramCount = config.variant
        const body = slot<t.Expression>()
        pushAssemble(() => {
          const params = genParamNames(paramCount).map(n => t.identifier(n))
          // Wrap the body expression in a return statement inside a block
          const block = t.blockStatement([t.returnStatement(body.value)])
          s.value = t.functionExpression(null, params, block)
        })
        pushExpr(body)
        break
      }
      case 'SpreadElement': {
        const arg = slot<t.Expression>()
        pushAssemble(() => {
          // SpreadElement is not an Expression in babel types, but we wrap in array
          // Actually, SpreadElement gets used inside arrays/calls. We encode it as
          // an array with one spread: [...arg] which the decoder sees as SpreadElement
          // But wait — SpreadElement has a child expr. Let's just create it directly.
          // The codegen will handle outputting it.
          s.value = t.arrayExpression([t.spreadElement(arg.value)])
        })
        pushExpr(arg)
        break
      }
      case 'ClassExpression': {
        if (config.variant === 1) {
          // has super — but super is cosmetic, we just need the flag
          s.value = t.classExpression(null, t.identifier('Base'), t.classBody([]))
        } else {
          s.value = t.classExpression(null, null, t.classBody([]))
        }
        break
      }
      default:
        throw new Error(`Unknown expression type: ${config.nodeType}`)
    }
  }

  function scheduleStmt(s: Slot<t.Statement>): void {
    if (isPad()) { s.value = t.expressionStatement(padLeafExpr()); return }

    const config = STMT_TABLE[readByte()]
    switch (config.nodeType) {
      case 'ExpressionStatement': {
        const expr = slot<t.Expression>()
        pushAssemble(() => { s.value = t.expressionStatement(expr.value) })
        pushExpr(expr)
        break
      }
      case 'IfStatement': {
        const test = slot<t.Expression>(), cons = slot<t.Statement[]>()
        if (config.variant === 0) {
          const alt = slot<t.Statement[]>()
          pushAssemble(() => { s.value = t.ifStatement(test.value, t.blockStatement(cons.value), t.blockStatement(alt.value)) })
          work.push({ kind: 'scope-pop' }); pushBlock(alt); work.push({ kind: 'scope-push' })
          work.push({ kind: 'scope-pop' }); pushBlock(cons); work.push({ kind: 'scope-push' })
          pushExpr(test)
        } else {
          pushAssemble(() => { s.value = t.ifStatement(test.value, t.blockStatement(cons.value)) })
          work.push({ kind: 'scope-pop' }); pushBlock(cons); work.push({ kind: 'scope-push' })
          pushExpr(test)
        }
        break
      }
      case 'WhileStatement': {
        const test = slot<t.Expression>(), body = slot<t.Statement[]>()
        pushAssemble(() => { s.value = t.whileStatement(test.value, t.blockStatement(body.value)) })
        work.push({ kind: 'scope-pop' }); pushBlock(body); work.push({ kind: 'scope-push' })
        pushExpr(test)
        break
      }
      case 'ForStatement': {
        const hasInit = (config.variant & 1) !== 0, hasTest = (config.variant & 2) !== 0, hasUpdate = (config.variant & 4) !== 0
        const init = hasInit ? slot<t.Expression>() : null
        const test = hasTest ? slot<t.Expression>() : null
        const update = hasUpdate ? slot<t.Expression>() : null
        const body = slot<t.Statement[]>()
        pushAssemble(() => { s.value = t.forStatement(init?.value ?? null, test?.value ?? null, update?.value ?? null, t.blockStatement(body.value)) })
        work.push({ kind: 'scope-pop' }); pushBlock(body); work.push({ kind: 'scope-push' })
        if (update) pushExpr(update)
        if (test) pushExpr(test)
        if (init) pushExpr(init)
        break
      }
      case 'DoWhileStatement': {
        const test = slot<t.Expression>(), body = slot<t.Statement[]>()
        pushAssemble(() => { s.value = t.doWhileStatement(test.value, t.blockStatement(body.value)) })
        work.push({ kind: 'scope-pop' }); pushBlock(body); work.push({ kind: 'scope-push' })
        pushExpr(test)
        break
      }
      case 'ReturnStatement': {
        const arg = slot<t.Expression>()
        pushAssemble(() => { s.value = t.returnStatement(arg.value) })
        pushExpr(arg)
        break
      }
      case 'ThrowStatement': {
        const arg = slot<t.Expression>()
        pushAssemble(() => { s.value = t.throwStatement(arg.value) })
        pushExpr(arg)
        break
      }
      case 'BlockStatement': {
        const blk = slot<t.Statement[]>()
        pushAssemble(() => { s.value = t.blockStatement(blk.value) })
        work.push({ kind: 'scope-pop' }); pushBlock(blk); work.push({ kind: 'scope-push' })
        break
      }
      case 'EmptyStatement':
        s.value = t.emptyStatement()
        break
      case 'DebuggerStatement':
        s.value = t.debuggerStatement()
        break
      case 'TryStatement': {
        const tryBlk = slot<t.Statement[]>(), catchBlk = slot<t.Statement[]>()
        pushAssemble(() => {
          s.value = t.tryStatement(
            t.blockStatement(tryBlk.value),
            t.catchClause(t.identifier(pools.catchParams[config.variant]), t.blockStatement(catchBlk.value)),
          )
        })
        work.push({ kind: 'scope-pop' }); pushBlock(catchBlk); work.push({ kind: 'scope-push' })
        work.push({ kind: 'scope-pop' }); pushBlock(tryBlk); work.push({ kind: 'scope-push' })
        break
      }
      case 'SwitchStatement': {
        const disc = slot<t.Expression>()
        const cases = Array.from({ length: config.variant }, () => ({ test: slot<t.Expression>(), body: slot<t.Statement[]>() }))
        pushAssemble(() => {
          s.value = t.switchStatement(disc.value, cases.map(c => t.switchCase(c.test.value, c.body.value)))
        })
        for (let i = cases.length - 1; i >= 0; i--) { pushBlock(cases[i].body); pushExpr(cases[i].test) }
        pushExpr(disc)
        break
      }
      case 'LabeledStatement': {
        const name = uniqueLabel(pools.labels[config.variant])
        const body = slot<t.Statement[]>()
        pushAssemble(() => { s.value = t.labeledStatement(t.identifier(name), t.blockStatement(body.value)) })
        work.push({ kind: 'scope-pop' }); pushBlock(body); work.push({ kind: 'scope-push' })
        break
      }
      case 'VariableDeclaration': {
        const kindIndex = config.variant % 3, nameIndex = Math.floor(config.variant / 3)
        const kind = VAR_KIND_POOL[kindIndex] as 'var' | 'let' | 'const'
        const name = uniqueVarName(pools.varNames[nameIndex], kind)
        const init = slot<t.Expression>()
        pushAssemble(() => {
          s.value = t.variableDeclaration(kind, [
            t.variableDeclarator(t.identifier(name), init.value),
          ])
        })
        pushExpr(init)
        break
      }
      default:
        throw new Error(`Unknown statement type: ${config.nodeType}`)
    }
  }

  function scheduleBlock(s: Slot<t.Statement[]>): void {
    if (isPad()) { s.value = []; return }
    const count = readByte()
    const stmtSlots = Array.from({ length: count }, () => slot<t.Statement>())
    pushAssemble(() => { s.value = stmtSlots.map(ss => ss.value) })
    for (let i = stmtSlots.length - 1; i >= 0; i--) pushStmt(stmtSlots[i])
  }

  function drain(): void {
    while (work.length > 0) {
      const item = work.pop()!
      switch (item.kind) {
        case 'expr': scheduleExpr(item.slot); break
        case 'stmt': scheduleStmt(item.slot); break
        case 'block': scheduleBlock(item.slot); break
        case 'assemble': item.fn(); break
        case 'scope-push': scope.push(); break
        case 'scope-pop': scope.pop(); break
      }
    }
  }

  const body: t.Statement[] = []
  while (cursor < prefixed.length) {
    const s = slot<t.Statement>()
    scheduleStmt(s)
    drain()
    body.push(s.value)
  }

  return generateCompact(t.program(body))
}
