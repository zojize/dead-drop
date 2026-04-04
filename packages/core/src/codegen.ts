/**
 * Iterative JavaScript code generator for the dead-drop AST subset.
 * Replaces @babel/generator to avoid stack overflow on deeply nested trees.
 * Produces compact output with conservative parenthesization.
 */
import type * as t from '@babel/types'

type GenItem =
  | { kind: 'expr'; node: t.Expression }
  | { kind: 'stmt'; node: t.Statement }
  | { kind: 'raw'; text: string }

export function generateCompact(program: t.Program): string {
  const parts: string[] = []
  const work: GenItem[] = []

  function raw(text: string) { work.push({ kind: 'raw', text }) }
  function expr(node: t.Expression) { work.push({ kind: 'expr', node }) }
  function stmt(node: t.Statement) { work.push({ kind: 'stmt', node }) }

  /** Push items in reverse so they're processed left-to-right (LIFO). */
  function stmtList(nodes: readonly t.Statement[], sep = '') {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (sep && i < nodes.length - 1) raw(sep)
      stmt(nodes[i])
    }
  }

  /** Wrap an expression in parens unless it's a simple leaf. */
  function parenExpr(node: t.Expression) {
    // ObjectExpression is NOT a leaf for parens — {a:1} at statement level
    // parses as a block with label, not an object literal
    // RegExpLiteral is NOT a leaf for parens — /x/g//y/ creates a comment
    const leaf = node.type === 'NumericLiteral' || node.type === 'StringLiteral'
      || node.type === 'Identifier' || node.type === 'BooleanLiteral'
      || node.type === 'NullLiteral' || node.type === 'ArrayExpression'
      || node.type === 'BigIntLiteral' || node.type === 'ThisExpression'
      || node.type === 'TemplateLiteral'
    if (leaf) { expr(node); return }
    raw(')'); expr(node); raw('(')
  }

  function processExpr(node: t.Expression): void {
    switch (node.type) {
      case 'NumericLiteral':
        parts.push(String(node.value))
        break
      case 'StringLiteral':
        parts.push(JSON.stringify(node.value))
        break
      case 'Identifier':
        parts.push(node.name)
        break
      case 'BooleanLiteral':
        parts.push(node.value ? 'true' : 'false')
        break
      case 'NullLiteral':
        parts.push('null')
        break
      case 'BigIntLiteral':
        parts.push(node.value + 'n')
        break
      case 'ThisExpression':
        parts.push('this')
        break
      case 'RegExpLiteral':
        parts.push('/' + node.pattern + '/' + node.flags)
        break
      case 'BinaryExpression': {
        const op = /^[a-z]/i.test(node.operator) ? ` ${node.operator} ` : node.operator
        raw(')'); parenExpr(node.right as t.Expression); raw(op); parenExpr(node.left as t.Expression); raw('(')
        break
      }
      case 'LogicalExpression': {
        raw(')'); parenExpr(node.right as t.Expression); raw(node.operator); parenExpr(node.left as t.Expression); raw('(')
        break
      }
      case 'UnaryExpression':
        raw(')'); parenExpr(node.argument as t.Expression); raw(node.operator.length > 1 ? node.operator + ' (' : node.operator + '(')
        break
      case 'UpdateExpression':
        if (node.prefix) {
          raw(')'); parenExpr(node.argument as t.Expression); raw(node.operator + '(')
        } else {
          raw(')'); raw(node.operator); parenExpr(node.argument as t.Expression); raw('(')
        }
        break
      case 'ConditionalExpression':
        raw(')'); parenExpr(node.alternate as t.Expression)
        raw(':'); parenExpr(node.consequent as t.Expression)
        raw('?'); parenExpr(node.test as t.Expression)
        raw('(')
        break
      case 'CallExpression': {
        raw(')')
        const args = node.arguments as t.Expression[]
        for (let i = args.length - 1; i >= 0; i--) {
          if (i < args.length - 1) raw(',')
          expr(args[i])
        }
        raw('('); parenExpr(node.callee as t.Expression)
        break
      }
      case 'NewExpression': {
        raw(')')
        const args = node.arguments as t.Expression[]
        for (let i = args.length - 1; i >= 0; i--) {
          if (i < args.length - 1) raw(',')
          expr(args[i])
        }
        raw('('); parenExpr(node.callee as t.Expression); raw('new ')
        break
      }
      case 'MemberExpression':
        if (node.computed) {
          raw(']'); expr(node.property as t.Expression); raw('[')
          parenExpr(node.object as t.Expression)
        } else {
          // Always paren the object — avoids `42.log` being parsed as float
          raw('.' + (node.property as t.Identifier).name)
          raw(')'); expr(node.object as t.Expression); raw('(')
        }
        break
      case 'OptionalMemberExpression':
        if (node.computed) {
          raw(']'); expr(node.property as t.Expression); raw('?.[')
          parenExpr(node.object as t.Expression)
        } else {
          raw('?.' + (node.property as t.Identifier).name)
          raw(')'); expr(node.object as t.Expression); raw('(')
        }
        break
      case 'AssignmentExpression':
        raw(')'); parenExpr(node.right as t.Expression)
        raw(node.operator); expr(node.left as t.Expression)
        raw('(')
        break
      case 'ArrayExpression': {
        raw(']')
        const els = node.elements as (t.Expression | t.SpreadElement)[]
        for (let i = els.length - 1; i >= 0; i--) {
          if (i < els.length - 1) raw(',')
          if (els[i].type === 'SpreadElement') {
            expr((els[i] as t.SpreadElement).argument); raw('...')
          } else {
            expr(els[i] as t.Expression)
          }
        }
        raw('[')
        break
      }
      case 'ObjectExpression': {
        raw('})')
        const props = node.properties as t.ObjectProperty[]
        for (let i = props.length - 1; i >= 0; i--) {
          if (i < props.length - 1) raw(',')
          parenExpr(props[i].value as t.Expression); raw(':')
          if (props[i].computed) {
            raw(']'); parenExpr(props[i].key as t.Expression); raw('[')
          } else {
            parenExpr(props[i].key as t.Expression)
          }
        }
        raw('({')
        break
      }
      case 'SequenceExpression': {
        raw(')')
        const exprs = node.expressions
        for (let i = exprs.length - 1; i >= 0; i--) {
          if (i < exprs.length - 1) raw(',')
          expr(exprs[i])
        }
        raw('(')
        break
      }
      case 'TemplateLiteral': {
        raw('`')
        const quasis = node.quasis
        const exprs = node.expressions as t.Expression[]
        // Template: `quasi0${expr0}quasi1${expr1}quasi2`
        // Push in reverse for LIFO
        for (let i = quasis.length - 1; i >= 0; i--) {
          raw(quasis[i].value.raw)
          if (i > 0) {
            raw('}'); expr(exprs[i - 1]); raw('${')
          }
        }
        raw('`')
        break
      }
      case 'TaggedTemplateExpression': {
        // tag`quasi0${expr0}quasi1`
        const tpl = node.quasi
        raw('`')
        const quasis = tpl.quasis
        const exprs = tpl.expressions as t.Expression[]
        for (let i = quasis.length - 1; i >= 0; i--) {
          raw(quasis[i].value.raw)
          if (i > 0) {
            raw('}'); expr(exprs[i - 1]); raw('${')
          }
        }
        raw('`'); parenExpr(node.tag as t.Expression)
        break
      }
      case 'ArrowFunctionExpression': {
        const params = node.params as t.Identifier[]
        raw(')'); expr(node.body as t.Expression)
        raw('=>')
        if (params.length === 1) {
          raw(params[0].name)
        } else {
          raw(')')
          for (let i = params.length - 1; i >= 0; i--) {
            if (i < params.length - 1) raw(',')
            raw(params[i].name)
          }
          raw('(')
        }
        raw('(')
        break
      }
      case 'FunctionExpression': {
        const params = node.params as t.Identifier[]
        const body = node.body as t.BlockStatement
        raw(')')
        raw('}')
        stmtList(body.body)
        raw('){')
        for (let i = params.length - 1; i >= 0; i--) {
          if (i < params.length - 1) raw(',')
          raw(params[i].name)
        }
        raw('(function(')
        break
      }
      case 'ClassExpression': {
        if (node.superClass) {
          // (class extends Super{})
          raw(')')
          raw('{}')
          parenExpr(node.superClass as t.Expression)
          raw('(class extends ')
        } else {
          raw('(class{})')
        }
        break
      }
      default:
        parts.push('0') // fallback
    }
  }

  function processStmt(node: t.Statement): void {
    switch (node.type) {
      case 'ExpressionStatement':
        raw(';'); expr((node as t.ExpressionStatement).expression)
        break
      case 'IfStatement': {
        const n = node as t.IfStatement
        if (n.alternate) {
          // else block
          raw('}'); stmtList((n.alternate as t.BlockStatement).body); raw('else{')
        }
        raw('}'); stmtList((n.consequent as t.BlockStatement).body)
        raw('){'); parenExpr(n.test as t.Expression); raw('if(')
        break
      }
      case 'WhileStatement': {
        const n = node as t.WhileStatement
        stmt(n.body); raw(')'); parenExpr(n.test as t.Expression); raw('while(')
        break
      }
      case 'ForStatement': {
        const n = node as t.ForStatement
        stmt(n.body); raw(')')
        if (n.update) expr(n.update as t.Expression)
        raw(';')
        if (n.test) expr(n.test as t.Expression)
        raw(';')
        if (n.init) expr(n.init as t.Expression)
        raw('for(')
        break
      }
      case 'DoWhileStatement': {
        const n = node as t.DoWhileStatement
        raw(');'); parenExpr(n.test as t.Expression); raw('while(')
        stmt(n.body); raw('do ')
        break
      }
      case 'ReturnStatement':
        raw(';'); expr((node as t.ReturnStatement).argument as t.Expression); raw('return ')
        break
      case 'ThrowStatement':
        raw(';'); expr((node as t.ThrowStatement).argument as t.Expression); raw('throw ')
        break
      case 'BlockStatement': {
        const n = node as t.BlockStatement
        raw('}'); stmtList(n.body); raw('{')
        break
      }
      case 'EmptyStatement':
        raw(';')
        break
      case 'DebuggerStatement':
        raw('debugger;')
        break
      case 'TryStatement': {
        const n = node as t.TryStatement
        raw('}'); stmtList(n.handler!.body.body)
        raw('){'); raw((n.handler!.param as t.Identifier).name); raw('}catch(')
        stmtList(n.block.body); raw('try{')
        break
      }
      case 'SwitchStatement': {
        const n = node as t.SwitchStatement
        raw('}')
        for (let i = n.cases.length - 1; i >= 0; i--) {
          const c = n.cases[i]
          stmtList(c.consequent)
          raw(':'); expr(c.test as t.Expression); raw('case ')
        }
        raw('){'); parenExpr(n.discriminant as t.Expression); raw('switch(')
        break
      }
      case 'LabeledStatement': {
        const n = node as t.LabeledStatement
        stmt(n.body); raw(n.label.name + ':')
        break
      }
      case 'VariableDeclaration': {
        const n = node as t.VariableDeclaration
        const d = n.declarations[0]
        raw(';'); expr(d.init as t.Expression)
        raw(n.kind + ' ' + (d.id as t.Identifier).name + '=')
        break
      }
      default:
        raw(';0') // fallback
    }
  }

  // Seed with top-level statements in reverse
  for (let i = program.body.length - 1; i >= 0; i--) {
    stmt(program.body[i] as t.Statement)
  }

  // Drain iteratively
  while (work.length > 0) {
    const item = work.pop()!
    switch (item.kind) {
      case 'expr': processExpr(item.node); break
      case 'stmt': processStmt(item.node); break
      case 'raw': parts.push(item.text); break
    }
  }

  return parts.join('')
}
