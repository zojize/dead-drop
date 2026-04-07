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
  inferTypeFromKey,
  BINARY_OPS,
  LOGICAL_OPS,
  UNARY_OPS,
  UPDATE_OPS,
  ASSIGN_OPS,
  REGEXP_FLAGS,
  MAX_EXPR_DEPTH,
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

const SAFE_IDENTS = ['undefined', 'NaN', 'Infinity', 'globalThis', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date']
const VAR_KINDS = ['var', 'let', 'const'] as const

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
  let hash = 0xDEADD
  const rng = createRng(opts.seed ?? length)
  const ctx: EncodingContext = initialContext()
  const isPad = () => cursor >= prefixed.length

  function readByte(): number { return prefixed[cursor++] }

  function cosmeticIdent(): string {
    if (ctx.typedScope.length > 0 && rng() % 3 === 0) {
      return ctx.typedScope[rng() % ctx.typedScope.length].name
    }
    return SAFE_IDENTS[rng() % SAFE_IDENTS.length]
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

  function padLeafExpr(): t.Expression {
    const r = rng()
    if (ctx.typedScope.length > 0 && r % 3 === 0) {
      return t.identifier(ctx.typedScope[rng() % ctx.typedScope.length].name)
    }
    switch (r % 4) {
      case 0: return t.numericLiteral(cosmeticNumber())
      case 1: return t.stringLiteral(cosmeticString())
      case 2: return t.booleanLiteral(rng() % 2 === 0)
      default: return t.nullLiteral()
    }
  }

  // ─── Recursive expression builder ──────────────────────────────────

  function buildExpr(depth: number): { node: t.Expression; candidate: Candidate | null } {
    if (isPad()) return { node: padLeafExpr(), candidate: null }

    const byte = readByte()
    const exprCtx = { ...ctx, expressionOnly: true, exprDepth: depth }
    const candidates = filterCandidates(exprCtx)
    const table = buildTable(candidates, hash)
    const c = table[byte]
    hash = mixHash(hash, byte)

    const node = buildExprNode(c, depth)
    return { node, candidate: c }
  }

  function buildExprNode(c: Candidate, depth: number): t.Expression {
    switch (c.nodeType) {
      case 'NumericLiteral': return t.numericLiteral(cosmeticNumber())
      case 'StringLiteral': return t.stringLiteral(cosmeticString())
      case 'Identifier': return t.identifier(cosmeticIdent())
      case 'BooleanLiteral': return t.booleanLiteral(c.variant === 1)
      case 'NullLiteral': return t.nullLiteral()
      case 'RegExpLiteral': return t.regExpLiteral(cosmeticString(), flagsString(rng() % 64))
      case 'ThisExpression': return t.thisExpression()
      case 'BinaryExpression':
        return t.binaryExpression(BINARY_OPS[c.variant] as any, buildExpr(depth + 1).node, buildExpr(depth + 1).node)
      case 'LogicalExpression':
        return t.logicalExpression(LOGICAL_OPS[c.variant] as any, buildExpr(depth + 1).node, buildExpr(depth + 1).node)
      case 'AssignmentExpression': {
        const lhs = ctx.typedScope.length > 0 ? ctx.typedScope[rng() % ctx.typedScope.length].name : cosmeticIdent()
        return t.assignmentExpression(ASSIGN_OPS[c.variant] as any, t.identifier(lhs), buildExpr(depth + 1).node)
      }
      case 'UnaryExpression':
        return t.unaryExpression(UNARY_OPS[c.variant] as any, buildExpr(depth + 1).node, true)
      case 'UpdateExpression': {
        const op = UPDATE_OPS[Math.floor(c.variant / 2)]
        const prefix = c.variant % 2 === 0
        const name = ctx.typedScope.length > 0 ? ctx.typedScope[rng() % ctx.typedScope.length].name : cosmeticIdent()
        return t.updateExpression(op as any, t.identifier(name), prefix)
      }
      case 'ConditionalExpression':
        return t.conditionalExpression(buildExpr(depth + 1).node, buildExpr(depth + 1).node, buildExpr(depth + 1).node)
      case 'CallExpression': {
        const callee = buildExpr(depth + 1).node
        const args = Array.from({ length: c.variant }, () => buildExpr(depth + 1).node)
        return t.callExpression(callee, args)
      }
      case 'OptionalCallExpression': {
        const callee = buildExpr(depth + 1).node
        const args = Array.from({ length: c.variant }, () => buildExpr(depth + 1).node)
        return t.optionalCallExpression(callee, args, false)
      }
      case 'NewExpression': {
        const callee = buildExpr(depth + 1).node
        const args = Array.from({ length: c.variant }, () => buildExpr(depth + 1).node)
        return t.newExpression(callee, args)
      }
      case 'MemberExpression':
        if (c.variant === 1) return t.memberExpression(buildExpr(depth + 1).node, buildExpr(depth + 1).node, true)
        return t.memberExpression(buildExpr(depth + 1).node, t.identifier(cosmeticIdent()), false)
      case 'OptionalMemberExpression':
        if (c.variant === 1) return t.optionalMemberExpression(buildExpr(depth + 1).node, buildExpr(depth + 1).node, true, false)
        return t.optionalMemberExpression(buildExpr(depth + 1).node, t.identifier(cosmeticIdent()), false, false)
      case 'ArrayExpression':
        return t.arrayExpression(Array.from({ length: c.variant }, () => buildExpr(depth + 1).node))
      case 'ObjectExpression': {
        const pairs = Array.from({ length: c.variant }, () => {
          const k = buildExpr(depth + 1).node
          const v = buildExpr(depth + 1).node
          const isc = !t.isIdentifier(k) && !t.isStringLiteral(k) && !t.isNumericLiteral(k)
          return t.objectProperty(k, v, isc)
        })
        return t.objectExpression(pairs)
      }
      case 'SequenceExpression':
        return t.sequenceExpression(Array.from({ length: c.variant + 2 }, () => buildExpr(depth + 1).node))
      case 'TemplateLiteral': {
        const exprs = Array.from({ length: c.variant }, () => buildExpr(depth + 1).node)
        const quasis = Array.from({ length: c.variant + 1 }, (_, i) => {
          const raw = cosmeticString()
          return t.templateElement({ raw, cooked: raw }, i === c.variant)
        })
        return t.templateLiteral(quasis, exprs)
      }
      case 'TaggedTemplateExpression': {
        const tag = buildExpr(depth + 1).node
        const exprs = Array.from({ length: c.variant }, () => buildExpr(depth + 1).node)
        const quasis = Array.from({ length: c.variant + 1 }, (_, i) => {
          const raw = cosmeticString()
          return t.templateElement({ raw, cooked: raw }, i === c.variant)
        })
        return t.taggedTemplateExpression(tag, t.templateLiteral(quasis, exprs))
      }
      case 'ArrowFunctionExpression': {
        const paramNames = Array.from({ length: c.variant }, (_, i) => nameFromHash(hash, 900 + i))
        const savedScope = [...ctx.scope]; const savedTyped = [...ctx.typedScope]; const savedFn = ctx.inFunction
        for (const p of paramNames) { ctx.scope.push(p); ctx.typedScope.push({ name: p, type: 'any' }) }
        ctx.inFunction = true
        const body = buildExpr(depth + 1).node
        ctx.scope = savedScope; ctx.typedScope = savedTyped; ctx.inFunction = savedFn
        return t.arrowFunctionExpression(paramNames.map(n => t.identifier(n)), body)
      }
      case 'FunctionExpression': {
        const paramNames = Array.from({ length: c.variant }, (_, i) => nameFromHash(hash, 900 + i))
        const savedScope = [...ctx.scope]; const savedTyped = [...ctx.typedScope]; const savedFn = ctx.inFunction
        for (const p of paramNames) { ctx.scope.push(p); ctx.typedScope.push({ name: p, type: 'any' }) }
        ctx.inFunction = true
        const body = buildExpr(depth + 1).node
        ctx.scope = savedScope; ctx.typedScope = savedTyped; ctx.inFunction = savedFn
        return t.functionExpression(null, paramNames.map(n => t.identifier(n)), t.blockStatement([t.returnStatement(body)]))
      }
      case 'SpreadElement':
        return t.arrayExpression([t.spreadElement(buildExpr(depth + 1).node)])
      case 'ClassExpression':
        if (c.variant === 1) return t.classExpression(null, buildExpr(depth + 1).node, t.classBody([]), [])
        return t.classExpression(null, null, t.classBody([]), [])
      case 'AwaitExpression':
        return t.awaitExpression(buildExpr(depth + 1).node)
      default:
        return t.numericLiteral(0)
    }
  }

  // ─── Statement builder ─────────────────────────────────────────────

  function buildStatement(c: Candidate): t.Statement {
    switch (c.nodeType) {
      case 'ExpressionStatement': return t.expressionStatement(buildExpr(0).node)
      case 'VariableDeclaration': {
        const kind = VAR_KINDS[c.variant]
        const name = nameFromHash(hash, ctx.scope.length)
        ctx.scope.push(name)
        const { node: init, candidate: initC } = buildExpr(0)
        const inferredType = initC ? inferTypeFromKey(initC.key) : 'any'
        ctx.typedScope.push({ name, type: inferredType })
        return t.variableDeclaration(kind, [t.variableDeclarator(t.identifier(name), init)])
      }
      case 'IfStatement': {
        const test = buildExpr(0).node
        const cons = buildBlock()
        const alt = c.variant === 0 ? buildBlock() : null
        return t.ifStatement(test, t.blockStatement(cons), alt ? t.blockStatement(alt) : null)
      }
      case 'WhileStatement': {
        const test = buildExpr(0).node
        const savedLoop = ctx.inLoop; ctx.inLoop = true
        const body = buildBlock()
        ctx.inLoop = savedLoop
        return t.whileStatement(test, t.blockStatement(body))
      }
      case 'ForStatement': {
        const hasInit = (c.variant & 1) !== 0, hasTest = (c.variant & 2) !== 0, hasUpdate = (c.variant & 4) !== 0
        const init = hasInit ? buildExpr(0).node : null
        const test = hasTest ? buildExpr(0).node : null
        const update = hasUpdate ? buildExpr(0).node : null
        const savedLoop = ctx.inLoop; ctx.inLoop = true
        const body = buildBlock()
        ctx.inLoop = savedLoop
        return t.forStatement(init, test, update, t.blockStatement(body))
      }
      case 'DoWhileStatement': {
        const savedLoop = ctx.inLoop; ctx.inLoop = true
        const body = buildBlock()
        ctx.inLoop = savedLoop
        return t.doWhileStatement(buildExpr(0).node, t.blockStatement(body))
      }
      case 'BlockStatement': return t.blockStatement(buildBlock())
      case 'TryStatement': {
        const tryBody = buildBlock()
        const paramName = nameFromHash(hash, 999)
        const catchBody = buildBlock()
        return t.tryStatement(t.blockStatement(tryBody), t.catchClause(t.identifier(paramName), t.blockStatement(catchBody)))
      }
      case 'SwitchStatement': {
        const disc = buildExpr(0).node
        const cases = Array.from({ length: c.variant }, () => {
          const test = buildExpr(0).node
          const body = buildBlock()
          return t.switchCase(test, body)
        })
        return t.switchStatement(disc, cases)
      }
      case 'LabeledStatement': return t.labeledStatement(t.identifier(labelFromHash(hash)), t.blockStatement(buildBlock()))
      case 'ThrowStatement': return t.throwStatement(buildExpr(0).node)
      case 'ReturnStatement': return t.returnStatement(buildExpr(0).node)
      case 'EmptyStatement': return t.emptyStatement()
      case 'DebuggerStatement': return t.debuggerStatement()
      case 'BreakStatement': return t.breakStatement()
      case 'ContinueStatement': return t.continueStatement()
      default: return t.expressionStatement(buildExprNode(c, 0))
    }
  }

  function buildBlock(): t.Statement[] {
    if (isPad()) return []
    const countByte = readByte()
    hash = mixHash(hash, countByte)
    const stmts: t.Statement[] = []
    for (let i = 0; i < countByte; i++) stmts.push(buildTopLevel())
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

  const body: t.Statement[] = []
  while (cursor < prefixed.length) body.push(buildTopLevel())
  return generateCompact(t.program(body))
}
