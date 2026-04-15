import type * as t from '@babel/types'
import type { EncodingContext } from './context'
import { parse } from '@babel/parser'
import {
  ASSIGN_OPS,
  BINARY_OPS,
  bitWidth,
  BitWriter,
  buildReverseTable,
  buildTable,
  deriveScopeBucket,
  filterCandidates,
  inferTypeFromKey,
  initialContext,
  LOGICAL_OPS,
  MAX_EXPR_DEPTH,
  mixHash,
  nameFromHash,
  type ScopeBucket,
  UNARY_OPS,
} from './context'

export interface DecodeOptions {
  /** Structural key — must match the key used during encoding. */
  key?: number
  maxExprDepth?: number
}

type WorkItem
  = | { kind: 'expr', node: t.Node, depth: number }
    | { kind: 'stmt', node: t.Node }
    | { kind: 'block', stmts: readonly t.Statement[] }
    | { kind: 'block-depth-dec' }
    | { kind: 'scope-save', scope: string[], typedScope: any[], inFunction: boolean }
    | { kind: 'scope-restore', scope: string[], typedScope: any[], inFunction: boolean }
    | { kind: 'var-decl', name: string, initNode: t.Node, depth: number }
    | { kind: 'inloop-enter' }
    | { kind: 'inloop-exit', saved: boolean }
    | { kind: 'var-type-push', name: string, type: string }
    | { kind: 'bucket-enter', bucket: ScopeBucket }
    | { kind: 'bucket-exit', prev: ScopeBucket }

export function decode(jsSource: string, options?: DecodeOptions): Uint8Array {
  const ast = parse(jsSource, {
    sourceType: 'module',
    plugins: [['optionalChainingAssign', { version: '2023-07' }]],
  })

  const out = new BitWriter()
  const key = options?.key
  let hash = key != null ? mixHash(0xDEADD, key) : 0xDEADD
  const ctx: EncodingContext = { ...initialContext(), maxExprDepth: options?.maxExprDepth ?? MAX_EXPR_DEPTH }
  const work: WorkItem[] = []

  // ─── Candidate key from parsed node ────────────────────────────────

  function exprKey(node: t.Node): string {
    switch (node.type) {
      case 'NumericLiteral': return 'NumericLiteral:0'
      case 'StringLiteral': return 'StringLiteral:0'
      case 'Identifier': return 'Identifier:0'
      case 'BooleanLiteral': return `BooleanLiteral:${node.value ? 1 : 0}`
      case 'NullLiteral': return 'NullLiteral:0'
      case 'ThisExpression': return 'ThisExpression:0'
      case 'RegExpLiteral': return 'RegExpLiteral:0'
      case 'BinaryExpression': return `BinaryExpression:${(BINARY_OPS as readonly string[]).indexOf(node.operator)}`
      case 'LogicalExpression': return `LogicalExpression:${(LOGICAL_OPS as readonly string[]).indexOf(node.operator)}`
      case 'AssignmentExpression': return `AssignmentExpression:${(ASSIGN_OPS as readonly string[]).indexOf(node.operator)}`
      case 'UnaryExpression': return `UnaryExpression:${(UNARY_OPS as readonly string[]).indexOf(node.operator)}`
      case 'UpdateExpression': return `UpdateExpression:${(node.operator === '++' ? 0 : 1) * 2 + (node.prefix ? 0 : 1)}`
      case 'ConditionalExpression': return 'ConditionalExpression:0'
      case 'CallExpression': return `CallExpression:${node.arguments.length}`
      case 'OptionalCallExpression': return `OptionalCallExpression:${node.arguments.length}`
      case 'NewExpression': return `NewExpression:${node.arguments.length}`
      case 'MemberExpression': return `MemberExpression:${node.computed ? 1 : 0}`
      case 'OptionalMemberExpression': return `OptionalMemberExpression:${node.computed ? 1 : 0}`
      case 'ArrayExpression': {
        if (node.elements.length === 1 && node.elements[0]?.type === 'SpreadElement')
          return 'SpreadElement:0'
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
      case 'VariableDeclaration': return `VariableDeclaration:${node.kind === 'var' ? 0 : node.kind === 'let' ? 1 : 2}`
      case 'IfStatement': return `IfStatement:${(node as t.IfStatement).alternate ? 0 : 1}`
      case 'WhileStatement': return 'WhileStatement:0'
      case 'ForStatement': {
        const n = node as t.ForStatement
        return `ForStatement:${(n.init ? 1 : 0) | (n.test ? 2 : 0) | (n.update ? 4 : 0)}`
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
      case 'ImportDeclaration': {
        const n = node as t.ImportDeclaration
        if (n.specifiers.length === 0)
          return 'ImportDeclaration:sideEffect'
        if (n.specifiers.length === 1 && n.specifiers[0].type === 'ImportDefaultSpecifier')
          return 'ImportDeclaration:default'
        if (n.specifiers.every(s => s.type === 'ImportSpecifier')) {
          const count = n.specifiers.length
          if (count >= 1 && count <= 4)
            return `ImportDeclaration:named:${count}`
        }
        return 'ImportDeclaration:default' // fallback for unusual shapes
      }
      case 'ExportDefaultDeclaration': return 'ExportDefaultDeclaration:0'
      default: return exprKey(node)
    }
  }

  // ─── Push expression children (LIFO order for iterative processing) ─

  function pushExprChildren(node: t.Node, depth: number): void {
    const d = depth + 1
    switch (node.type) {
      case 'BinaryExpression':
      case 'LogicalExpression':
        work.push({ kind: 'expr', node: (node as any).right, depth: d })
        work.push({ kind: 'expr', node: (node as any).left, depth: d })
        break
      case 'AssignmentExpression':
        work.push({ kind: 'expr', node: (node as t.AssignmentExpression).right, depth: d })
        break
      case 'UnaryExpression':
        work.push({ kind: 'expr', node: (node as any).argument, depth: d })
        break
      case 'ConditionalExpression': {
        const n = node as t.ConditionalExpression
        work.push({ kind: 'expr', node: n.alternate, depth: d })
        work.push({ kind: 'expr', node: n.consequent, depth: d })
        work.push({ kind: 'expr', node: n.test, depth: d })
        break
      }
      case 'CallExpression':
      case 'OptionalCallExpression': {
        const n = node as t.CallExpression
        for (let i = n.arguments.length - 1; i >= 0; i--) work.push({ kind: 'expr', node: n.arguments[i], depth: d })
        work.push({ kind: 'expr', node: n.callee, depth: d })
        break
      }
      case 'NewExpression': {
        const n = node as t.NewExpression
        for (let i = n.arguments.length - 1; i >= 0; i--) work.push({ kind: 'expr', node: n.arguments[i], depth: d })
        work.push({ kind: 'expr', node: n.callee, depth: d })
        break
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const n = node as t.MemberExpression
        if (n.computed)
          work.push({ kind: 'expr', node: n.property, depth: d })
        work.push({ kind: 'expr', node: n.object, depth: d })
        break
      }
      case 'ArrayExpression': {
        const n = node as t.ArrayExpression
        if (n.elements.length === 1 && n.elements[0]?.type === 'SpreadElement') {
          work.push({ kind: 'expr', node: (n.elements[0] as t.SpreadElement).argument, depth: d })
        }
        else {
          for (let i = n.elements.length - 1; i >= 0; i--) {
            if (n.elements[i])
              work.push({ kind: 'expr', node: n.elements[i]!, depth: d })
          }
        }
        break
      }
      case 'ObjectExpression':
        for (let i = (node as t.ObjectExpression).properties.length - 1; i >= 0; i--) {
          const p = (node as t.ObjectExpression).properties[i] as t.ObjectProperty
          work.push({ kind: 'expr', node: p.value, depth: d })
          work.push({ kind: 'expr', node: p.key, depth: d })
        }
        break
      case 'SequenceExpression':
        for (let i = (node as t.SequenceExpression).expressions.length - 1; i >= 0; i--)
          work.push({ kind: 'expr', node: (node as t.SequenceExpression).expressions[i], depth: d })
        break
      case 'TemplateLiteral':
        for (let i = (node as t.TemplateLiteral).expressions.length - 1; i >= 0; i--)
          work.push({ kind: 'expr', node: (node as t.TemplateLiteral).expressions[i], depth: d })
        break
      case 'TaggedTemplateExpression': {
        const n = node as t.TaggedTemplateExpression
        for (let i = n.quasi.expressions.length - 1; i >= 0; i--)
          work.push({ kind: 'expr', node: n.quasi.expressions[i], depth: d })
        work.push({ kind: 'expr', node: n.tag, depth: d })
        break
      }
      case 'ArrowFunctionExpression': {
        const n = node as t.ArrowFunctionExpression
        const params = n.params.map((_, i) => nameFromHash(hash, 900 + i))
        work.push({ kind: 'scope-restore', scope: [...ctx.scope], typedScope: [...ctx.typedScope], inFunction: ctx.inFunction })
        work.push({ kind: 'bucket-exit', prev: ctx.scopeBucket })
        const bodyNode = n.body.type === 'BlockStatement'
          ? ((n.body as t.BlockStatement).body[0] as t.ReturnStatement)?.argument
          : n.body
        if (bodyNode)
          work.push({ kind: 'expr', node: bodyNode, depth: d })
        work.push({ kind: 'bucket-enter', bucket: 'function-body' })
        // Push scope-save AFTER body (LIFO: save executes first)
        work.push({ kind: 'scope-save', scope: params, typedScope: params.map(p => ({ name: p, type: 'any' })), inFunction: true })
        break
      }
      case 'FunctionExpression': {
        const n = node as t.FunctionExpression
        const params = n.params.map((_, i) => nameFromHash(hash, 900 + i))
        work.push({ kind: 'scope-restore', scope: [...ctx.scope], typedScope: [...ctx.typedScope], inFunction: ctx.inFunction })
        work.push({ kind: 'bucket-exit', prev: ctx.scopeBucket })
        const ret = n.body.body[0]
        if (ret?.type === 'ReturnStatement')
          work.push({ kind: 'expr', node: (ret as t.ReturnStatement).argument!, depth: d })
        work.push({ kind: 'bucket-enter', bucket: 'function-body' })
        work.push({ kind: 'scope-save', scope: params, typedScope: params.map(p => ({ name: p, type: 'any' })), inFunction: true })
        break
      }
      case 'ClassExpression':
        if ((node as t.ClassExpression).superClass)
          work.push({ kind: 'expr', node: (node as t.ClassExpression).superClass!, depth: d })
        break
      case 'AwaitExpression':
        work.push({ kind: 'expr', node: (node as t.AwaitExpression).argument, depth: d })
        break
      // UpdateExpression, leaves: no children
    }
  }

  // ─── Push statement children ───────────────────────────────────────

  function pushStmtChildren(node: t.Node): void {
    switch (node.type) {
      case 'ExpressionStatement':
        // Expression was directly selected as a candidate in statement context
        pushExprChildren((node as t.ExpressionStatement).expression, 0)
        break
      case 'VariableDeclaration': {
        const n = node as t.VariableDeclaration
        const name = nameFromHash(hash, ctx.scope.length)
        ctx.scope.push(name)
        work.push({ kind: 'var-decl', name, initNode: n.declarations[0].init!, depth: 0 })
        break
      }
      case 'IfStatement': {
        const n = node as t.IfStatement
        if (n.alternate) {
          work.push({ kind: 'bucket-exit', prev: ctx.scopeBucket })
          work.push({ kind: 'block', stmts: (n.alternate as t.BlockStatement).body })
          work.push({ kind: 'bucket-enter', bucket: deriveScopeBucket('IfStatement', 'alternate') })
        }
        work.push({ kind: 'bucket-exit', prev: ctx.scopeBucket })
        work.push({ kind: 'block', stmts: (n.consequent as t.BlockStatement).body })
        work.push({ kind: 'bucket-enter', bucket: deriveScopeBucket('IfStatement', 'consequent') })
        work.push({ kind: 'expr', node: n.test, depth: 0 })
        break
      }
      case 'WhileStatement': {
        const n = node as t.WhileStatement
        // LIFO order: test → inloop-enter → bucket-enter → block → bucket-exit → inloop-exit
        work.push({ kind: 'inloop-exit', saved: ctx.inLoop })
        work.push({ kind: 'bucket-exit', prev: ctx.scopeBucket })
        work.push({ kind: 'block', stmts: (n.body as t.BlockStatement).body })
        work.push({ kind: 'bucket-enter', bucket: deriveScopeBucket('WhileStatement', 'body') })
        work.push({ kind: 'inloop-enter' })
        work.push({ kind: 'expr', node: n.test, depth: 0 })
        break
      }
      case 'ForStatement': {
        const n = node as t.ForStatement
        // LIFO order: init → test → update → inloop-enter → bucket-enter → block → bucket-exit → inloop-exit
        work.push({ kind: 'inloop-exit', saved: ctx.inLoop })
        work.push({ kind: 'bucket-exit', prev: ctx.scopeBucket })
        work.push({ kind: 'block', stmts: (n.body as t.BlockStatement).body })
        work.push({ kind: 'bucket-enter', bucket: deriveScopeBucket('ForStatement', 'body') })
        work.push({ kind: 'inloop-enter' })
        if (n.update)
          work.push({ kind: 'expr', node: n.update, depth: 0 })
        if (n.test)
          work.push({ kind: 'expr', node: n.test, depth: 0 })
        if (n.init)
          work.push({ kind: 'expr', node: n.init as t.Expression, depth: 0 })
        break
      }
      case 'DoWhileStatement': {
        const n = node as t.DoWhileStatement
        // LIFO order: inloop-enter → bucket-enter → block → bucket-exit → inloop-exit → test
        work.push({ kind: 'expr', node: n.test, depth: 0 })
        work.push({ kind: 'inloop-exit', saved: ctx.inLoop })
        work.push({ kind: 'bucket-exit', prev: ctx.scopeBucket })
        work.push({ kind: 'block', stmts: (n.body as t.BlockStatement).body })
        work.push({ kind: 'bucket-enter', bucket: deriveScopeBucket('DoWhileStatement', 'body') })
        work.push({ kind: 'inloop-enter' })
        break
      }
      case 'BlockStatement':
        work.push({ kind: 'bucket-exit', prev: ctx.scopeBucket })
        work.push({ kind: 'block', stmts: (node as t.BlockStatement).body })
        work.push({ kind: 'bucket-enter', bucket: deriveScopeBucket('BlockStatement', 'body') })
        break
      case 'TryStatement': {
        const n = node as t.TryStatement
        // Catch body (pushed first = drained last)
        work.push({ kind: 'bucket-exit', prev: ctx.scopeBucket })
        work.push({ kind: 'block', stmts: n.handler!.body.body })
        work.push({ kind: 'bucket-enter', bucket: deriveScopeBucket('CatchClause', 'body') })
        // Try block (pushed second = drained first)
        work.push({ kind: 'bucket-exit', prev: ctx.scopeBucket })
        work.push({ kind: 'block', stmts: n.block.body })
        work.push({ kind: 'bucket-enter', bucket: deriveScopeBucket('TryStatement', 'block') })
        break
      }
      case 'SwitchStatement': {
        const n = node as t.SwitchStatement
        for (let i = n.cases.length - 1; i >= 0; i--) {
          work.push({ kind: 'bucket-exit', prev: ctx.scopeBucket })
          work.push({ kind: 'block', stmts: n.cases[i].consequent })
          work.push({ kind: 'bucket-enter', bucket: deriveScopeBucket('SwitchCase', 'consequent') })
          if (n.cases[i].test)
            work.push({ kind: 'expr', node: n.cases[i].test!, depth: 0 })
        }
        work.push({ kind: 'expr', node: n.discriminant, depth: 0 })
        break
      }
      case 'LabeledStatement':
        work.push({ kind: 'bucket-exit', prev: ctx.scopeBucket })
        work.push({ kind: 'block', stmts: ((node as t.LabeledStatement).body as t.BlockStatement).body })
        work.push({ kind: 'bucket-enter', bucket: deriveScopeBucket('LabeledStatement', 'body') })
        break
      case 'ThrowStatement':
        work.push({ kind: 'expr', node: (node as t.ThrowStatement).argument, depth: 0 })
        break
      case 'ReturnStatement':
        if ((node as t.ReturnStatement).argument)
          work.push({ kind: 'expr', node: (node as t.ReturnStatement).argument!, depth: 0 })
        break
      case 'ImportDeclaration': {
        const n = node as t.ImportDeclaration
        for (const spec of n.specifiers) {
          if (spec.local && spec.local.type === 'Identifier') {
            ctx.scope.push(spec.local.name)
            ctx.typedScope.push({ name: spec.local.name, type: 'any' })
          }
        }
        break
      }
      case 'ExportDefaultDeclaration': {
        const n = node as t.ExportDefaultDeclaration
        work.push({ kind: 'expr', node: n.declaration as t.Node, depth: 0 })
        break
      }
    }
  }

  // ─── Main iterative loop ───────────────────────────────────────────

  // Seed with top-level statements (reverse for LIFO)
  for (let i = ast.program.body.length - 1; i >= 0; i--)
    work.push({ kind: 'stmt', node: ast.program.body[i] })

  while (work.length > 0) {
    const item = work.pop()!

    switch (item.kind) {
      case 'expr': {
        const exprCtx = { ...ctx, expressionOnly: true, exprDepth: item.depth }
        const candidates = filterCandidates(exprCtx)
        const table = buildTable(candidates, hash)
        const bits = bitWidth(table.length)
        const rev = buildReverseTable(table)
        const key = exprKey(item.node)
        const value = rev.get(key)
        if (value !== undefined) {
          out.write(value, bits)
          hash = mixHash(hash, value)
        }
        else {
          out.write(0, bits)
          hash = mixHash(hash, 0)
        }
        // At max depth, children are cosmetic — don't recurse
        if (ctx.maxExprDepth === Infinity || item.depth < ctx.maxExprDepth) {
          pushExprChildren(item.node, item.depth)
        }
        break
      }

      case 'stmt': {
        const candidates = filterCandidates(ctx)
        const table = buildTable(candidates, hash)
        const bits = bitWidth(table.length)
        const rev = buildReverseTable(table)
        // ExpressionStatement: always use the inner expression's key
        const key = item.node.type === 'ExpressionStatement'
          ? exprKey((item.node as t.ExpressionStatement).expression)
          : stmtKey(item.node)
        const value = rev.get(key)
        if (value !== undefined) {
          out.write(value, bits)
          hash = mixHash(hash, value)
        }
        else {
          out.write(0, bits)
          hash = mixHash(hash, 0)
        }
        pushStmtChildren(item.node)
        break
      }

      case 'block': {
        out.write(item.stmts.length, 8)
        hash = mixHash(hash, item.stmts.length)
        ctx.blockDepth++
        work.push({ kind: 'block-depth-dec' })
        for (let i = item.stmts.length - 1; i >= 0; i--)
          work.push({ kind: 'stmt', node: item.stmts[i] })
        break
      }

      case 'block-depth-dec':
        ctx.blockDepth--
        break

      case 'inloop-enter':
        ctx.inLoop = true
        break

      case 'inloop-exit':
        ctx.inLoop = item.saved
        break

      case 'var-type-push':
        ctx.typedScope.push({ name: item.name, type: item.type as any })
        break

      case 'scope-save':
        for (const p of item.scope) ctx.scope.push(p)
        for (const e of item.typedScope) ctx.typedScope.push(e)
        ctx.inFunction = item.inFunction
        break

      case 'scope-restore':
        ctx.scope = item.scope
        ctx.typedScope = item.typedScope
        ctx.inFunction = item.inFunction
        break

      case 'bucket-enter':
        ctx.scopeBucket = item.bucket
        break

      case 'bucket-exit':
        ctx.scopeBucket = item.prev
        break

      case 'var-decl': {
        // Process the init expression and infer type
        const exprCtx = { ...ctx, expressionOnly: true, exprDepth: item.depth }
        const candidates = filterCandidates(exprCtx)
        const table = buildTable(candidates, hash)
        const bits = bitWidth(table.length)
        const rev = buildReverseTable(table)
        const key = exprKey(item.initNode)
        const value = rev.get(key)
        if (value !== undefined) {
          out.write(value, bits)
          hash = mixHash(hash, value)
        }
        else {
          out.write(0, bits)
          hash = mixHash(hash, 0)
        }
        // Defer typed scope push: children must see scope BEFORE this variable's type
        // (matches encoder which builds children before updating typedScope)
        const inferredType = inferTypeFromKey(key)
        work.push({ kind: 'var-type-push', name: item.name, type: inferredType })
        if (ctx.maxExprDepth === Infinity || item.depth < ctx.maxExprDepth) {
          pushExprChildren(item.initNode, item.depth)
        }
        break
      }
    }
  }

  // Convert recovered bits back to bytes
  const bytes = out.toBytes()
  if (bytes.length < 4)
    return new Uint8Array(0)
  const payloadLength = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  return new Uint8Array(bytes.slice(4, 4 + payloadLength))
}
