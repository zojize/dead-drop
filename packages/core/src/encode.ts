import type { Candidate, EncodingContext } from './context'
import * as t from '@babel/types'
import { generateCompact } from './codegen'
import {
  ASSIGN_OPS,
  bigramKey,
  BINARY_OPS,
  bitWidth,
  BitWriter,
  buildTable,
  deriveScopeBucket,
  filterCandidates,
  inferTypeFromKey,
  initialContext,
  labelFromHash,
  LOGICAL_OPS,
  MAX_EXPR_DEPTH,
  mixHash,
  nameFromHash,
  UNARY_OPS,
  UPDATE_OPS,
} from './context'
import cosmeticData from './cosmetic-data.json'

export interface EncodeOptions {
  /** Cosmetic seed — affects names/strings/numbers but not decoded data. */
  seed?: number
  /** Structural key — affects candidate selection. Decoder must receive the same key. */
  key?: number
  maxExprDepth?: number
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

const CORPUS_IDENTS = cosmeticData.identifiers
const CORPUS_STRINGS = cosmeticData.strings
const CORPUS_NUMBERS = cosmeticData.numbers
const CORPUS_FUNC_NAMES = cosmeticData.functionNames
const CORPUS_PROPS = cosmeticData.properties
const PACKAGE_NAMES: string[] = (cosmeticData.packageNames) ?? []
const IMPORTED_NAMES: string[] = (cosmeticData.importedNames) ?? []
const VAR_KINDS = ['var', 'let', 'const'] as const

export function encode(message: Uint8Array, options?: EncodeOptions): string {
  const opts = options ?? {}
  const length = message.length
  // Prefix: 4-byte big-endian length, then payload
  const prefixed = new Uint8Array(4 + length)
  prefixed[0] = (length >>> 24) & 0xFF
  prefixed[1] = (length >>> 16) & 0xFF
  prefixed[2] = (length >>> 8) & 0xFF
  prefixed[3] = length & 0xFF
  prefixed.set(message, 4)

  // Convert to a bitstream for variable-width reads
  const writer = new BitWriter()
  // Write all prefixed bytes as 8-bit values into the writer (source bits)
  for (let i = 0; i < prefixed.length; i++)
    writer.write(prefixed[i], 8)
  const allBits = writer.toBytes()
  // Now read from allBits as a bitstream
  const totalBits = prefixed.length * 8
  let bitPos = 0

  const key = opts.key
  let hash = key != null ? mixHash(0xDEADD, key) : 0xDEADD
  const rng = createRng(opts.seed ?? length)
  const ctx: EncodingContext = { ...initialContext(), maxExprDepth: opts.maxExprDepth ?? MAX_EXPR_DEPTH }
  const isPad = () => bitPos >= totalBits

  /** Read `width` bits from the input bitstream. */
  function readBits(width: number): number {
    let value = 0
    for (let i = 0; i < width; i++) {
      const byteIdx = bitPos >>> 3
      const bitIdx = 7 - (bitPos & 7)
      value = (value << 1) | ((allBits[byteIdx] >>> bitIdx) & 1)
      bitPos++
    }
    return value
  }

  function cosmeticIdent(): string {
    if (ctx.typedScope.length > 0 && rng() % 3 === 0) {
      return ctx.typedScope[rng() % ctx.typedScope.length].name
    }
    return CORPUS_IDENTS[rng() % CORPUS_IDENTS.length]
  }
  function cosmeticProp(): string {
    return CORPUS_PROPS[rng() % CORPUS_PROPS.length]
  }
  function cosmeticNumber(): number {
    return CORPUS_NUMBERS[rng() % CORPUS_NUMBERS.length]
  }
  function cosmeticString(): string {
    return CORPUS_STRINGS[rng() % CORPUS_STRINGS.length]
  }
  /** Template-safe string (no backticks, backslashes, or ${) */
  function cosmeticTemplateRaw(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz'
    const len = 1 + (rng() % 4)
    let s = ''
    for (let i = 0; i < len; i++)
      s += chars[rng() % chars.length]
    return s
  }
  function cosmeticFuncName(): string {
    return CORPUS_FUNC_NAMES[rng() % CORPUS_FUNC_NAMES.length]
  }
  function cosmeticPackageName(): string {
    if (PACKAGE_NAMES.length === 0)
      return 'pkg'
    return PACKAGE_NAMES[rng() % PACKAGE_NAMES.length]
  }
  function cosmeticImportedName(h: number, offset: number): string {
    // Uses hash so imports are deterministic from structural position
    // (same structural spot → same name, allowing consistent references)
    if (IMPORTED_NAMES.length === 0)
      return nameFromHash(h, offset)
    const mixed = mixHash(h, offset)
    return IMPORTED_NAMES[mixed % IMPORTED_NAMES.length]
  }
  function cosmeticFlags(): string {
    const FLAGS = 'dgimsuy'
    let s = ''
    for (let i = 0; i < FLAGS.length; i++) {
      if (rng() % 3 === 0)
        s += FLAGS[i]
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

  function buildExpr(depth: number): { node: t.Expression, candidate: Candidate | null } {
    if (isPad())
      return { node: padLeafExpr(), candidate: null }

    const exprCtx = { ...ctx, expressionOnly: true, exprDepth: depth }
    const candidates = filterCandidates(exprCtx)
    const table = buildTable(candidates, hash)
    const bits = bitWidth(table.length)
    const value = readBits(bits)
    const c = table[value]
    hash = mixHash(hash, value)

    const cosmetic = ctx.maxExprDepth < Infinity && depth >= ctx.maxExprDepth
    const node = buildExprNode(c, depth, cosmetic)
    return { node, candidate: c }
  }

  function buildExprNode(c: Candidate, depth: number, cosmeticChildren = false): t.Expression {
    // At max depth, all children become cosmetic (non-data-carrying) — hard depth cap
    const child = cosmeticChildren ? padLeafExpr : () => buildExpr(depth + 1).node

    switch (c.nodeType) {
      case 'NumericLiteral': return t.numericLiteral(cosmeticNumber())
      case 'StringLiteral': return t.stringLiteral(cosmeticString())
      case 'Identifier': return t.identifier(cosmeticIdent())
      case 'BooleanLiteral': return t.booleanLiteral(c.variant === 1)
      case 'NullLiteral': return t.nullLiteral()
      case 'RegExpLiteral': return t.regExpLiteral(cosmeticTemplateRaw(), cosmeticFlags())
      case 'ThisExpression': return t.thisExpression()
      case 'BinaryExpression':
        return t.binaryExpression(BINARY_OPS[c.variant], child(), child())
      case 'LogicalExpression':
        return t.logicalExpression(LOGICAL_OPS[c.variant], child(), child())
      case 'AssignmentExpression': {
        const lhs = ctx.typedScope.length > 0 ? ctx.typedScope[rng() % ctx.typedScope.length].name : cosmeticIdent()
        return t.assignmentExpression(ASSIGN_OPS[c.variant], t.identifier(lhs), child())
      }
      case 'UnaryExpression':
        return t.unaryExpression(UNARY_OPS[c.variant], child(), true)
      case 'UpdateExpression': {
        const op = UPDATE_OPS[Math.floor(c.variant / 2)]
        const prefix = c.variant % 2 === 0
        const name = ctx.typedScope.length > 0 ? ctx.typedScope[rng() % ctx.typedScope.length].name : cosmeticIdent()
        return t.updateExpression(op, t.identifier(name), prefix)
      }
      case 'ConditionalExpression':
        return t.conditionalExpression(child(), child(), child())
      case 'CallExpression': {
        const callee = child()
        const args = Array.from({ length: c.variant }, () => child())
        return t.callExpression(callee, args)
      }
      case 'OptionalCallExpression': {
        const callee = child()
        const args = Array.from({ length: c.variant }, () => child())
        return t.optionalCallExpression(callee, args, false)
      }
      case 'NewExpression': {
        const callee = child()
        const args = Array.from({ length: c.variant }, () => child())
        return t.newExpression(callee, args)
      }
      case 'MemberExpression':
        if (c.variant === 1)
          return t.memberExpression(child(), child(), true)
        return t.memberExpression(child(), t.identifier(cosmeticProp()), false)
      case 'OptionalMemberExpression':
        if (c.variant === 1)
          return t.optionalMemberExpression(child(), child(), true, false)
        return t.optionalMemberExpression(child(), t.identifier(cosmeticProp()), false, false)
      case 'ArrayExpression':
        return t.arrayExpression(Array.from({ length: c.variant }, () => child()))
      case 'ObjectExpression': {
        const pairs = Array.from({ length: c.variant }, () => {
          const k = child()
          const v = child()
          const isc = !t.isIdentifier(k) && !t.isStringLiteral(k) && !t.isNumericLiteral(k)
          return t.objectProperty(k, v, isc)
        })
        return t.objectExpression(pairs)
      }
      case 'SequenceExpression':
        return t.sequenceExpression(Array.from({ length: c.variant + 2 }, () => child()))
      case 'TemplateLiteral': {
        const exprs = Array.from({ length: c.variant }, () => child())
        const quasis = Array.from({ length: c.variant + 1 }, (_, i) => {
          const raw = cosmeticTemplateRaw()
          return t.templateElement({ raw, cooked: raw }, i === c.variant)
        })
        return t.templateLiteral(quasis, exprs)
      }
      case 'TaggedTemplateExpression': {
        const tag = child()
        const exprs = Array.from({ length: c.variant }, () => child())
        const quasis = Array.from({ length: c.variant + 1 }, (_, i) => {
          const raw = cosmeticTemplateRaw()
          return t.templateElement({ raw, cooked: raw }, i === c.variant)
        })
        return t.taggedTemplateExpression(tag, t.templateLiteral(quasis, exprs))
      }
      case 'ArrowFunctionExpression': {
        const paramNames = Array.from({ length: c.variant }, (_, i) => nameFromHash(hash, 900 + i))
        if (cosmeticChildren) {
          return t.arrowFunctionExpression(paramNames.map(n => t.identifier(n)), child())
        }
        const savedScope = [...ctx.scope]
        const savedTyped = [...ctx.typedScope]
        const savedFn = ctx.inFunction
        for (const p of paramNames) {
          ctx.scope.push(p)
          ctx.typedScope.push({ name: p, type: 'any' })
        }
        ctx.inFunction = true
        const savedBucket = ctx.scopeBucket
        ctx.scopeBucket = 'function-body'
        const body = buildExpr(depth + 1).node
        ctx.scopeBucket = savedBucket
        ctx.scope = savedScope
        ctx.typedScope = savedTyped
        ctx.inFunction = savedFn
        return t.arrowFunctionExpression(paramNames.map(n => t.identifier(n)), body)
      }
      case 'FunctionExpression': {
        const fnName = cosmeticFuncName()
        const paramNames = Array.from({ length: c.variant }, (_, i) => nameFromHash(hash, 900 + i))
        if (cosmeticChildren) {
          return t.functionExpression(t.identifier(fnName), paramNames.map(n => t.identifier(n)), t.blockStatement([t.returnStatement(child())]))
        }
        const savedScope = [...ctx.scope]
        const savedTyped = [...ctx.typedScope]
        const savedFn = ctx.inFunction
        for (const p of paramNames) {
          ctx.scope.push(p)
          ctx.typedScope.push({ name: p, type: 'any' })
        }
        ctx.inFunction = true
        const savedBucket = ctx.scopeBucket
        ctx.scopeBucket = 'function-body'
        const body = buildExpr(depth + 1).node
        ctx.scopeBucket = savedBucket
        ctx.scope = savedScope
        ctx.typedScope = savedTyped
        ctx.inFunction = savedFn
        return t.functionExpression(t.identifier(fnName), paramNames.map(n => t.identifier(n)), t.blockStatement([t.returnStatement(body)]))
      }
      case 'SpreadElement':
        return t.arrayExpression([t.spreadElement(child())])
      case 'ClassExpression':
        if (c.variant === 1)
          return t.classExpression(null, child(), t.classBody([]), [])
        return t.classExpression(null, null, t.classBody([]), [])
      case 'AwaitExpression':
        return t.awaitExpression(child())
      default:
        return t.numericLiteral(0)
    }
  }

  // ─── Statement builder ─────────────────────────────────────────────

  function buildStatement(c: Candidate): t.Statement {
    switch (c.nodeType) {
      case 'VariableDeclaration': {
        const kind = VAR_KINDS[c.variant]
        let name = nameFromHash(hash, ctx.scope.length)
        while (ctx.scope.includes(name))
          name = `${name}${ctx.scope.length}`
        ctx.scope.push(name)
        const { node: init, candidate: initC } = buildExpr(0)
        const inferredType = initC ? inferTypeFromKey(initC.key) : 'any'
        ctx.typedScope.push({ name, type: inferredType })
        return t.variableDeclaration(kind, [t.variableDeclarator(t.identifier(name), init)])
      }
      case 'IfStatement': {
        const test = buildExpr(0).node
        const cons = buildBlock('IfStatement', 'consequent')
        const alt = c.variant === 0 ? buildBlock('IfStatement', 'alternate') : null
        return t.ifStatement(test, t.blockStatement(cons), alt ? t.blockStatement(alt) : null)
      }
      case 'WhileStatement': {
        const test = buildExpr(0).node
        const savedLoop = ctx.inLoop
        ctx.inLoop = true
        const body = buildBlock('WhileStatement', 'body')
        ctx.inLoop = savedLoop
        return t.whileStatement(test, t.blockStatement(body))
      }
      case 'ForStatement': {
        const hasInit = (c.variant & 1) !== 0
        const hasTest = (c.variant & 2) !== 0
        const hasUpdate = (c.variant & 4) !== 0
        const init = hasInit ? buildExpr(0).node : null
        const test = hasTest ? buildExpr(0).node : null
        const update = hasUpdate ? buildExpr(0).node : null
        const savedLoop = ctx.inLoop
        ctx.inLoop = true
        const body = buildBlock('ForStatement', 'body')
        ctx.inLoop = savedLoop
        return t.forStatement(init, test, update, t.blockStatement(body))
      }
      case 'DoWhileStatement': {
        const savedLoop = ctx.inLoop
        ctx.inLoop = true
        const body = buildBlock('DoWhileStatement', 'body')
        ctx.inLoop = savedLoop
        return t.doWhileStatement(buildExpr(0).node, t.blockStatement(body))
      }
      case 'BlockStatement': return t.blockStatement(buildBlock('BlockStatement', 'body'))
      case 'TryStatement': {
        const tryBody = buildBlock('TryStatement', 'block')
        const paramName = nameFromHash(hash, 999)
        const catchBody = buildBlock('CatchClause', 'body')
        return t.tryStatement(t.blockStatement(tryBody), t.catchClause(t.identifier(paramName), t.blockStatement(catchBody)))
      }
      case 'SwitchStatement': {
        const disc = buildExpr(0).node
        const cases = Array.from({ length: c.variant }, () => {
          const test = buildExpr(0).node
          const body = buildBlock('SwitchCase', 'consequent')
          return t.switchCase(test, body)
        })
        return t.switchStatement(disc, cases)
      }
      case 'LabeledStatement': return t.labeledStatement(t.identifier(labelFromHash(hash)), t.blockStatement(buildBlock('LabeledStatement', 'body')))
      case 'ThrowStatement': return t.throwStatement(buildExpr(0).node)
      case 'ReturnStatement': return t.returnStatement(buildExpr(0).node)
      case 'EmptyStatement': return t.emptyStatement()
      case 'DebuggerStatement': return t.debuggerStatement()
      case 'BreakStatement': return t.breakStatement()
      case 'ContinueStatement': return t.continueStatement()
      case 'ImportDeclaration': {
        const pkg = cosmeticPackageName()
        if (c.variant === 0) {
          // side-effect
          return t.importDeclaration([], t.stringLiteral(pkg))
        }
        if (c.variant === 1) {
          // default
          let local = cosmeticImportedName(hash, 1)
          while (ctx.scope.includes(local))
            local = `${local}${ctx.scope.length}`
          ctx.scope.push(local)
          ctx.typedScope.push({ name: local, type: 'any' })
          return t.importDeclaration(
            [t.importDefaultSpecifier(t.identifier(local))],
            t.stringLiteral(pkg),
          )
        }
        // named: variants 2..5 → 1..4 specifiers
        const count = c.variant - 1
        const specifiers: t.ImportSpecifier[] = []
        for (let i = 0; i < count; i++) {
          let local = cosmeticImportedName(hash, 10 + i)
          while (ctx.scope.includes(local))
            local = `${local}${ctx.scope.length}`
          ctx.scope.push(local)
          ctx.typedScope.push({ name: local, type: 'any' })
          specifiers.push(t.importSpecifier(t.identifier(local), t.identifier(local)))
        }
        return t.importDeclaration(specifiers, t.stringLiteral(pkg))
      }
      case 'ExportDefaultDeclaration': {
        ctx.hasExportDefault = true
        const { node: inner } = buildExpr(0)
        return t.exportDefaultDeclaration(inner)
      }
      case 'ExportNamedDeclaration': {
        // variants 0..2: variable (var/let/const)
        if (c.variant >= 0 && c.variant <= 2) {
          const kind = VAR_KINDS[c.variant]
          const name = nameFromHash(hash, ctx.scope.length)
          ctx.scope.push(name)
          const { node: init, candidate: initC } = buildExpr(0)
          const inferredType = initC ? inferTypeFromKey(initC.key) : 'any'
          ctx.typedScope.push({ name, type: inferredType })
          const decl = t.variableDeclaration(kind, [t.variableDeclarator(t.identifier(name), init)])
          return t.exportNamedDeclaration(decl, [])
        }
        // variants 10..13: function with param count 0..3
        if (c.variant >= 10 && c.variant <= 13) {
          const paramCount = c.variant - 10
          let fnName = cosmeticFuncName()
          while (ctx.scope.includes(fnName))
            fnName = `${fnName}${ctx.scope.length}`
          const paramNames = Array.from({ length: paramCount }, (_, i) => nameFromHash(hash, 900 + i))
          // Enter function scope
          const savedScope = [...ctx.scope]
          const savedTyped = [...ctx.typedScope]
          const savedFn = ctx.inFunction
          ctx.inFunction = true
          for (const p of paramNames) {
            ctx.scope.push(p)
            ctx.typedScope.push({ name: p, type: 'any' })
          }
          const body = t.blockStatement(buildBlock('FunctionDeclaration', 'body'))
          ctx.scope = savedScope
          ctx.typedScope = savedTyped
          ctx.inFunction = savedFn
          // Bind function name in outer scope
          ctx.scope.push(fnName)
          ctx.typedScope.push({ name: fnName, type: 'function' })
          const fd = t.functionDeclaration(
            t.identifier(fnName),
            paramNames.map(p => t.identifier(p)),
            body,
          )
          return t.exportNamedDeclaration(fd, [])
        }
        return t.emptyStatement()
      }
      case 'ExpressionStatement':
        return t.expressionStatement(buildExpr(0).node)
      default: return t.emptyStatement()
    }
  }

  function buildBlock(parentType: string, slot: string): t.Statement[] {
    if (isPad())
      return []
    const countByte = readBits(8)
    hash = mixHash(hash, countByte)
    ctx.blockDepth++
    const prevBucket = ctx.scopeBucket
    ctx.scopeBucket = deriveScopeBucket(parentType, slot)
    const savedPrev = ctx.prevStmtKey
    ctx.prevStmtKey = '<START>'
    const stmts: t.Statement[] = []
    for (let i = 0; i < countByte; i++) {
      const { stmt, candidate } = buildTopLevelWithCandidate()
      stmts.push(stmt)
      ctx.prevStmtKey = candidate ? bigramKey(candidate.key, candidate.isStatement) : '<START>'
    }
    ctx.prevStmtKey = savedPrev
    ctx.scopeBucket = prevBucket
    ctx.blockDepth--
    return stmts
  }

  function buildTopLevelWithCandidate(): { stmt: t.Statement, candidate: Candidate | null } {
    if (isPad())
      return { stmt: t.expressionStatement(padLeafExpr()), candidate: null }
    const candidates = filterCandidates(ctx)
    const table = buildTable(candidates, hash)
    const bits = bitWidth(table.length)
    const value = readBits(bits)
    const c = table[value]
    hash = mixHash(hash, value)
    return { stmt: buildStatement(c), candidate: c }
  }

  const body: t.Statement[] = []
  while (!isPad()) {
    const { stmt, candidate } = buildTopLevelWithCandidate()
    body.push(stmt)
    ctx.prevStmtKey = candidate ? bigramKey(candidate.key, candidate.isStatement) : '<START>'
  }
  return generateCompact(t.program(body))
}
