import { parse } from '@babel/parser'
import type * as t from '@babel/types'
import {
  REVERSE_EXPR_TABLE,
  exprNodeKey,
  BINARY_OP_POOL,
  LOGICAL_OP_POOL,
  UNARY_OP_POOL,
  ASSIGN_OP_POOL,
  REGEXP_FLAGS,
} from './tables'

type WorkItem = { node: t.Node }

/**
 * Decode JavaScript source code back into the original byte array.
 *
 * ALL data is recovered from AST structure (node types, operators,
 * child counts, flags). Literal values are ignored. No options needed.
 */
export function decode(jsSource: string): Uint8Array {
  const ast = parse(jsSource, {
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: [['optionalChainingAssign', { version: '2023-07' }]],
  })

  const bytes: number[] = []
  const work: WorkItem[] = []

  function push(node: t.Node) { work.push({ node }) }

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
        let bitmask = 0
        const flags = node.flags || ''
        for (let i = 0; i < REGEXP_FLAGS.length; i++) {
          if (flags.includes(REGEXP_FLAGS[i])) bitmask |= (1 << i)
        }
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('RegExpLiteral', bitmask))!)
        break
      }
      case 'BinaryExpression': {
        const opIdx = (BINARY_OP_POOL as readonly string[]).indexOf(node.operator)
        if (opIdx === -1) { bytes.push(0); break }
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('BinaryExpression', opIdx))!)
        push(node.right); push(node.left)
        break
      }
      case 'LogicalExpression': {
        const opIdx = (LOGICAL_OP_POOL as readonly string[]).indexOf(node.operator)
        if (opIdx === -1) { bytes.push(0); break }
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('LogicalExpression', opIdx))!)
        push(node.right); push(node.left)
        break
      }
      case 'AssignmentExpression': {
        const opIdx = (ASSIGN_OP_POOL as readonly string[]).indexOf(node.operator)
        if (opIdx === -1) { bytes.push(0); break }
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('AssignmentExpression', opIdx))!)
        push(node.right)
        break
      }
      case 'UnaryExpression': {
        const opIdx = (UNARY_OP_POOL as readonly string[]).indexOf(node.operator)
        if (opIdx === -1) { bytes.push(0); break }
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('UnaryExpression', opIdx))!)
        push(node.argument)
        break
      }
      case 'UpdateExpression': {
        const opOff = node.operator === '++' ? 0 : 1
        const variant = opOff * 2 + (node.prefix ? 0 : 1)
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('UpdateExpression', variant))!)
        push(node.argument)
        break
      }
      case 'ConditionalExpression':
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('ConditionalExpression', 0))!)
        push(node.alternate); push(node.consequent); push(node.test)
        break
      case 'CallExpression': {
        const byte = REVERSE_EXPR_TABLE.get(exprNodeKey('CallExpression', node.arguments.length))
        if (byte === undefined) { bytes.push(0); break }
        bytes.push(byte)
        for (let i = node.arguments.length - 1; i >= 0; i--) push(node.arguments[i])
        push(node.callee)
        break
      }
      case 'NewExpression': {
        const byte = REVERSE_EXPR_TABLE.get(exprNodeKey('NewExpression', node.arguments.length))
        if (byte === undefined) { bytes.push(0); break }
        bytes.push(byte)
        for (let i = node.arguments.length - 1; i >= 0; i--) push(node.arguments[i])
        push(node.callee)
        break
      }
      case 'MemberExpression': {
        const variant = node.computed ? 1 : 0
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('MemberExpression', variant))!)
        if (node.computed) { push(node.property); push(node.object) }
        else { push(node.object) }
        break
      }
      case 'OptionalMemberExpression': {
        const variant = node.computed ? 1 : 0
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('OptionalMemberExpression', variant))!)
        if (node.computed) { push(node.property); push(node.object) }
        else { push(node.object) }
        break
      }
      case 'ArrayExpression': {
        // SpreadElement check: [... expr] → SpreadElement byte
        if (node.elements.length === 1 && node.elements[0]?.type === 'SpreadElement') {
          bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('SpreadElement', 0))!)
          push((node.elements[0] as t.SpreadElement).argument)
          break
        }
        const byte = REVERSE_EXPR_TABLE.get(exprNodeKey('ArrayExpression', node.elements.length))
        if (byte === undefined) { bytes.push(0); break }
        bytes.push(byte)
        for (let i = node.elements.length - 1; i >= 0; i--) push(node.elements[i] as t.Expression)
        break
      }
      case 'ObjectExpression': {
        const byte = REVERSE_EXPR_TABLE.get(exprNodeKey('ObjectExpression', node.properties.length))
        if (byte === undefined) { bytes.push(0); break }
        bytes.push(byte)
        for (let i = node.properties.length - 1; i >= 0; i--) {
          const p = node.properties[i] as t.ObjectProperty
          push(p.value); push(p.key)
        }
        break
      }
      case 'SequenceExpression': {
        const variant = node.expressions.length - 2
        const byte = REVERSE_EXPR_TABLE.get(exprNodeKey('SequenceExpression', variant))
        if (byte === undefined) { bytes.push(0); break }
        bytes.push(byte)
        for (let i = node.expressions.length - 1; i >= 0; i--) push(node.expressions[i])
        break
      }
      case 'TemplateLiteral': {
        const exprCount = node.expressions.length
        const byte = REVERSE_EXPR_TABLE.get(exprNodeKey('TemplateLiteral', exprCount))
        if (byte === undefined) { bytes.push(0); break }
        bytes.push(byte)
        for (let i = node.expressions.length - 1; i >= 0; i--) push(node.expressions[i])
        break
      }
      case 'TaggedTemplateExpression': {
        const exprCount = node.quasi.expressions.length
        const byte = REVERSE_EXPR_TABLE.get(exprNodeKey('TaggedTemplateExpression', exprCount))
        if (byte === undefined) { bytes.push(0); break }
        bytes.push(byte)
        for (let i = node.quasi.expressions.length - 1; i >= 0; i--) push(node.quasi.expressions[i])
        push(node.tag)
        break
      }
      case 'ArrowFunctionExpression': {
        const paramCount = node.params.length
        const byte = REVERSE_EXPR_TABLE.get(exprNodeKey('ArrowFunctionExpression', paramCount))
        if (byte === undefined) { bytes.push(0); break }
        bytes.push(byte)
        // Body is either an expression or a block with return
        if (node.body.type === 'BlockStatement') {
          const ret = (node.body as t.BlockStatement).body[0]
          if (ret?.type === 'ReturnStatement') push((ret as t.ReturnStatement).argument!)
          else push(node.body)
        } else {
          push(node.body)
        }
        break
      }
      case 'FunctionExpression': {
        const paramCount = node.params.length
        const byte = REVERSE_EXPR_TABLE.get(exprNodeKey('FunctionExpression', paramCount))
        if (byte === undefined) { bytes.push(0); break }
        bytes.push(byte)
        // Body is block with return statement
        const ret = node.body.body[0]
        if (ret?.type === 'ReturnStatement') push((ret as t.ReturnStatement).argument!)
        break
      }
      case 'ClassExpression': {
        const variant = node.superClass !== null ? 1 : 0
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('ClassExpression', variant))!)
        if (node.superClass) push(node.superClass)
        break
      }
      default:
        // Unknown node type in padding territory — push 0
        bytes.push(0)
    }
  }

  // Process each top-level statement — only ExpressionStatements carry data
  for (let i = ast.program.body.length - 1; i >= 0; i--) {
    const stmt = ast.program.body[i]
    if (stmt.type === 'ExpressionStatement') {
      push((stmt as t.ExpressionStatement).expression)
    }
  }

  // Drain work stack
  while (work.length > 0) {
    processExpr(work.pop()!.node)
  }

  if (bytes.length < 4) return new Uint8Array(0)
  const payloadLength = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  return new Uint8Array(bytes.slice(4, 4 + payloadLength))
}
