import { parse } from '@babel/parser'
import type * as t from '@babel/types'
import {
  type Candidate,
  type EncodingContext,
  initialContext,
  filterCandidates,
  buildTable,
  buildReverseTable,
  mixHash,
  nameFromHash,
  BINARY_OPS,
  LOGICAL_OPS,
  UNARY_OPS,
  UPDATE_OPS,
  ASSIGN_OPS,
  REGEXP_FLAGS,
} from './context'

/**
 * Decode JavaScript source code back into the original byte array.
 *
 * Rebuilds the same dynamic context-dependent tables the encoder used,
 * recovering bytes from AST structure. No options needed.
 */
export function decode(jsSource: string): Uint8Array {
  const ast = parse(jsSource, {
    plugins: [['optionalChainingAssign', { version: '2023-07' }]],
  })

  const bytes: number[] = []
  let hash = 0xDEADD
  const ctx: EncodingContext = initialContext()

  // ─── Identify a candidate key from a parsed AST node ───────────────

  function exprKey(node: t.Node): string {
    switch (node.type) {
      case 'NumericLiteral': return 'NumericLiteral:0'
      case 'StringLiteral': return 'StringLiteral:0'
      case 'Identifier': return 'Identifier:0'
      case 'BooleanLiteral': return `BooleanLiteral:${node.value ? 1 : 0}`
      case 'NullLiteral': return 'NullLiteral:0'
      case 'BigIntLiteral': return 'BigIntLiteral:0'
      case 'ThisExpression': return 'ThisExpression:0'
      case 'RegExpLiteral': {
        let bitmask = 0
        const flags = node.flags || ''
        for (let i = 0; i < REGEXP_FLAGS.length; i++) {
          if (flags.includes(REGEXP_FLAGS[i])) bitmask |= (1 << i)
        }
        return `RegExpLiteral:${bitmask}`
      }
      case 'BinaryExpression': {
        const idx = (BINARY_OPS as readonly string[]).indexOf(node.operator)
        return `BinaryExpression:${idx}`
      }
      case 'LogicalExpression': {
        const idx = (LOGICAL_OPS as readonly string[]).indexOf(node.operator)
        return `LogicalExpression:${idx}`
      }
      case 'AssignmentExpression': {
        const idx = (ASSIGN_OPS as readonly string[]).indexOf(node.operator)
        return `AssignmentExpression:${idx}`
      }
      case 'UnaryExpression': {
        const idx = (UNARY_OPS as readonly string[]).indexOf(node.operator)
        return `UnaryExpression:${idx}`
      }
      case 'UpdateExpression': {
        const opOff = node.operator === '++' ? 0 : 1
        return `UpdateExpression:${opOff * 2 + (node.prefix ? 0 : 1)}`
      }
      case 'ConditionalExpression': return 'ConditionalExpression:0'
      case 'CallExpression': return `CallExpression:${node.arguments.length}`
      case 'NewExpression': return `NewExpression:${node.arguments.length}`
      case 'MemberExpression': return `MemberExpression:${node.computed ? 1 : 0}`
      case 'OptionalMemberExpression': return `OptionalMemberExpression:${node.computed ? 1 : 0}`
      case 'ArrayExpression': {
        // SpreadElement check: [...expr] → SpreadElement
        if (node.elements.length === 1 && node.elements[0]?.type === 'SpreadElement') {
          return 'SpreadElement:0'
        }
        return `ArrayExpression:${node.elements.length}`
      }
      case 'ObjectExpression': return `ObjectExpression:${node.properties.length}`
      case 'SequenceExpression': return `SequenceExpression:${node.expressions.length - 2}`
      case 'TemplateLiteral': return `TemplateLiteral:${node.expressions.length}`
      case 'TaggedTemplateExpression': return `TaggedTemplateExpression:${node.quasi.expressions.length}`
      case 'ArrowFunctionExpression': return `ArrowFunctionExpression:${node.params.length}`
      case 'FunctionExpression': return `FunctionExpression:${node.params.length}`
      case 'ClassExpression': return `ClassExpression:${node.superClass ? 1 : 0}`
      case 'AwaitExpression': return 'AwaitExpression:0'
      default: return 'NumericLiteral:0'
    }
  }

  function stmtKey(node: t.Node): string {
    switch (node.type) {
      case 'ExpressionStatement': return 'ExpressionStatement:0'
      case 'VariableDeclaration': {
        const kind = (node as t.VariableDeclaration).kind
        const idx = kind === 'var' ? 0 : kind === 'let' ? 1 : 2
        return `VariableDeclaration:${idx}`
      }
      case 'IfStatement': return `IfStatement:${(node as t.IfStatement).alternate ? 0 : 1}`
      case 'WhileStatement': return 'WhileStatement:0'
      case 'ForStatement': {
        const n = node as t.ForStatement
        const v = (n.init ? 1 : 0) | (n.test ? 2 : 0) | (n.update ? 4 : 0)
        return `ForStatement:${v}`
      }
      case 'DoWhileStatement': return 'DoWhileStatement:0'
      case 'BlockStatement': return 'BlockStatement:0'
      case 'TryStatement': return 'TryStatement:0'
      case 'SwitchStatement': return `SwitchStatement:${(node as t.SwitchStatement).cases.length}`
      case 'LabeledStatement': return 'LabeledStatement:0'
      case 'ThrowStatement': return 'ThrowStatement:0'
      case 'ReturnStatement': return 'ReturnStatement:0'
      case 'EmptyStatement': return 'EmptyStatement:0'
      case 'DebuggerStatement': return 'DebuggerStatement:0'
      case 'BreakStatement': return 'BreakStatement:0'
      case 'ContinueStatement': return 'ContinueStatement:0'
      default:
        // Expression in statement position
        return exprKey(node)
    }
  }

  // ─── Process expression children ───────────────────────────────────

  function processExprChildren(node: t.Node): void {
    switch (node.type) {
      case 'BinaryExpression':
      case 'LogicalExpression':
        processExpr((node as any).left)
        processExpr((node as any).right)
        break
      case 'AssignmentExpression':
        processExpr((node as t.AssignmentExpression).right)
        break
      case 'UnaryExpression':
        processExpr((node as any).argument)
        break
      case 'UpdateExpression':
        // Leaf — operand is cosmetic, no children to process
        break
      case 'ConditionalExpression': {
        const n = node as t.ConditionalExpression
        processExpr(n.test); processExpr(n.consequent); processExpr(n.alternate)
        break
      }
      case 'CallExpression': {
        const n = node as t.CallExpression
        processExpr(n.callee)
        for (const arg of n.arguments) processExpr(arg)
        break
      }
      case 'NewExpression': {
        const n = node as t.NewExpression
        processExpr(n.callee)
        for (const arg of n.arguments) processExpr(arg)
        break
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const n = node as t.MemberExpression
        processExpr(n.object)
        if (n.computed) processExpr(n.property)
        break
      }
      case 'ArrayExpression': {
        const n = node as t.ArrayExpression
        if (n.elements.length === 1 && n.elements[0]?.type === 'SpreadElement') {
          processExpr((n.elements[0] as t.SpreadElement).argument)
        } else {
          for (const el of n.elements) if (el) processExpr(el)
        }
        break
      }
      case 'ObjectExpression': {
        const n = node as t.ObjectExpression
        for (const prop of n.properties) {
          const p = prop as t.ObjectProperty
          processExpr(p.key); processExpr(p.value)
        }
        break
      }
      case 'SequenceExpression':
        for (const e of (node as t.SequenceExpression).expressions) processExpr(e)
        break
      case 'TemplateLiteral':
        for (const e of (node as t.TemplateLiteral).expressions) processExpr(e)
        break
      case 'TaggedTemplateExpression': {
        const n = node as t.TaggedTemplateExpression
        processExpr(n.tag)
        for (const e of n.quasi.expressions) processExpr(e)
        break
      }
      case 'ArrowFunctionExpression': {
        const n = node as t.ArrowFunctionExpression
        if (n.body.type === 'BlockStatement') {
          const ret = n.body.body[0]
          if (ret?.type === 'ReturnStatement') processExpr((ret as t.ReturnStatement).argument!)
        } else {
          processExpr(n.body)
        }
        break
      }
      case 'FunctionExpression': {
        const n = node as t.FunctionExpression
        const ret = n.body.body[0]
        if (ret?.type === 'ReturnStatement') processExpr((ret as t.ReturnStatement).argument!)
        break
      }
      case 'ClassExpression': {
        const n = node as t.ClassExpression
        if (n.superClass) processExpr(n.superClass)
        break
      }
      case 'AwaitExpression':
        processExpr((node as t.AwaitExpression).argument)
        break
      // Leaves: no children
    }
  }

  // ─── Process expression: lookup byte from dynamic table ────────────

  function processExpr(node: t.Node): void {
    const exprCtx = { ...ctx, expressionOnly: true }
    const candidates = filterCandidates(exprCtx)
    const table = buildTable(candidates, hash)
    const rev = buildReverseTable(table)

    const key = exprKey(node)
    const byte = rev.get(key)
    if (byte !== undefined) {
      bytes.push(byte)
      hash = mixHash(hash, byte)
    } else {
      bytes.push(0) // unknown entry in padding territory
      hash = mixHash(hash, 0)
    }

    processExprChildren(node)
  }

  // ─── Process block: count byte + N statements ──────────────────────

  function processBlock(stmts: readonly t.Statement[]): void {
    const countByte = stmts.length // recover the count byte
    bytes.push(countByte)
    hash = mixHash(hash, countByte)
    for (const stmt of stmts) {
      processStatement(stmt)
    }
  }

  // ─── Process statement: lookup byte from dynamic table ─────────────

  function processStatement(node: t.Node): void {
    const candidates = filterCandidates(ctx)
    const table = buildTable(candidates, hash)
    const rev = buildReverseTable(table)

    // For ExpressionStatement: the byte might map to an EXPRESSION candidate
    // (wrapped in ExpressionStatement) or the statement entry ExpressionStatement:0.
    // Try expression key of inner expression FIRST (most entries are expressions),
    // then fall back to statement key.
    let byte: number | undefined
    if (node.type === 'ExpressionStatement') {
      const innerKey = exprKey((node as t.ExpressionStatement).expression)
      byte = rev.get(innerKey)
      if (byte === undefined) {
        byte = rev.get(stmtKey(node))
      }
    } else {
      byte = rev.get(stmtKey(node))
    }

    if (byte !== undefined) {
      bytes.push(byte)
      hash = mixHash(hash, byte)
    } else {
      bytes.push(0)
      hash = mixHash(hash, 0)
    }

    // Process children based on statement type
    switch (node.type) {
      case 'ExpressionStatement': {
        // If the byte mapped to an expression candidate, the expression
        // children were already consumed. If it mapped to ExpressionStatement:0,
        // we need to process the inner expression.
        const innerKey = exprKey((node as t.ExpressionStatement).expression)
        const stKey = stmtKey(node)
        // Check which key was used by looking at the table entry
        const entry = byte !== undefined ? table[byte] : null
        if (entry && entry.isStatement) {
          // It was ExpressionStatement:0 — process inner expression
          processExpr((node as t.ExpressionStatement).expression)
        } else {
          // It was an expression candidate — process expression children only
          processExprChildren((node as t.ExpressionStatement).expression)
        }
        break
      }
      case 'VariableDeclaration': {
        const n = node as t.VariableDeclaration
        const name = nameFromHash(hash, ctx.scope.length)
        ctx.scope.push(name)
        processExpr(n.declarations[0].init!)
        break
      }
      case 'IfStatement': {
        const n = node as t.IfStatement
        processExpr(n.test)
        processBlock((n.consequent as t.BlockStatement).body)
        if (n.alternate) processBlock((n.alternate as t.BlockStatement).body)
        break
      }
      case 'WhileStatement': {
        const n = node as t.WhileStatement
        processExpr(n.test)
        const savedInLoop = ctx.inLoop
        ctx.inLoop = true
        processBlock((n.body as t.BlockStatement).body)
        ctx.inLoop = savedInLoop
        break
      }
      case 'ForStatement': {
        const n = node as t.ForStatement
        if (n.init) processExpr(n.init as t.Expression)
        if (n.test) processExpr(n.test)
        if (n.update) processExpr(n.update)
        const savedInLoop = ctx.inLoop
        ctx.inLoop = true
        processBlock((n.body as t.BlockStatement).body)
        ctx.inLoop = savedInLoop
        break
      }
      case 'DoWhileStatement': {
        const n = node as t.DoWhileStatement
        const savedInLoop = ctx.inLoop
        ctx.inLoop = true
        processBlock((n.body as t.BlockStatement).body)
        ctx.inLoop = savedInLoop
        processExpr(n.test)
        break
      }
      case 'BlockStatement':
        processBlock((node as t.BlockStatement).body)
        break
      case 'TryStatement': {
        const n = node as t.TryStatement
        processBlock(n.block.body)
        processBlock(n.handler!.body.body)
        break
      }
      case 'SwitchStatement': {
        const n = node as t.SwitchStatement
        processExpr(n.discriminant)
        for (const c of n.cases) {
          if (c.test) processExpr(c.test)
          processBlock(c.consequent)
        }
        break
      }
      case 'LabeledStatement': {
        const n = node as t.LabeledStatement
        processBlock((n.body as t.BlockStatement).body)
        break
      }
      case 'ThrowStatement':
        processExpr((node as t.ThrowStatement).argument)
        break
      case 'ReturnStatement':
        processExpr((node as t.ReturnStatement).argument!)
        break
      // EmptyStatement, DebuggerStatement, BreakStatement, ContinueStatement: no children
    }
  }

  // ─── Main ──────────────────────────────────────────────────────────

  for (const stmt of ast.program.body) {
    processStatement(stmt)
  }

  if (bytes.length < 4) return new Uint8Array(0)
  const payloadLength = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  return new Uint8Array(bytes.slice(4, 4 + payloadLength))
}
