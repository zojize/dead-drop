import { parse } from '@babel/parser'
import type * as t from '@babel/types'
import {
  REVERSE_EXPR_TABLE,
  REVERSE_STMT_TABLE,
  exprNodeKey,
  stmtNodeKey,
  BINARY_OP_POOL,
  UNARY_OP_POOL,
  ASSIGN_OP_POOL,
  VAR_KIND_POOL,
  DEFAULT_POOLS,
} from './tables'
import { type Pools, stripSuffix } from './pools'

export interface DecodeOptions {
  /** Custom pools matching the encoder's pools. Must match for correct decoding. */
  pools?: Partial<Pools>
}

type WorkItem =
  | { kind: 'expr'; node: t.Node }
  | { kind: 'stmt'; node: t.Node }
  | { kind: 'byte'; value: number }

/**
 * Decode JavaScript source code back into the original byte array.
 * Uses an iterative work stack to avoid call-stack overflow on deep ASTs.
 */
export function decode(jsSource: string, options?: DecodeOptions): Uint8Array {
  const pools: Pools = { ...DEFAULT_POOLS, ...options?.pools }

  // Build fast reverse maps from the pools
  const numericRev = new Map<number, number>(pools.numbers.map((v, i) => [v, i]))
  const identRev = new Map<string, number>(pools.identifiers.map((v, i) => [v, i]))
  const stringRev = new Map<string, number>(pools.strings.map((v, i) => [v, i]))
  const varNameRev = new Map<string, number>(pools.varNames.map((v, i) => [v, i]))
  const labelRev = new Map<string, number>(pools.labels.map((v, i) => [v, i]))
  const catchParamRev = new Map<string, number>(pools.catchParams.map((v, i) => [v, i]))
  const memberPropRev = new Map<string, number>(pools.memberProps.map((v, i) => [v, i]))

  const ast = parse(jsSource, {
    allowReturnOutsideFunction: true,
    errorRecovery: true,
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

  function processExpr(node: t.Node): void {
    switch (node.type) {
      case 'NumericLiteral': {
        const variant = numericRev.get(node.value)
        bytes.push(variant !== undefined ? REVERSE_EXPR_TABLE.get(exprNodeKey('NumericLiteral', variant))! : 0)
        break
      }
      case 'Identifier': {
        const variant = identRev.get(node.name)
        bytes.push(variant !== undefined ? REVERSE_EXPR_TABLE.get(exprNodeKey('Identifier', variant))! : 0)
        break
      }
      case 'BinaryExpression': {
        const opIdx = (BINARY_OP_POOL as readonly string[]).indexOf(node.operator)
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('BinaryExpression', opIdx))!)
        pushExpr(node.right); pushExpr(node.left)
        break
      }
      case 'UnaryExpression': {
        const opIdx = (UNARY_OP_POOL as readonly string[]).indexOf(node.operator)
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('UnaryExpression', opIdx))!)
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
      case 'MemberExpression':
        if (node.computed) {
          bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('MemberExpression', 8))!)
          pushExpr(node.property); pushExpr(node.object)
        } else {
          const propName = (node.property as t.Identifier).name
          const propIdx = memberPropRev.get(propName)
          bytes.push(propIdx !== undefined ? REVERSE_EXPR_TABLE.get(exprNodeKey('MemberExpression', propIdx))! : 0)
          pushExpr(node.object)
        }
        break
      case 'StringLiteral': {
        const variant = stringRev.get(node.value)
        bytes.push(variant !== undefined ? REVERSE_EXPR_TABLE.get(exprNodeKey('StringLiteral', variant))! : 0)
        break
      }
      case 'AssignmentExpression': {
        const opIdx = (ASSIGN_OP_POOL as readonly string[]).indexOf(node.operator)
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('AssignmentExpression', opIdx))!)
        pushExpr(node.right)
        break
      }
      case 'ArrayExpression': {
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
          pushExpr(p.value); pushExpr(p.key)
        }
        break
      }
      case 'BooleanLiteral':
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('BooleanLiteral', node.value ? 1 : 0))!)
        break
      case 'NullLiteral':
        bytes.push(REVERSE_EXPR_TABLE.get(exprNodeKey('NullLiteral', 0))!)
        break
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
        pushStmt(n.body); pushExpr(n.test)
        break
      }
      case 'ForStatement': {
        const n = node as t.ForStatement
        const variant = (n.init !== null ? 1 : 0) | (n.test !== null ? 2 : 0) | (n.update !== null ? 4 : 0)
        bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('ForStatement', variant))!)
        pushStmt(n.body)
        if (n.update !== null) pushExpr(n.update as t.Expression)
        if (n.test !== null) pushExpr(n.test as t.Expression)
        if (n.init !== null) pushExpr(n.init as t.Expression)
        break
      }
      case 'DoWhileStatement': {
        const n = node as t.DoWhileStatement
        bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('DoWhileStatement', 0))!)
        pushStmt(n.body); pushExpr(n.test)
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
        // Strip suffix to recover base label name → variant → byte
        const baseName = stripSuffix(n.label.name)
        const labelIdx = labelRev.get(baseName)
        if (labelIdx === undefined) { bytes.push(0) }
        else { bytes.push(REVERSE_STMT_TABLE.get(stmtNodeKey('LabeledStatement', labelIdx))!) }
        pushStmt(n.body)
        break
      }
      case 'VariableDeclaration': {
        const n = node as t.VariableDeclaration
        const kindIndex = (VAR_KIND_POOL as readonly string[]).indexOf(n.kind)
        // Strip suffix to recover base var name → variant → byte
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
