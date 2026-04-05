import * as t from '@babel/types'
import { generateCompact } from './codegen'
import {
  type Candidate,
  type EncodingContext,
  initialContext,
  filterCandidates,
  buildTable,
  mixHash,
  nameFromHash,
  labelFromHash,
  BINARY_OPS,
  LOGICAL_OPS,
  UNARY_OPS,
  UPDATE_OPS,
  ASSIGN_OPS,
  REGEXP_FLAGS,
} from './context'

export interface EncodeOptions {
  seed?: number
}

function createRng(seed: number) {
  let s = seed | 0
  return () => {
    s = s + 0x6D2B79F5 | 0
    let z = Math.imul(s ^ s >>> 15, 1 | s)
    z = z + Math.imul(z ^ z >>> 7, 61 | z) ^ z
    return ((z ^ z >>> 14) >>> 0)
  }
}

const COSMETIC_IDENTS = ['x', 'y', 'z', 'w', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const VAR_KINDS = ['var', 'let', 'const'] as const

type Slot<T> = { value: T }
type WorkItem =
  | { kind: 'expr'; slot: Slot<t.Expression> }
  | { kind: 'assemble'; fn: () => void }

export function encode(message: Uint8Array, options?: EncodeOptions): string {
  const opts = options ?? {}
  const length = message.length
  const prefixed = new Uint8Array(4 + length)
  prefixed[0] = (length >>> 24) & 0xFF
  prefixed[1] = (length >>> 16) & 0xFF
  prefixed[2] = (length >>> 8) & 0xFF
  prefixed[3] = length & 0xFF
  prefixed.set(message, 4)

  let cursor = 0
  let hash = 0xDEADD // fixed seed — table ordering depends only on consumed bytes
  const rng = createRng(opts.seed ?? length) // cosmetic PRNG — seed changes appearance only
  const ctx: EncodingContext = initialContext()
  const isPad = () => cursor >= prefixed.length

  function readByte(): number { return prefixed[cursor++] }

  function cosmeticIdent(): string {
    // Prefer scope variables if available
    if (ctx.scope.length > 0 && rng() % 3 === 0) {
      return ctx.scope[rng() % ctx.scope.length]
    }
    return COSMETIC_IDENTS[rng() % COSMETIC_IDENTS.length]
  }
  function cosmeticNumber(): number { return rng() % 1000 }
  function cosmeticString(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz'
    const len = 1 + (rng() % 4)
    let s = ''
    for (let i = 0; i < len; i++) s += chars[rng() % chars.length]
    return s
  }
  function flagsString(bitmask: number): string {
    let s = ''
    for (let i = 0; i < REGEXP_FLAGS.length; i++) {
      if (bitmask & (1 << i)) s += REGEXP_FLAGS[i]
    }
    return s
  }

  // ─── Iterative expression builder ──────────────────────────────────

  const work: WorkItem[] = []
  function slot<T>(initial?: T): Slot<T> { return { value: initial! } }
  function pushExpr(s: Slot<t.Expression>) { work.push({ kind: 'expr', slot: s }) }
  function pushAssemble(fn: () => void) { work.push({ kind: 'assemble', fn }) }

  function padLeafExpr(): t.Expression {
    const r = rng()
    switch (r % 5) {
      case 0: return t.numericLiteral(cosmeticNumber())
      case 1: return t.identifier(cosmeticIdent())
      case 2: return t.stringLiteral(cosmeticString())
      case 3: return t.booleanLiteral(rng() % 2 === 0)
      default: return t.nullLiteral()
    }
  }

  function buildExprFromCandidate(c: Candidate, s: Slot<t.Expression>): void {
    switch (c.nodeType) {
      case 'NumericLiteral': s.value = t.numericLiteral(cosmeticNumber()); break
      case 'StringLiteral': s.value = t.stringLiteral(cosmeticString()); break
      case 'Identifier': s.value = t.identifier(cosmeticIdent()); break
      case 'BooleanLiteral': s.value = t.booleanLiteral(c.variant === 1); break
      case 'NullLiteral': s.value = t.nullLiteral(); break
      case 'BigIntLiteral': s.value = t.bigIntLiteral(String(cosmeticNumber())); break
      case 'ThisExpression': s.value = t.thisExpression(); break
      case 'RegExpLiteral': s.value = t.regExpLiteral('x', flagsString(c.variant)); break
      case 'BinaryExpression': {
        const l = slot<t.Expression>(), r = slot<t.Expression>()
        pushAssemble(() => { s.value = t.binaryExpression(BINARY_OPS[c.variant] as any, l.value, r.value) })
        pushExpr(r); pushExpr(l)
        break
      }
      case 'LogicalExpression': {
        const l = slot<t.Expression>(), r = slot<t.Expression>()
        pushAssemble(() => { s.value = t.logicalExpression(LOGICAL_OPS[c.variant] as any, l.value, r.value) })
        pushExpr(r); pushExpr(l)
        break
      }
      case 'AssignmentExpression': {
        const rhs = slot<t.Expression>()
        const lhs = ctx.scope.length > 0 ? ctx.scope[rng() % ctx.scope.length] : cosmeticIdent()
        pushAssemble(() => { s.value = t.assignmentExpression(ASSIGN_OPS[c.variant] as any, t.identifier(lhs), rhs.value) })
        pushExpr(rhs)
        break
      }
      case 'UnaryExpression': {
        const arg = slot<t.Expression>()
        pushAssemble(() => { s.value = t.unaryExpression(UNARY_OPS[c.variant] as any, arg.value, true) })
        pushExpr(arg)
        break
      }
      case 'UpdateExpression': {
        const op = UPDATE_OPS[Math.floor(c.variant / 2)]
        const prefix = c.variant % 2 === 0
        // Operand must be an LVal — use cosmetic identifier (no data child)
        s.value = t.updateExpression(op as any, t.identifier(cosmeticIdent()), prefix)
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
        const args = Array.from({ length: c.variant }, () => slot<t.Expression>())
        pushAssemble(() => { s.value = t.callExpression(callee.value, args.map(a => a.value)) })
        for (let i = args.length - 1; i >= 0; i--) pushExpr(args[i])
        pushExpr(callee)
        break
      }
      case 'NewExpression': {
        const callee = slot<t.Expression>()
        const args = Array.from({ length: c.variant }, () => slot<t.Expression>())
        pushAssemble(() => { s.value = t.newExpression(callee.value, args.map(a => a.value)) })
        for (let i = args.length - 1; i >= 0; i--) pushExpr(args[i])
        pushExpr(callee)
        break
      }
      case 'MemberExpression': {
        const obj = slot<t.Expression>()
        if (c.variant === 1) {
          const prop = slot<t.Expression>()
          pushAssemble(() => { s.value = t.memberExpression(obj.value, prop.value, true) })
          pushExpr(prop); pushExpr(obj)
        } else {
          pushAssemble(() => { s.value = t.memberExpression(obj.value, t.identifier(cosmeticIdent()), false) })
          pushExpr(obj)
        }
        break
      }
      case 'OptionalMemberExpression': {
        const obj = slot<t.Expression>()
        if (c.variant === 1) {
          const prop = slot<t.Expression>()
          pushAssemble(() => { s.value = t.optionalMemberExpression(obj.value, prop.value, true, false) })
          pushExpr(prop); pushExpr(obj)
        } else {
          pushAssemble(() => { s.value = t.optionalMemberExpression(obj.value, t.identifier(cosmeticIdent()), false, false) })
          pushExpr(obj)
        }
        break
      }
      case 'ArrayExpression': {
        const els = Array.from({ length: c.variant }, () => slot<t.Expression>())
        pushAssemble(() => { s.value = t.arrayExpression(els.map(e => e.value)) })
        for (let i = els.length - 1; i >= 0; i--) pushExpr(els[i])
        break
      }
      case 'ObjectExpression': {
        const pairs = Array.from({ length: c.variant }, () => ({ k: slot<t.Expression>(), v: slot<t.Expression>() }))
        pushAssemble(() => {
          s.value = t.objectExpression(pairs.map(p => {
            const isc = !t.isIdentifier(p.k.value) && !t.isStringLiteral(p.k.value) && !t.isNumericLiteral(p.k.value)
            return t.objectProperty(p.k.value, p.v.value, isc)
          }))
        })
        for (let i = pairs.length - 1; i >= 0; i--) { pushExpr(pairs[i].v); pushExpr(pairs[i].k) }
        break
      }
      case 'SequenceExpression': {
        const count = c.variant + 2
        const els = Array.from({ length: count }, () => slot<t.Expression>())
        pushAssemble(() => { s.value = t.sequenceExpression(els.map(e => e.value)) })
        for (let i = els.length - 1; i >= 0; i--) pushExpr(els[i])
        break
      }
      case 'TemplateLiteral': {
        const n = c.variant
        const exprs = Array.from({ length: n }, () => slot<t.Expression>())
        pushAssemble(() => {
          const quasis: t.TemplateElement[] = []
          for (let i = 0; i <= n; i++) {
            const raw = cosmeticString()
            quasis.push(t.templateElement({ raw, cooked: raw }, i === n))
          }
          s.value = t.templateLiteral(quasis, exprs.map(e => e.value))
        })
        for (let i = exprs.length - 1; i >= 0; i--) pushExpr(exprs[i])
        break
      }
      case 'TaggedTemplateExpression': {
        const n = c.variant
        const tag = slot<t.Expression>()
        const exprs = Array.from({ length: n }, () => slot<t.Expression>())
        pushAssemble(() => {
          const quasis: t.TemplateElement[] = []
          for (let i = 0; i <= n; i++) {
            const raw = cosmeticString()
            quasis.push(t.templateElement({ raw, cooked: raw }, i === n))
          }
          s.value = t.taggedTemplateExpression(tag.value, t.templateLiteral(quasis, exprs.map(e => e.value)))
        })
        for (let i = exprs.length - 1; i >= 0; i--) pushExpr(exprs[i])
        pushExpr(tag)
        break
      }
      case 'ArrowFunctionExpression': {
        const body = slot<t.Expression>()
        pushAssemble(() => {
          const params = Array.from({ length: c.variant }, (_, i) => t.identifier(`_p${i}`))
          s.value = t.arrowFunctionExpression(params, body.value)
        })
        pushExpr(body)
        break
      }
      case 'FunctionExpression': {
        const body = slot<t.Expression>()
        pushAssemble(() => {
          const params = Array.from({ length: c.variant }, (_, i) => t.identifier(`_p${i}`))
          s.value = t.functionExpression(null, params, t.blockStatement([t.returnStatement(body.value)]))
        })
        pushExpr(body)
        break
      }
      case 'SpreadElement': {
        const arg = slot<t.Expression>()
        pushAssemble(() => { s.value = t.arrayExpression([t.spreadElement(arg.value)]) })
        pushExpr(arg)
        break
      }
      case 'ClassExpression': {
        if (c.variant === 1) {
          const sup = slot<t.Expression>()
          pushAssemble(() => { s.value = t.classExpression(null, sup.value, t.classBody([]), []) })
          pushExpr(sup)
        } else {
          s.value = t.classExpression(null, null, t.classBody([]), [])
        }
        break
      }
      case 'AwaitExpression': {
        const arg = slot<t.Expression>()
        pushAssemble(() => { s.value = t.awaitExpression(arg.value) })
        pushExpr(arg)
        break
      }
      default:
        s.value = t.numericLiteral(0)
    }
  }

  function scheduleExpr(s: Slot<t.Expression>): void {
    if (isPad()) { s.value = padLeafExpr(); return }

    const byte = readByte()
    const exprCtx = { ...ctx, expressionOnly: true }
    const candidates = filterCandidates(exprCtx)
    const table = buildTable(candidates, hash)
    const c = table[byte]

    hash = mixHash(hash, byte)
    buildExprFromCandidate(c, s)
  }

  function drain(): void {
    while (work.length > 0) {
      const item = work.pop()!
      switch (item.kind) {
        case 'expr': scheduleExpr(item.slot); break
        case 'assemble': item.fn(); break
      }
    }
  }

  // ─── Build statement from candidate ────────────────────────────────

  function buildStatement(c: Candidate): t.Statement {
    switch (c.nodeType) {
      case 'ExpressionStatement': {
        const expr = slot<t.Expression>()
        pushExpr(expr)
        drain()
        return t.expressionStatement(expr.value)
      }
      case 'VariableDeclaration': {
        const kind = VAR_KINDS[c.variant]
        const name = nameFromHash(hash, ctx.scope.length)
        ctx.scope.push(name)
        const init = slot<t.Expression>()
        pushExpr(init)
        drain()
        return t.variableDeclaration(kind, [t.variableDeclarator(t.identifier(name), init.value)])
      }
      case 'IfStatement': {
        const test = slot<t.Expression>()
        pushExpr(test)
        drain()
        const cons = buildBlock()
        const alt = c.variant === 0 ? buildBlock() : null
        return t.ifStatement(test.value, t.blockStatement(cons), alt ? t.blockStatement(alt) : null)
      }
      case 'WhileStatement': {
        const test = slot<t.Expression>()
        pushExpr(test)
        drain()
        const savedInLoop = ctx.inLoop
        ctx.inLoop = true
        const body = buildBlock()
        ctx.inLoop = savedInLoop
        return t.whileStatement(test.value, t.blockStatement(body))
      }
      case 'ForStatement': {
        const hasInit = (c.variant & 1) !== 0
        const hasTest = (c.variant & 2) !== 0
        const hasUpdate = (c.variant & 4) !== 0
        let init: t.Expression | null = null
        let test: t.Expression | null = null
        let update: t.Expression | null = null
        if (hasInit) { const s = slot<t.Expression>(); pushExpr(s); drain(); init = s.value }
        if (hasTest) { const s = slot<t.Expression>(); pushExpr(s); drain(); test = s.value }
        if (hasUpdate) { const s = slot<t.Expression>(); pushExpr(s); drain(); update = s.value }
        const savedInLoop = ctx.inLoop
        ctx.inLoop = true
        const body = buildBlock()
        ctx.inLoop = savedInLoop
        return t.forStatement(init, test, update, t.blockStatement(body))
      }
      case 'DoWhileStatement': {
        const savedInLoop = ctx.inLoop
        ctx.inLoop = true
        const body = buildBlock()
        ctx.inLoop = savedInLoop
        const test = slot<t.Expression>()
        pushExpr(test)
        drain()
        return t.doWhileStatement(test.value, t.blockStatement(body))
      }
      case 'BlockStatement': {
        const body = buildBlock()
        return t.blockStatement(body)
      }
      case 'TryStatement': {
        const tryBody = buildBlock()
        const paramName = nameFromHash(hash, 999)
        const catchBody = buildBlock()
        return t.tryStatement(
          t.blockStatement(tryBody),
          t.catchClause(t.identifier(paramName), t.blockStatement(catchBody)),
        )
      }
      case 'SwitchStatement': {
        const disc = slot<t.Expression>()
        pushExpr(disc)
        drain()
        const cases: t.SwitchCase[] = []
        for (let i = 0; i < c.variant; i++) {
          const test = slot<t.Expression>()
          pushExpr(test)
          drain()
          const body = buildBlock()
          cases.push(t.switchCase(test.value, body))
        }
        return t.switchStatement(disc.value, cases)
      }
      case 'LabeledStatement': {
        const label = labelFromHash(hash)
        const body = buildBlock()
        return t.labeledStatement(t.identifier(label), t.blockStatement(body))
      }
      case 'ThrowStatement': {
        const arg = slot<t.Expression>()
        pushExpr(arg)
        drain()
        return t.throwStatement(arg.value)
      }
      case 'ReturnStatement': {
        const arg = slot<t.Expression>()
        pushExpr(arg)
        drain()
        return t.returnStatement(arg.value)
      }
      case 'EmptyStatement':
        return t.emptyStatement()
      case 'DebuggerStatement':
        return t.debuggerStatement()
      case 'BreakStatement':
        return t.breakStatement()
      case 'ContinueStatement':
        return t.continueStatement()
      default:
        // Expression in statement position — wrap in ExpressionStatement
        const expr = slot<t.Expression>()
        buildExprFromCandidate(c, expr)
        drain()
        return t.expressionStatement(expr.value)
    }
  }

  function buildBlock(): t.Statement[] {
    if (isPad()) return []
    const countByte = readByte()
    hash = mixHash(hash, countByte)
    const count = countByte // recovered from stmts.length by decoder
    const stmts: t.Statement[] = []
    for (let i = 0; i < count; i++) {
      stmts.push(buildTopLevel())
    }
    return stmts
  }

  function buildTopLevel(): t.Statement {
    if (isPad()) return t.expressionStatement(padLeafExpr())

    const byte = readByte()
    const candidates = filterCandidates(ctx)
    const table = buildTable(candidates, hash)
    const c = table[byte]

    hash = mixHash(hash, byte)
    return buildStatement(c)
  }

  // ─── Main ──────────────────────────────────────────────────────────

  const body: t.Statement[] = []
  while (cursor < prefixed.length) {
    body.push(buildTopLevel())
  }

  return generateCompact(t.program(body))
}
