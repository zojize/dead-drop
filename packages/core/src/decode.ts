import { parse } from '@babel/parser'
import type * as t from '@babel/types'
import {
  REVERSE_EXPR_TABLE,
  REVERSE_STMT_TABLE,
  exprNodeKey,
  stmtNodeKey,
  BINARY_OP_POOL,
  LOGICAL_OP_POOL,
  UNARY_OP_POOL,
  UPDATE_OP_POOL,
  ASSIGN_OP_POOL,
  VAR_KIND_POOL,
  REGEXP_FLAGS,
  DEFAULT_STMT_POOLS,
} from './tables'
import { stripSuffix } from './pools'

type WorkItem =
  | { kind: 'expr'; node: t.Node }
  | { kind: 'stmt'; node: t.Node }
  | { kind: 'byte'; value: number }

/**
 * Decode JavaScript source code back into the original byte array.
 * Uses an iterative work stack to avoid call-stack overflow on deep ASTs.
 *
 * Expression bytes are recovered purely from AST structure (node types,
 * operators, child counts, flags). No pool parameter needed.
 *
 * Statement bytes use hardcoded DEFAULT_STMT_POOLS for name-based lookups.
 */
export function decode(jsSource: string): Uint8Array {
  const pools = DEFAULT_STMT_POOLS

  // Build fast reverse maps for statement pools
  const varNameRev = new Map<string, number>(pools.varNames.map((v, i) => [v, i]))
  const labelRev = new Map<string, number>(pools.labels.map((v, i) => [v, i]))
  const catchParamRev = new Map<string, number>(pools.catchParams.map((v, i) => [v, i]))

  const ast = parse(jsSource, {
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: [['optionalChainingAssign', { version: '2023-07' }]],
  })

  const bytes: number[] = []
  const work: WorkItem[] = []

  function pushExpr(node: t.Node) { work.push({ kind: 'expr', node }) }
  function pushStmt(node: t.Node) { work.push({ kind: 'stmt', node }) }
  function pushByte(value: number) { work.push({ kind: 'byte', value }) }

  function pushBlockBody(body: readonly t.Node[]) {
    for (let i = body.length - 1; i >= 0; i--) pushStmt(body[i])
    pushByte(body.length)
  }

  /**
   * Convert a RegExp flags string to a 6-bit bitmask.
   */
  function flagsToBitmask(flags: string): number {
    let bitmask = 0
    for (let i = 0; i < REGEXP_FLAGS.length; i++) {
      if (flags.includes(REGEXP_FLAGS[i])) bitmask |= (1 << i)
    }
    return bitmask
  }

  function processExpr(node: t.Node): void {
    switch (node.type) {
      case 'NumericLiteral':
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('NumericLiteral', 0))!)
        break
      case 'StringLiteral':
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('StringLiteral', 0))!)
        break
      case 'Identifier':
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('Identifier', 0))!)
        break
      case 'BooleanLiteral':
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('BooleanLiteral', node.value ? 1 : 0))!)
        break
      case 'NullLiteral':
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('NullLiteral', 0))!)
        break
      case 'BigIntLiteral':
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('BigIntLiteral', 0))!)
        break
      case 'ThisExpression':
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('ThisExpression', 0))!)
        break
      case 'RegExpLiteral': {
        const bitmask = flagsToBitmask(node.flags)
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('RegExpLiteral', bitmask))!)
        break
      }
      case 'BinaryExpression': {
        const opIdx = (BINARY_OP_POOL as readonly string[]).indexOf(node.operator)
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('BinaryExpression', opIdx))!)
        pushExpr(node.right); pushExpr(node.left)
        break
      }
      case 'LogicalExpression': {
        const opIdx = (LOGICAL_OP_POOL as readonly string[]).indexOf(node.operator)
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('LogicalExpression', opIdx))!)
        pushExpr(node.right); pushExpr(node.left)
        break
      }
      case 'UnaryExpression': {
        const opIdx = (UNARY_OP_POOL as readonly string[]).indexOf(node.operator)
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('UnaryExpression', opIdx))!)
        pushExpr(node.argument)
        break
      }
      case 'UpdateExpression': {
        const opIdx = (UPDATE_OP_POOL as readonly string[]).indexOf(node.operator)
        const variant = opIdx * 2 + (node.prefix ? 0 : 1)
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('UpdateExpression', variant))!)
        pushExpr(node.argument)
        break
      }
      case 'ConditionalExpression':
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('ConditionalExpression', 0))!)
        pushExpr(node.alternate); pushExpr(node.consequent); pushExpr(node.test)
        break
      case 'CallExpression': {
        const byte = REVERSE_EXPR_TABLE.get(exprNodeKey('CallExpression', node.arguments.length))
        if (byte === undefined) throw new Error(`Unknown CallExpression argCount: ${node.arguments.length}`)
        bytes.push(byte)
        for (let i = node.arguments.length - 1; i >= 0; i--) pushExpr(node.arguments[i])
        pushExpr(node.callee)
        break
      }
      case 'NewExpression': {
        const byte = REVERSE_EXPR_TABLE.get(exprNodeKey('NewExpression', node.arguments.length))
        if (byte === undefined) throw new Error(`Unknown NewExpression argCount: ${node.arguments.length}`)
        bytes.push(byte)
        for (let i = node.arguments.length - 1; i >= 0; i--) pushExpr(node.arguments[i])
        pushExpr(node.callee)
        break
      }
      case 'MemberExpression': {
        const variant = node.computed ? 1 : 0
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('MemberExpression', variant))!)
        if (node.computed) {
          pushExpr(node.property as t.Expression); pushExpr(node.object)
        } else {
          // non-computed: only object is a data child, property name is cosmetic
          pushExpr(node.object)
        }
        break
      }
      case 'OptionalMemberExpression': {
        const variant = node.computed ? 1 : 0
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('OptionalMemberExpression', variant))!)
        if (node.computed) {
          pushExpr(node.property as t.Expression); pushExpr(node.object)
        } else {
          // non-computed: only object is a data child, property name is cosmetic
          pushExpr(node.object)
        }
        break
      }
      case 'AssignmentExpression': {
        const opIdx = (ASSIGN_OP_POOL as readonly string[]).indexOf(node.operator)
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('AssignmentExpression', opIdx))!)
        pushExpr(node.right)
        break
      }
      case 'ArrayExpression': {
        // Check if this is a SpreadElement wrapper: [...arg]
        if (node.elements.length === 1 && node.elements[0]?.type === 'SpreadElement') {
          bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('SpreadElement', 0))!)
          pushExpr((node.elements[0] as t.SpreadElement).argument)
          break
        }
        const byte = REVERSE_EXPR_TABLE.get(exprNodeKey('ArrayExpression', node.elements.length))
        if (byte === undefined) throw new Error(`Unknown ArrayExpression count: ${node.elements.length}`)
        bytes.push(byte)
        for (let i = node.elements.length - 1; i >= 0; i--) pushExpr(node.elements[i] as t.Expression)
        break
      }
      case 'ObjectExpression': {
        const byte = REVERSE_EXPR_TABLE.get(exprNodeKey('ObjectExpression', node.properties.length))
        if (byte === undefined) throw new Error(`Unknown ObjectExpression count: ${node.properties.length}`)
        bytes.push(byte)
        for (let i = node.properties.length - 1; i >= 0; i--) {
          const p = node.properties[i] as t.ObjectProperty
          pushExpr(p.value as t.Expression); pushExpr(p.key as t.Expression)
        }
        break
      }
      case 'SequenceExpression': {
        const count = node.expressions.length
        const variant = count - 2   // min 2 elements
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('SequenceExpression', variant))!)
        for (let i = count - 1; i >= 0; i--) pushExpr(node.expressions[i])
        break
      }
      case 'TemplateLiteral': {
        const exprCount = node.expressions.length
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('TemplateLiteral', exprCount))!)
        for (let i = exprCount - 1; i >= 0; i--) pushExpr(node.expressions[i])
        break
      }
      case 'TaggedTemplateExpression': {
        const exprCount = node.quasi.expressions.length
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('TaggedTemplateExpression', exprCount))!)
        for (let i = exprCount - 1; i >= 0; i--) pushExpr(node.quasi.expressions[i])
        pushExpr(node.tag)
        break
      }
      case 'ArrowFunctionExpression': {
        const paramCount = node.params.length
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('ArrowFunctionExpression', paramCount))!)
        if (node.body.type === 'BlockStatement') {
          const retStmt = (node.body as t.BlockStatement).body.find(s => s.type === 'ReturnStatement') as t.ReturnStatement | undefined
          if (retStmt?.argument) pushExpr(retStmt.argument)
        } else {
          pushExpr(node.body as t.Expression)
        }
        break
      }
      case 'FunctionExpression': {
        const paramCount = node.params.length
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('FunctionExpression', paramCount))!)
        const body = node.body as t.BlockStatement
        if (body.body.length > 0 && body.body[0].type === 'ReturnStatement') {
          const retStmt = body.body[0] as t.ReturnStatement
          if (retStmt.argument) pushExpr(retStmt.argument)
        }
        break
      }
      case 'ClassExpression': {
        const variant = node.superClass !== null ? 1 : 0
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('ClassExpression', variant))!)
        break
      }
      default:
        throw new Error(`Unknown expression type: ${node.type}`)
    }
  }

  function processStmt(node: t.Node): void {
    switch (node.type) {
      case 'ExpressionStatement':
        bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('ExpressionStatement', 0))!)
        pushExpr((node as t.ExpressionStatement).expression)
        break
      case 'IfStatement': {
        const n = node as t.IfStatement
        const variant = n.alternate === null ? 1 : 0
        bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('IfStatement', variant))!)
        if (variant === 0) pushBlockBody((n.alternate as t.BlockStatement).body)
        pushBlockBody((n.consequent as t.BlockStatement).body)
        pushExpr(n.test)
        break
      }
      case 'WhileStatement': {
        const n = node as t.WhileStatement
        bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('WhileStatement', 0))!)
        pushBlockBody((n.body as t.BlockStatement).body)
        pushExpr(n.test)
        break
      }
      case 'ForStatement': {
        const n = node as t.ForStatement
        const variant = (n.init !== null ? 1 : 0) | (n.test !== null ? 2 : 0) | (n.update !== null ? 4 : 0)
        bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('ForStatement', variant))!)
        pushBlockBody((n.body as t.BlockStatement).body)
        if (n.update !== null) pushExpr(n.update as t.Expression)
        if (n.test !== null) pushExpr(n.test as t.Expression)
        if (n.init !== null) pushExpr(n.init as t.Expression)
        break
      }
      case 'DoWhileStatement': {
        const n = node as t.DoWhileStatement
        bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('DoWhileStatement', 0))!)
        pushBlockBody((n.body as t.BlockStatement).body)
        pushExpr(n.test)
        break
      }
      case 'ReturnStatement':
        bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('ReturnStatement', 0))!)
        pushExpr((node as t.ReturnStatement).argument!)
        break
      case 'ThrowStatement':
        bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('ThrowStatement', 0))!)
        pushExpr((node as t.ThrowStatement).argument)
        break
      case 'BlockStatement': {
        const n = node as t.BlockStatement
        bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('BlockStatement', 0))!)
        bytes.push(n.body.length)
        for (let i = n.body.length - 1; i >= 0; i--) pushStmt(n.body[i])
        break
      }
      case 'EmptyStatement':
        bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('EmptyStatement', 0))!)
        break
      case 'DebuggerStatement':
        bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('DebuggerStatement', 0))!)
        break
      case 'TryStatement': {
        const n = node as t.TryStatement
        const paramName = (n.handler!.param as t.Identifier).name
        const paramIdx = catchParamRev.get(stripSuffix(paramName))
        if (paramIdx === undefined) { bytes.push(0) }
        else { bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('TryStatement', paramIdx))!) }
        pushBlockBody(n.handler!.body.body)
        pushBlockBody(n.block.body)
        break
      }
      case 'SwitchStatement': {
        const n = node as t.SwitchStatement
        const byte = REVERSE_STMT_TABLE.get(stmtNodeKey('SwitchStatement', n.cases.length))
        if (byte === undefined) throw new Error(`Unknown SwitchStatement case count: ${n.cases.length}`)
        bytes.push(byte)
        for (let i = n.cases.length - 1; i >= 0; i--) {
          pushBlockBody(n.cases[i].consequent)
          pushExpr(n.cases[i].test!)
        }
        pushExpr(n.discriminant)
        break
      }
      case 'LabeledStatement': {
        const n = node as t.LabeledStatement
        const baseName = stripSuffix(n.label.name)
        const labelIdx = labelRev.get(baseName)
        if (labelIdx === undefined) { bytes.push(0) }
        else { bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('LabeledStatement', labelIdx))!) }
        pushBlockBody((n.body as t.BlockStatement).body)
        break
      }
      case 'VariableDeclaration': {
        const n = node as t.VariableDeclaration
        const kindIndex = (VAR_KIND_POOL as readonly string[]).indexOf(n.kind)
        const baseName = stripSuffix((n.declarations[0].id as t.Identifier).name)
        const nameIndex = varNameRev.get(baseName)
        if (nameIndex === undefined) { bytes.push(0) }
        else { bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('VariableDeclaration', nameIndex * 3 + kindIndex))!) }
        pushExpr(n.declarations[0].init!)
        break
      }
      default:
        throw new Error(`Unknown statement type: ${node.type}`)
    }
  }

  for (let i = ast.program.body.length - 1; i >= 0; i--) pushStmt(ast.program.body[i])

  while (work.length > 0) {
    const item = work.pop()!
    switch (item.kind) {
      case 'expr': processExpr(item.node); break
      case 'stmt': processStmt(item.node); break
      case 'byte': bytes.push(item.value); break
    }
  }

  if (bytes.length < 4) return new Uint8Array(0)
  const payloadLength = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  return new Uint8Array(bytes.slice(4, 4 + payloadLength))
}
