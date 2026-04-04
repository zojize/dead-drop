import * as t from '@babel/types'
import { generateCompact } from './codegen'
import {
  EXPR_TABLE,
  STMT_TABLE,
  BINARY_OP_POOL,
  UNARY_OP_POOL,
  ASSIGN_OP_POOL,
  VAR_KIND_POOL,
  ASSIGN_LHS_NAME,
  DEFAULT_POOLS,
} from './tables'
import { type Pools, SCOPE_SUFFIX_SEP } from './pools'

// Leaf expression byte values (no children, guaranteed termination)
const LEAF_EXPR_BYTES = [
  ...Array.from({ length: 76 }, (_, i) => i),          // NumericLiteral
  ...Array.from({ length: 64 }, (_, i) => 0x4C + i),   // Identifier
  ...Array.from({ length: 32 }, (_, i) => 0xBD + i),   // StringLiteral
  0xFD, 0xFE, 0xFF,                                     // Boolean, Null
]

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

type PoolOrFactory<T> = T[] | ((rand: number) => T)

export interface EncodeOptions {
  /** Seed for the PRNG that generates padding expressions. Defaults to message length. */
  seed?: number
  /** Custom pools matching the Pools interface. Both encode and decode must use the same pools. */
  pools?: Partial<Pools>
  /** Custom identifier names for padding. Array or factory. Merged with pool. */
  identifiers?: PoolOrFactory<string>
  /** Custom string literals for padding. Array or factory. Merged with pool. */
  strings?: PoolOrFactory<string>
  /** Custom numeric literals for padding. Array or factory. Merged with pool. */
  numbers?: PoolOrFactory<number>
}

// ─── Scope tracking ─────────────────────────────────────────────────────────

class ScopeStack {
  // All var/let/const declarations tracked globally (our code is always
  // top-level — no functions — so var hoisting means block scoping alone
  // is insufficient). A flat set avoids var-after-let conflicts.
  private allDecls = new Set<string>()
  private labelScopes: Set<string>[] = [new Set()]

  push() { this.labelScopes.push(new Set()) }
  pop() { this.labelScopes.pop() }

  hasDeclInScope(name: string): boolean {
    return this.allDecls.has(name)
  }

  /** List of all declared names (for use as identifier candidates in padding). */
  private declList: string[] = []

  declare(name: string) {
    this.allDecls.add(name)
    this.declList.push(name)
  }

  /** Pick a random previously-declared name, or null if none. */
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
  const pools: Pools = { ...DEFAULT_POOLS, ...opts.pools }

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

  function pickFrom<T>(builtIn: readonly T[], custom: PoolOrFactory<T> | undefined): (rand: number) => T {
    if (!custom) return (rand) => builtIn[rand % builtIn.length]
    if (typeof custom === 'function') {
      const factory = custom as (rand: number) => T
      return (rand) => rand % 3 === 0 ? factory(rand) : builtIn[rand % builtIn.length]
    }
    const merged = [...builtIn, ...custom]
    return (rand) => merged[rand % merged.length]
  }

  const pickIdent = pickFrom(pools.identifiers, opts.identifiers)
  const pickString = pickFrom(pools.strings, opts.strings)
  const pickNumber = pickFrom(pools.numbers, opts.numbers)


  function readByte(): number { return prefixed[cursor++] }

  /**
   * Generate a unique var name. For let/const, appends $N suffix on conflict.
   * Decoder strips suffixes to recover the base name → same variant → same byte.
   */
  function uniqueVarName(baseName: string, _kind: string): string {
    // All declaration kinds tracked — `var x` after `let x` is also a redecl error
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
    // 1-in-3 chance to reference a previously-declared variable (looks realistic)
    if (r % 3 === 0) {
      const decl = scope.pickDeclared(rng())
      if (decl) return t.identifier(decl)
    }
    switch (r % 5) {
      case 0: return t.numericLiteral(pickNumber(rng()))
      case 1: return t.identifier(pickIdent(rng()))
      case 2: return t.stringLiteral(pickString(rng()))
      case 3: return t.booleanLiteral(rng() % 2 === 0)
      default: return t.nullLiteral()
    }
  }

  function makeLeafExpr(byte: number): t.Expression | null {
    const config = EXPR_TABLE[byte]
    switch (config.nodeType) {
      case 'NumericLiteral': return t.numericLiteral(pools.numbers[config.variant])
      case 'Identifier': return t.identifier(pools.identifiers[config.variant])
      case 'StringLiteral': return t.stringLiteral(pools.strings[config.variant])
      case 'BooleanLiteral': return t.booleanLiteral(config.variant === 1)
      case 'NullLiteral': return t.nullLiteral()
      default: return null
    }
  }

  const work: WorkItem[] = []

  function slot<T>(initial?: T): Slot<T> { return { value: initial! } }
  function pushExpr(s: Slot<t.Expression>) { work.push({ kind: 'expr', slot: s }) }
  function pushStmt(s: Slot<t.Statement>) { work.push({ kind: 'stmt', slot: s }) }
  function pushBlock(s: Slot<t.Statement[]>) { work.push({ kind: 'block', slot: s }) }
  function pushAssemble(fn: () => void) { work.push({ kind: 'assemble', fn }) }

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
      case 'UnaryExpression': {
        const arg = slot<t.Expression>()
        pushAssemble(() => { s.value = t.unaryExpression(UNARY_OP_POOL[config.variant] as any, arg.value, true) })
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
      case 'MemberExpression': {
        if (config.variant === 8) {
          const obj = slot<t.Expression>(), prop = slot<t.Expression>()
          pushAssemble(() => { s.value = t.memberExpression(obj.value, prop.value, true) })
          pushExpr(prop); pushExpr(obj)
        } else {
          const obj = slot<t.Expression>()
          pushAssemble(() => { s.value = t.memberExpression(obj.value, t.identifier(pools.memberProps[config.variant]), false) })
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
            const isComputed = !t.isIdentifier(p.k.value) && !t.isStringLiteral(p.k.value) && !t.isNumericLiteral(p.k.value)
            return t.objectProperty(p.k.value, p.v.value, isComputed)
          }))
        })
        for (let i = pairs.length - 1; i >= 0; i--) { pushExpr(pairs[i].v); pushExpr(pairs[i].k) }
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
