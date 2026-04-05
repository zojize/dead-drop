import * as t from '@babel/types'
import { generateCompact } from './codegen'
import {
  EXPR_TABLE,
  BINARY_OP_POOL,
  LOGICAL_OP_POOL,
  UNARY_OP_POOL,
  UPDATE_OP_POOL,
  ASSIGN_OP_POOL,
  REGEXP_FLAGS,
  ASSIGN_LHS_NAME,
} from './tables'

function createPadRng(seed: number) {
  let s = seed | 0
  return () => {
    s = s + 0x6D2B79F5 | 0
    let z = Math.imul(s ^ s >>> 15, 1 | s)
    z = z + Math.imul(z ^ z >>> 7, 61 | z) ^ z
    return ((z ^ z >>> 14) >>> 0)
  }
}

export interface EncodeOptions {
  seed?: number
}

const COSMETIC_IDENTS = [
  'x', 'y', 'z', 'w', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h',
  'i', 'j', 'k', 'n', 'm', 'o', 'val', 'tmp', 'res', 'idx', 'len', 'sum',
]

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
  const rng = createPadRng(opts.seed ?? length)
  const isPad = () => cursor >= prefixed.length

  function readByte(): number { return prefixed[cursor++] }

  function cosmeticIdent(): string {
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

  function makeLeafExpr(byte: number): t.Expression | null {
    const config = EXPR_TABLE[byte]
    switch (config.nodeType) {
      case 'NumericLiteral': return t.numericLiteral(cosmeticNumber())
      case 'StringLiteral': return t.stringLiteral(cosmeticString())
      case 'Identifier': return t.identifier(cosmeticIdent())
      case 'BooleanLiteral': return t.booleanLiteral(config.variant === 1)
      case 'NullLiteral': return t.nullLiteral()
      case 'BigIntLiteral': return t.bigIntLiteral(String(cosmeticNumber()))
      case 'ThisExpression': return t.thisExpression()
      case 'RegExpLiteral': return t.regExpLiteral('x', flagsString(config.variant))
      default: return null
    }
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
      case 'AssignmentExpression': {
        const rhs = slot<t.Expression>()
        pushAssemble(() => { s.value = t.assignmentExpression(ASSIGN_OP_POOL[config.variant] as any, t.identifier(ASSIGN_LHS_NAME), rhs.value) })
        pushExpr(rhs)
        break
      }
      case 'UnaryExpression': {
        const arg = slot<t.Expression>()
        pushAssemble(() => { s.value = t.unaryExpression(UNARY_OP_POOL[config.variant] as any, arg.value, true) })
        pushExpr(arg)
        break
      }
      case 'UpdateExpression': {
        const op = UPDATE_OP_POOL[Math.floor(config.variant / 2)]
        const prefix = config.variant % 2 === 0
        const arg = slot<t.Expression>()
        pushAssemble(() => { s.value = t.updateExpression(op as any, arg.value, prefix) })
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
        const obj = slot<t.Expression>()
        if (config.variant === 1) { // computed
          const prop = slot<t.Expression>()
          pushAssemble(() => { s.value = t.memberExpression(obj.value, prop.value, true) })
          pushExpr(prop); pushExpr(obj)
        } else { // non-computed
          pushAssemble(() => { s.value = t.memberExpression(obj.value, t.identifier(cosmeticIdent()), false) })
          pushExpr(obj)
        }
        break
      }
      case 'OptionalMemberExpression': {
        const obj = slot<t.Expression>()
        if (config.variant === 1) {
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
      case 'SequenceExpression': {
        const count = config.variant + 2
        const els = Array.from({ length: count }, () => slot<t.Expression>())
        pushAssemble(() => { s.value = t.sequenceExpression(els.map(e => e.value)) })
        for (let i = els.length - 1; i >= 0; i--) pushExpr(els[i])
        break
      }
      case 'TemplateLiteral': {
        const exprCount = config.variant
        const exprs = Array.from({ length: exprCount }, () => slot<t.Expression>())
        pushAssemble(() => {
          const quasis: t.TemplateElement[] = []
          for (let i = 0; i <= exprCount; i++) {
            const raw = cosmeticString()
            quasis.push(t.templateElement({ raw, cooked: raw }, i === exprCount))
          }
          s.value = t.templateLiteral(quasis, exprs.map(e => e.value))
        })
        for (let i = exprs.length - 1; i >= 0; i--) pushExpr(exprs[i])
        break
      }
      case 'TaggedTemplateExpression': {
        const exprCount = config.variant
        const tag = slot<t.Expression>()
        const exprs = Array.from({ length: exprCount }, () => slot<t.Expression>())
        pushAssemble(() => {
          const quasis: t.TemplateElement[] = []
          for (let i = 0; i <= exprCount; i++) {
            const raw = cosmeticString()
            quasis.push(t.templateElement({ raw, cooked: raw }, i === exprCount))
          }
          s.value = t.taggedTemplateExpression(tag.value, t.templateLiteral(quasis, exprs.map(e => e.value)))
        })
        for (let i = exprs.length - 1; i >= 0; i--) pushExpr(exprs[i])
        pushExpr(tag)
        break
      }
      case 'ArrowFunctionExpression': {
        const paramCount = config.variant
        const body = slot<t.Expression>()
        pushAssemble(() => {
          const params = Array.from({ length: paramCount }, (_, i) => t.identifier(`_p${i}`))
          s.value = t.arrowFunctionExpression(params, body.value)
        })
        pushExpr(body)
        break
      }
      case 'FunctionExpression': {
        const paramCount = config.variant
        const body = slot<t.Expression>()
        pushAssemble(() => {
          const params = Array.from({ length: paramCount }, (_, i) => t.identifier(`_p${i}`))
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
        const hasSuperClass = config.variant === 1
        if (hasSuperClass) {
          const superClass = slot<t.Expression>()
          pushAssemble(() => { s.value = t.classExpression(null, superClass.value, t.classBody([]), []) })
          pushExpr(superClass)
        } else {
          s.value = t.classExpression(null, null, t.classBody([]), [])
        }
        break
      }
      default:
        throw new Error(`Unknown expression type: ${config.nodeType}`)
    }
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

  // Build top-level: each byte → expression → ExpressionStatement
  const body: t.Statement[] = []
  while (cursor < prefixed.length) {
    const s = slot<t.Expression>()
    scheduleExpr(s)
    drain()
    body.push(t.expressionStatement(s.value))
  }

  return generateCompact(t.program(body))
}
