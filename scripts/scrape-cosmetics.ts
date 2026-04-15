/**
 * Scrape cosmetic data from real JavaScript code:
 * - Common identifier names (variable names, function names, properties)
 * - Common string literal values
 * - Common numeric literal values
 * - Global built-in methods with arg counts
 *
 * Usage: bun run scripts/scrape-cosmetics.ts
 */
import { execSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { parse } from '@babel/parser'

const PACKAGES = [
  'react',
  'react-dom',
  'vue',
  'svelte',
  'preact',
  'lodash',
  'underscore',
  'ramda',
  'date-fns',
  'moment',
  'dayjs',
  'axios',
  'node-fetch',
  'got',
  'webpack',
  'rollup',
  'vite',
  'terser',
  'jest',
  'mocha',
  'chai',
  'chart.js',
  'd3',
  'three',
  'redux',
  'mobx',
  'zustand',
  'zod',
  'joi',
  'ajv',
  'marked',
  'highlight.js',
  'mongoose',
  'sequelize',
  'knex',
  'express',
  'koa',
  'fastify',
  'jsonwebtoken',
  'glob',
  'minimatch',
  'chokidar',
  'fs-extra',
  'commander',
  'yargs',
  'chalk',
  'rxjs',
  'immer',
  'uuid',
  'ws',
  'graphql',
  'prettier',
  'eslint',
  'typescript',
  'cheerio',
]

// Counters
const identNames = new Map<string, number>()
const propNames = new Map<string, number>()
const stringValues = new Map<string, number>()
const numberValues = new Map<string, number>()
const funcNames = new Map<string, number>()
const packageNames = new Map<string, number>()
const importedNames = new Map<string, number>()

// JS keywords to exclude from identifier lists
const KEYWORDS = new Set([
  'break',
  'case',
  'catch',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'finally',
  'for',
  'function',
  'if',
  'in',
  'instanceof',
  'new',
  'return',
  'switch',
  'this',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'class',
  'const',
  'enum',
  'export',
  'extends',
  'import',
  'super',
  'implements',
  'interface',
  'let',
  'package',
  'private',
  'protected',
  'public',
  'static',
  'yield',
  'await',
  'async',
  'undefined',
  'null',
  'true',
  'false',
  'NaN',
  'Infinity',
])

function inc(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

const RE_IDENT = /^[a-z_$][\w$]*$/i
const RE_PRINTABLE = /^[\x20-\x7E]+$/

function walk(node: any): void {
  if (!node || typeof node !== 'object')
    return

  switch (node.type) {
    case 'Identifier':
      if (!KEYWORDS.has(node.name) && RE_IDENT.test(node.name)) {
        inc(identNames, node.name)
      }
      break
    case 'StringLiteral':
      if (node.value.length > 0 && node.value.length <= 30 && RE_PRINTABLE.test(node.value)) {
        inc(stringValues, node.value)
      }
      break
    case 'NumericLiteral':
      if (Number.isFinite(node.value) && node.value >= 0 && node.value <= 999999) {
        inc(numberValues, String(node.value))
      }
      break
    case 'FunctionExpression':
    case 'FunctionDeclaration':
      if (node.id?.type === 'Identifier' && !KEYWORDS.has(node.id.name)) {
        inc(funcNames, node.id.name)
      }
      break
    case 'MemberExpression':
      if (!node.computed && node.property?.type === 'Identifier') {
        inc(propNames, node.property.name)
      }
      break
    case 'ImportDeclaration': {
      const src = node.source
      if (src && src.type === 'StringLiteral' && src.value.length > 0 && src.value.length <= 50 && !src.value.startsWith('.') && !src.value.startsWith('/')) {
        inc(packageNames, src.value)
      }
      if (Array.isArray(node.specifiers)) {
        for (const spec of node.specifiers) {
          if (spec.local && spec.local.type === 'Identifier' && RE_IDENT.test(spec.local.name) && !KEYWORDS.has(spec.local.name)) {
            inc(importedNames, spec.local.name)
          }
        }
      }
      break
    }
  }

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
        if (st.isDirectory())
          findJsFiles(full, files, depth + 1)
        else if (entry.endsWith('.js') && !entry.endsWith('.min.js') && st.size < 500_000 && st.size > 100)
          files.push(full)
      }
      catch {}
    }
  }
  catch {}
  return files
}

const tmpDir = mkdtempSync(join(tmpdir(), 'dd-cosmetics-'))
console.log(`Installing ${PACKAGES.length} packages into ${tmpDir}...`)
execSync(`cd "${tmpDir}" && npm init -y --silent 2>/dev/null && npm install --silent --no-audit --no-fund ${PACKAGES.join(' ')} 2>&1 | tail -3`, {
  stdio: ['pipe', 'inherit', 'inherit'],
  timeout: 300_000,
})

const jsFiles = findJsFiles(join(tmpDir, 'node_modules'))
console.log(`Found ${jsFiles.length} JS files, parsing...\n`)

let parsed = 0
for (let i = 0; i < jsFiles.length; i++) {
  if (i % 1000 === 0 && i > 0)
    process.stdout.write(`  [${i}/${jsFiles.length}]\r`)
  try {
    const code = readFileSync(jsFiles[i], 'utf8')
    const ast = parse(code, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: ['jsx', 'typescript', ['optionalChainingAssign', { version: '2023-07' }]],
    })
    walk(ast.program)
    parsed++
  }
  catch {}
}

console.log(`Parsed ${parsed} files\n`)

function topN(map: Map<string, number>, n: number): string[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k)
}

// Collect top entries
const topIdents = topN(identNames, 200)
const topProps = topN(propNames, 200)
const topStrings = topN(stringValues, 200)
const topNumbers = topN(numberValues, 100).map(Number)
const topFuncNames = topN(funcNames, 100)

// Print summaries
console.log('=== Top 30 identifiers ===')
for (const name of topIdents.slice(0, 30)) console.log(`  ${name} (${identNames.get(name)})`)

console.log('\n=== Top 30 properties ===')
for (const name of topProps.slice(0, 30)) console.log(`  ${name} (${propNames.get(name)})`)

console.log('\n=== Top 30 strings ===')
for (const s of topStrings.slice(0, 30)) console.log(`  "${s}" (${stringValues.get(s)})`)

console.log('\n=== Top 20 numbers ===')
for (const n of topNumbers.slice(0, 20)) console.log(`  ${n} (${numberValues.get(String(n))})`)

console.log('\n=== Top 20 function names ===')
for (const n of topFuncNames.slice(0, 20)) console.log(`  ${n} (${funcNames.get(n)})`)

console.log('\n=== Top 20 package names ===')
for (const name of topN(packageNames, 20)) console.log(`  ${name} (${packageNames.get(name)})`)
console.log('\n=== Top 20 imported names ===')
for (const name of topN(importedNames, 20)) console.log(`  ${name} (${importedNames.get(name)})`)

// Also collect global built-in methods
const GLOBALS: Record<string, string[]> = {
  'Array': ['isArray', 'from', 'of'],
  'Array.prototype': [
    'push',
    'pop',
    'shift',
    'unshift',
    'slice',
    'splice',
    'concat',
    'join',
    'indexOf',
    'lastIndexOf',
    'includes',
    'find',
    'findIndex',
    'filter',
    'map',
    'reduce',
    'reduceRight',
    'forEach',
    'some',
    'every',
    'sort',
    'reverse',
    'flat',
    'flatMap',
    'fill',
    'keys',
    'values',
    'entries',
    'at',
    'copyWithin',
  ],
  'Object': [
    'keys',
    'values',
    'entries',
    'assign',
    'create',
    'defineProperty',
    'defineProperties',
    'freeze',
    'seal',
    'getPrototypeOf',
    'setPrototypeOf',
    'getOwnPropertyNames',
    'getOwnPropertyDescriptor',
    'hasOwn',
    'is',
    'fromEntries',
  ],
  'String.prototype': [
    'charAt',
    'charCodeAt',
    'codePointAt',
    'concat',
    'includes',
    'endsWith',
    'startsWith',
    'indexOf',
    'lastIndexOf',
    'match',
    'matchAll',
    'padStart',
    'padEnd',
    'repeat',
    'replace',
    'replaceAll',
    'search',
    'slice',
    'split',
    'substring',
    'toLowerCase',
    'toUpperCase',
    'trim',
    'trimStart',
    'trimEnd',
    'at',
  ],
  'Math': [
    'abs',
    'ceil',
    'floor',
    'round',
    'max',
    'min',
    'pow',
    'sqrt',
    'log',
    'log2',
    'log10',
    'random',
    'sign',
    'trunc',
    'cbrt',
    'hypot',
    'imul',
    'clz32',
    'fround',
  ],
  'JSON': ['parse', 'stringify'],
  'Number': ['isFinite', 'isInteger', 'isNaN', 'isSafeInteger', 'parseFloat', 'parseInt'],
  'global': [
    'parseInt',
    'parseFloat',
    'isNaN',
    'isFinite',
    'encodeURIComponent',
    'decodeURIComponent',
    'encodeURI',
    'decodeURI',
    'structuredClone',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'queueMicrotask',
    'atob',
    'btoa',
  ],
}

// Write output
const cosmetics = {
  identifiers: topIdents,
  properties: topProps,
  strings: topStrings,
  numbers: topNumbers,
  functionNames: topFuncNames,
  packageNames: topN(packageNames, 200),
  importedNames: topN(importedNames, 200),
  globals: GLOBALS,
}

const outPath = join(process.cwd(), 'packages/core/src/cosmetic-data.json')
writeFileSync(outPath, `${JSON.stringify(cosmetics, null, 2)}\n`)
console.log(`\nWritten to ${outPath}`)
console.log(`${topIdents.length} identifiers, ${topProps.length} properties, ${topStrings.length} strings, ${topNumbers.length} numbers, ${topFuncNames.length} function names`)

execSync(`rm -rf "${tmpDir}"`)
console.log('Temp dir cleaned up')
