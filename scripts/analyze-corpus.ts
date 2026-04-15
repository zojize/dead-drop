import type * as t from '@babel/types'
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
/**
 * Analyze AST node frequencies from real JavaScript code.
 * Installs top npm packages into a temp directory and parses
 * all .js files in node_modules.
 *
 * Usage: bun run scripts/analyze-corpus.ts
 */
import { parse } from '@babel/parser'
import { deriveScopeBucket } from '../packages/core/src/context'

type ScopeBucket = 'top-level' | 'function-body' | 'loop-body' | 'block-body'

const BINARY_OPS = ['+', '-', '*', '/', '%', '|', '&', '^', '<<', '>>', '>>>', '==', '!=', '<', '>', 'in'] as const
const LOGICAL_OPS = ['&&', '||', '??'] as const
const UNARY_OPS = ['-', '+', '~', '!', 'typeof', 'void', 'delete'] as const
const ASSIGN_OPS = ['=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '<<=', '>>=', '>>>=', '**=', '??=', '||=', '&&='] as const

// Top npm packages by weekly downloads (diverse categories)
const PACKAGES = [
  // Frameworks & runtime
  'react',
  'react-dom',
  'vue',
  'svelte',
  'preact',
  'next',
  'nuxt',
  // Utilities
  'lodash',
  'underscore',
  'ramda',
  'date-fns',
  'moment',
  'dayjs',
  // HTTP & networking
  'axios',
  'node-fetch',
  'got',
  'superagent',
  // Build tools & bundlers (have lots of JS)
  'webpack',
  'esbuild',
  'rollup',
  'vite',
  'terser',
  'swc',
  // Testing
  'jest',
  'mocha',
  'chai',
  'sinon',
  // Data visualization
  'chart.js',
  'd3',
  'three',
  'pixi.js',
  // State management
  'redux',
  'mobx',
  'zustand',
  'jotai',
  // CSS-in-JS
  'styled-components',
  'emotion',
  // Validation
  'zod',
  'joi',
  'yup',
  'ajv',
  // Markdown & parsing
  'marked',
  'highlight.js',
  'prismjs',
  // Database
  'mongoose',
  'sequelize',
  'knex',
  'typeorm',
  'drizzle-orm',
  // Express ecosystem
  'express',
  'koa',
  'fastify',
  'hapi',
  // Auth
  'jsonwebtoken',
  'passport',
  'bcrypt',
  // File & path
  'glob',
  'minimatch',
  'chokidar',
  'fs-extra',
  // CLI
  'commander',
  'yargs',
  'chalk',
  'inquirer',
  'ora',
  // Misc popular
  'rxjs',
  'fp-ts',
  'immer',
  'uuid',
  'nanoid',
  'socket.io',
  'ws',
  'graphql',
  'apollo-server',
  'prettier',
  'eslint',
  'typescript',
  'sharp',
  'jimp',
  'pdf-lib',
  'cheerio',
  'puppeteer-core',
  'playwright-core',
]

const counts: Record<ScopeBucket, Map<string, number>> = {
  'top-level': new Map(),
  'function-body': new Map(),
  'loop-body': new Map(),
  'block-body': new Map(),
}
const globalCounts = new Map<string, number>()

function inc(bucket: ScopeBucket, key: string) {
  counts[bucket].set(key, (counts[bucket].get(key) ?? 0) + 1)
  globalCounts.set(key, (globalCounts.get(key) ?? 0) + 1)
}

function exprKey(node: t.Node): string | null {
  switch (node.type) {
    case 'NumericLiteral': return 'NumericLiteral:0'
    case 'StringLiteral': return 'StringLiteral:0'
    case 'Identifier': return 'Identifier:0'
    case 'BooleanLiteral': return `BooleanLiteral:${node.value ? 1 : 0}`
    case 'NullLiteral': return 'NullLiteral:0'
    case 'ThisExpression': return 'ThisExpression:0'
    case 'RegExpLiteral': return 'RegExpLiteral:0'
    case 'BigIntLiteral': return 'BigIntLiteral:0'
    case 'BinaryExpression': {
      const i = (BINARY_OPS as readonly string[]).indexOf(node.operator)
      return i >= 0 ? `BinaryExpression:${i}` : null
    }
    case 'LogicalExpression': {
      const i = (LOGICAL_OPS as readonly string[]).indexOf(node.operator)
      return i >= 0 ? `LogicalExpression:${i}` : null
    }
    case 'AssignmentExpression': {
      const i = (ASSIGN_OPS as readonly string[]).indexOf(node.operator)
      return i >= 0 ? `AssignmentExpression:${i}` : null
    }
    case 'UnaryExpression': {
      const i = (UNARY_OPS as readonly string[]).indexOf(node.operator)
      return i >= 0 ? `UnaryExpression:${i}` : null
    }
    case 'UpdateExpression':
      return `UpdateExpression:${(node.operator === '++' ? 0 : 1) * 2 + (node.prefix ? 0 : 1)}`
    case 'ConditionalExpression': return 'ConditionalExpression:0'
    case 'CallExpression': return `CallExpression:${Math.min(node.arguments.length, 18)}`
    case 'OptionalCallExpression': return `OptionalCallExpression:${Math.min(node.arguments.length, 18)}`
    case 'NewExpression': return `NewExpression:${Math.min(node.arguments.length, 15)}`
    case 'MemberExpression': return `MemberExpression:${node.computed ? 1 : 0}`
    case 'OptionalMemberExpression': return `OptionalMemberExpression:${node.computed ? 1 : 0}`
    case 'ArrayExpression': return `ArrayExpression:${Math.min(node.elements.length, 31)}`
    case 'ObjectExpression': return `ObjectExpression:${Math.min(node.properties.length, 31)}`
    case 'SequenceExpression': {
      const n = node.expressions.length
      return n >= 2 && n <= 29 ? `SequenceExpression:${n - 2}` : null
    }
    case 'TemplateLiteral': return `TemplateLiteral:${Math.min(node.expressions.length, 16)}`
    case 'TaggedTemplateExpression': return `TaggedTemplateExpression:${Math.min(node.quasi.expressions.length, 7)}`
    case 'ArrowFunctionExpression': return `ArrowFunctionExpression:${Math.min(node.params.length, 23)}`
    case 'FunctionExpression': return `FunctionExpression:${Math.min(node.params.length, 23)}`
    case 'SpreadElement': return 'SpreadElement:0'
    case 'ClassExpression': return `ClassExpression:${node.superClass ? 1 : 0}`
    case 'AwaitExpression': return 'AwaitExpression:0'
    default: return null
  }
}

function stmtKey(node: t.Node): string | null {
  switch (node.type) {
    case 'VariableDeclaration': return `VariableDeclaration:${node.kind === 'var' ? 0 : node.kind === 'let' ? 1 : 2}`
    case 'IfStatement': return `IfStatement:${node.alternate ? 0 : 1}`
    case 'WhileStatement': return 'WhileStatement:0'
    case 'ForStatement': {
      const n = node as t.ForStatement
      return `ForStatement:${(n.init ? 1 : 0) | (n.test ? 2 : 0) | (n.update ? 4 : 0)}`
    }
    case 'DoWhileStatement': return 'DoWhileStatement:0'
    case 'BlockStatement': return 'BlockStatement:0'
    case 'TryStatement': return 'TryStatement:0'
    case 'SwitchStatement': return `SwitchStatement:${Math.min((node as t.SwitchStatement).cases.length, 15)}`
    case 'LabeledStatement': return 'LabeledStatement:0'
    case 'ThrowStatement': return 'ThrowStatement:0'
    case 'ReturnStatement': return 'ReturnStatement:0'
    case 'EmptyStatement': return 'EmptyStatement:0'
    case 'DebuggerStatement': return 'DebuggerStatement:0'
    case 'BreakStatement': return 'BreakStatement:0'
    case 'ContinueStatement': return 'ContinueStatement:0'
    case 'ExpressionStatement': return 'ExpressionStatement:0'
    case 'ImportDeclaration': {
      const n = node as t.ImportDeclaration
      if (n.specifiers.length === 0) return 'ImportDeclaration:sideEffect'
      if (n.specifiers.length === 1 && n.specifiers[0].type === 'ImportDefaultSpecifier') return 'ImportDeclaration:default'
      if (n.specifiers.every(s => s.type === 'ImportSpecifier')) {
        const count = Math.min(n.specifiers.length, 4)
        return count >= 1 ? `ImportDeclaration:named:${count}` : null
      }
      return null
    }
    case 'ExportDefaultDeclaration': return 'ExportDefaultDeclaration:0'
    case 'ExportNamedDeclaration': {
      const n = node as t.ExportNamedDeclaration
      if (n.declaration?.type === 'VariableDeclaration') {
        const kind = n.declaration.kind
        const variant = kind === 'var' ? 0 : kind === 'let' ? 1 : 2
        return `ExportNamedDeclaration:variable:${variant}`
      }
      if (n.declaration?.type === 'FunctionDeclaration') {
        const paramCount = Math.min(n.declaration.params.length, 3)
        return `ExportNamedDeclaration:function:${paramCount}`
      }
      return null
    }
    default: return null
  }
}

/**
 * True if (parentType, slot) is a slot whose contents are statements
 * (a block, a case consequent, a function body, etc.) — i.e., one where
 * the scope bucket actually changes per the deriveScopeBucket rules.
 * Other slots (tests, conditions, init expressions) inherit the parent bucket.
 */
function isStatementSlot(parentType: string, slot: string): boolean {
  if (parentType === 'Program' && slot === 'body') return true
  if ((parentType === 'FunctionDeclaration' || parentType === 'FunctionExpression' || parentType === 'ArrowFunctionExpression') && slot === 'body') return true
  if ((parentType === 'ForStatement' || parentType === 'WhileStatement' || parentType === 'DoWhileStatement' || parentType === 'ForOfStatement' || parentType === 'ForInStatement') && slot === 'body') return true
  if (parentType === 'IfStatement' && (slot === 'consequent' || slot === 'alternate')) return true
  if (parentType === 'BlockStatement' && slot === 'body') return true
  if (parentType === 'TryStatement' && (slot === 'block' || slot === 'handler' || slot === 'finalizer')) return true
  if (parentType === 'CatchClause' && slot === 'body') return true
  if (parentType === 'SwitchCase' && slot === 'consequent') return true
  if (parentType === 'LabeledStatement' && slot === 'body') return true
  return false
}

function walk(node: any, bucket: ScopeBucket): void {
  if (!node || typeof node !== 'object')
    return
  const ek = exprKey(node)
  if (ek)
    inc(bucket, ek)
  const sk = stmtKey(node)
  if (sk && !ek)
    inc(bucket, sk)

  for (const slot of Object.keys(node)) {
    if (slot === 'type' || slot === 'start' || slot === 'end' || slot === 'loc' || slot === 'extra' || slot === 'leadingComments' || slot === 'trailingComments')
      continue
    const val = node[slot]
    // Derive child bucket for slots that introduce a new statement context.
    // For expression slots (init, test, update, etc.), inherit parent bucket —
    // weights for expressions are counted in whatever statement-level bucket
    // they appear in.
    const childBucket: ScopeBucket = isStatementSlot(node.type, slot)
      ? deriveScopeBucket(node.type, slot)
      : bucket

    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object' && item.type)
          walk(item, childBucket)
      }
    }
    else if (val && typeof val === 'object' && val.type) {
      walk(val, childBucket)
    }
  }
}

/** Recursively find all .js files (skip .min.js and huge files) */
function findJsFiles(dir: string, files: string[] = [], depth = 0): string[] {
  if (depth > 8)
    return files
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.') || entry === 'test' || entry === 'tests' || entry === '__tests__')
        continue
      const full = join(dir, entry)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          findJsFiles(full, files, depth + 1)
        }
        else if (entry.endsWith('.js') && !entry.endsWith('.min.js') && st.size < 500_000 && st.size > 100) {
          files.push(full)
        }
      }
      catch {}
    }
  }
  catch {}
  return files
}

// Create temp dir and install packages
const tmpDir = mkdtempSync(join(tmpdir(), 'dd-corpus-'))
console.log(`Installing ${PACKAGES.length} packages into ${tmpDir}...`)
execSync(`cd "${tmpDir}" && npm init -y --silent 2>/dev/null && npm install --silent --no-audit --no-fund ${PACKAGES.join(' ')} 2>&1 | tail -3`, {
  stdio: ['pipe', 'inherit', 'inherit'],
  timeout: 300_000,
})

// Find all JS files
console.log('Finding JS files...')
const jsFiles = findJsFiles(join(tmpDir, 'node_modules'))
console.log(`Found ${jsFiles.length} JS files\n`)

let parsedFiles = 0
let failedFiles = 0

for (let i = 0; i < jsFiles.length; i++) {
  if (i % 500 === 0 && i > 0) {
    process.stdout.write(`  [${i}/${jsFiles.length}]\r`)
  }
  try {
    const code = readFileSync(jsFiles[i], 'utf8')
    const ast = parse(code, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: ['jsx', 'typescript', ['optionalChainingAssign', { version: '2023-07' }]],
    })
    walk(ast.program, 'top-level')
    parsedFiles++
  }
  catch {
    failedFiles++
  }
}

console.log(`\nParsed ${parsedFiles} files (${failedFiles} failed)\n`)

// Print summary per bucket
console.log('\n=== Per-bucket top 20 ===')
for (const bucket of ['top-level', 'function-body', 'loop-body', 'block-body'] as ScopeBucket[]) {
  const sorted = [...counts[bucket].entries()].sort((a, b) => b[1] - a[1])
  console.log(`\n--- ${bucket} ---`)
  for (const [key, count] of sorted.slice(0, 20)) {
    const totalInBucket = [...counts[bucket].values()].reduce((a, b) => a + b, 0)
    const pct = totalInBucket > 0 ? ((count / totalInBucket) * 100).toFixed(2) : '0.00'
    console.log(`  ${key.padEnd(30)} ${String(count).padStart(10)}  ${pct.padStart(6)}%`)
  }
}

// Build bucketed weight output
function toWeights(m: Map<string, number>): Record<string, number> {
  if (m.size === 0) return {}
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1])
  const maxCount = sorted[0][1]
  const out: Record<string, number> = {}
  for (const [key, count] of sorted) {
    out[key] = Math.max(0.01, Math.round((count / maxCount) * 1000) / 100)
  }
  return out
}

const nested = {
  'top-level': toWeights(counts['top-level']),
  'function-body': toWeights(counts['function-body']),
  'loop-body': toWeights(counts['loop-body']),
  'block-body': toWeights(counts['block-body']),
  global: toWeights(globalCounts),
}

const outPath = join(process.cwd(), 'packages/core/src/corpus-weights.json')
writeFileSync(outPath, `${JSON.stringify(nested, null, 2)}\n`)
console.log(`\nWeights written to ${outPath}`)
console.log(`Sizes — top-level: ${Object.keys(nested['top-level']).length}, function-body: ${Object.keys(nested['function-body']).length}, loop-body: ${Object.keys(nested['loop-body']).length}, block-body: ${Object.keys(nested['block-body']).length}, global: ${Object.keys(nested.global).length}`)

// Cleanup
execSync(`rm -rf "${tmpDir}"`)
console.log('Temp dir cleaned up')
