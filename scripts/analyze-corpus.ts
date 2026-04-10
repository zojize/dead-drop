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

const counts = new Map<string, number>()
function inc(key: string) {
  counts.set(key, (counts.get(key) ?? 0) + 1)
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
    default: return null
  }
}

function walk(node: any): void {
  if (!node || typeof node !== 'object')
    return
  const ek = exprKey(node)
  if (ek)
    inc(ek)
  const sk = stmtKey(node)
  if (sk && !ek)
    inc(sk)
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments')
      continue
    const val = node[key]
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === 'object' && item.type)
          walk(item)
      }
    }
    else if (val && typeof val === 'object' && val.type) {
      walk(val)
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

let totalNodes = 0
let parsedFiles = 0
let failedFiles = 0

for (let i = 0; i < jsFiles.length; i++) {
  if (i % 500 === 0 && i > 0) {
    process.stdout.write(`  [${i}/${jsFiles.length}] ${totalNodes} nodes so far...\r`)
  }
  try {
    const code = readFileSync(jsFiles[i], 'utf8')
    const ast = parse(code, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: ['jsx', 'typescript', ['optionalChainingAssign', { version: '2023-07' }]],
    })
    const before = [...counts.values()].reduce((a, b) => a + b, 0)
    walk(ast.program)
    totalNodes += [...counts.values()].reduce((a, b) => a + b, 0) - before
    parsedFiles++
  }
  catch {
    failedFiles++
  }
}

console.log(`\nParsed ${parsedFiles} files (${failedFiles} failed), ${totalNodes} total nodes\n`)

// Sort by frequency and print top results
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
console.log('=== Top 80 frequencies ===')
for (const [key, count] of sorted.slice(0, 80)) {
  const pct = ((count / totalNodes) * 100).toFixed(2)
  const bar = '█'.repeat(Math.ceil(Number(pct) * 2))
  console.log(`  ${key.padEnd(30)} ${String(count).padStart(10)}  ${pct.padStart(6)}%  ${bar}`)
}

// Output weight map
const maxCount = sorted[0][1]
const weights: Record<string, number> = {}
for (const [key, count] of sorted) {
  // Scale to 0.01-10 range, with minimum 0.01 for any observed candidate
  weights[key] = Math.max(0.01, Math.round((count / maxCount) * 1000) / 100)
}

// Write to JSON file for use in context.ts
const outPath = join(process.cwd(), 'packages/core/src/corpus-weights.json')
writeFileSync(outPath, `${JSON.stringify(weights, null, 2)}\n`)
console.log(`\nWeights written to ${outPath}`)
console.log(`${Object.keys(weights).length} unique candidate keys observed`)

// Cleanup
execSync(`rm -rf "${tmpDir}"`)
console.log('Temp dir cleaned up')
