/**
 * scrape-names.ts
 *
 * Fetches minified JS bundles from CDN, parses them with @babel/parser,
 * and extracts identifier names, string literals, and numeric literals
 * for use as realistic-looking pools in the steganographic encoder.
 *
 * Usage:  bun scripts/scrape-names.ts
 * Output: packages/core/src/scraped-names.json
 */

import type { Node } from '@babel/types'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { parse } from '@babel/parser'

// ─── CDN Sources ─────────────────────────────────────────────────────────────

const CDN_URLS = [
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/vue@3/dist/vue.global.prod.js',
  'https://unpkg.com/lodash@4/lodash.min.js',
  'https://unpkg.com/three@latest/build/three.module.min.js',
]

// ─── JS Keywords / Reserved Words to Skip ────────────────────────────────────

const JS_KEYWORDS = new Set([
  // keywords
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
  'of',
  'from',
  'as',
  'get',
  'set',
  // literals
  'true',
  'false',
  'null',
  'undefined',
  'NaN',
  'Infinity',
  // other reserved in strict mode
  'arguments',
  'eval',
])

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RE_IDENTIFIER = /^[a-z_$][\w$]*$/i
const RE_PRINTABLE_ASCII = /^[\x20-\x7E]+$/
const RE_STARTS_WITH_LETTER = /^[a-z]/i
const RE_ALPHANUMERIC_LIKE = /^[a-z][\w.\-\s]*$/i
const RE_JUST_NUMBERS = /^\d+(?:\.\d+)?$/
const RE_HEX_ONLY = /^[0-9a-f]+$/i
const RE_URL_LIKE = /^https?:\/\//

function isValidIdentifier(name: string): boolean {
  if (name.length < 1 || name.length > 20)
    return false
  if (JS_KEYWORDS.has(name))
    return false
  // Must look like a normal identifier (letters, digits, _, $)
  if (!RE_IDENTIFIER.test(name))
    return false
  return true
}

function isValidString(s: string): boolean {
  if (s.length < 1 || s.length > 30)
    return false
  // Must be printable ASCII, no control chars or weird escapes
  if (!RE_PRINTABLE_ASCII.test(s))
    return false
  // Must start with a letter (skip punctuation fragments, numbers, etc.)
  if (!RE_STARTS_WITH_LETTER.test(s))
    return false
  // Must be mostly alphanumeric (allow hyphens, underscores, dots, spaces)
  if (!RE_ALPHANUMERIC_LIKE.test(s))
    return false
  // Skip strings that are just numbers
  if (RE_JUST_NUMBERS.test(s))
    return false
  // Skip hex-only strings (hashes, colors)
  if (RE_HEX_ONLY.test(s) && s.length > 4)
    return false
  // Skip URL-like strings
  if (RE_URL_LIKE.test(s))
    return false
  return true
}

function isValidNumber(n: number): boolean {
  if (!Number.isFinite(n))
    return false
  // Skip very large numbers (likely bit masks or hashes)
  if (Math.abs(n) > 1_000_000)
    return false
  return true
}

// ─── AST Walker ──────────────────────────────────────────────────────────────

function walkAST(
  node: Node | null | undefined,
  identifiers: Set<string>,
  strings: Set<string>,
  numbers: Set<number>,
) {
  if (!node || typeof node !== 'object')
    return

  if (node.type === 'Identifier' && 'name' in node) {
    const name = (node as any).name as string
    if (isValidIdentifier(name)) {
      identifiers.add(name)
    }
  }
  else if (node.type === 'StringLiteral' && 'value' in node) {
    const val = (node as any).value as string
    if (isValidString(val)) {
      strings.add(val)
    }
  }
  else if (node.type === 'NumericLiteral' && 'value' in node) {
    const val = (node as any).value as number
    if (isValidNumber(val)) {
      numbers.add(val)
    }
  }

  // Recurse into all child nodes
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'type')
      continue
    const child = (node as any)[key]
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object' && typeof item.type === 'string') {
          walkAST(item, identifiers, strings, numbers)
        }
      }
    }
    else if (child && typeof child === 'object' && typeof child.type === 'string') {
      walkAST(child, identifiers, strings, numbers)
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const allIdentifiers = new Set<string>()
  const allStrings = new Set<string>()
  const allNumbers = new Set<number>()

  for (const url of CDN_URLS) {
    const label = url.split('/').slice(-1)[0]
    console.log(`Fetching ${label} ...`)

    let source: string
    try {
      const resp = await fetch(url)
      if (!resp.ok) {
        console.warn(`  WARN: ${resp.status} ${resp.statusText} — skipping`)
        continue
      }
      source = await resp.text()
    }
    catch (err) {
      console.warn(`  WARN: fetch failed — ${err}`)
      continue
    }

    console.log(`  ${source.length.toLocaleString()} bytes, parsing...`)

    let ast: ReturnType<typeof parse>
    try {
      ast = parse(source, {
        sourceType: 'unambiguous',
        plugins: ['jsx', 'typescript', 'classProperties', 'dynamicImport'],
        errorRecovery: true,
      })
    }
    catch (err) {
      console.warn(`  WARN: parse failed — ${err}`)
      continue
    }

    const beforeIdent = allIdentifiers.size
    const beforeStr = allStrings.size
    const beforeNum = allNumbers.size

    walkAST(ast.program as unknown as Node, allIdentifiers, allStrings, allNumbers)

    console.log(
      `  +${allIdentifiers.size - beforeIdent} idents, `
      + `+${allStrings.size - beforeStr} strings, `
      + `+${allNumbers.size - beforeNum} numbers`,
    )
  }

  console.log(`\nTotals before trimming:`)
  console.log(`  identifiers: ${allIdentifiers.size}`)
  console.log(`  strings:     ${allStrings.size}`)
  console.log(`  numbers:     ${allNumbers.size}`)

  // ── Trim to target sizes ───────────────────────────────────────────────────

  const TARGET_IDENTS = 200
  const TARGET_STRINGS = 100
  const TARGET_NUMBERS = 100

  // Round-robin across length buckets for max diversity
  function diverseSlice(items: string[], target: number): string[] {
    const buckets = new Map<number, string[]>()
    for (const s of items) {
      const len = s.length
      if (!buckets.has(len))
        buckets.set(len, [])
      buckets.get(len)!.push(s)
    }
    // Sort each bucket alphabetically for determinism
    for (const arr of buckets.values()) arr.sort()
    // Round-robin: take one from each bucket in order, repeat
    const sortedLens = [...buckets.keys()].sort((a, b) => a - b)
    const result: string[] = []
    const idx = new Map<number, number>(sortedLens.map(l => [l, 0]))
    while (result.length < target) {
      let added = false
      for (const len of sortedLens) {
        const bucket = buckets.get(len)!
        const i = idx.get(len)!
        if (i < bucket.length) {
          result.push(bucket[i])
          idx.set(len, i + 1)
          added = true
          if (result.length >= target)
            break
        }
      }
      if (!added)
        break
    }
    return result
  }

  const finalIdents = diverseSlice([...allIdentifiers], TARGET_IDENTS)

  // Strings: same diverse approach
  const finalStrings = diverseSlice([...allStrings], TARGET_STRINGS)

  // Numbers: spread across the range (small, medium, large)
  const sortedNumbers = [...allNumbers].sort((a, b) => a - b)
  const step = Math.max(1, Math.floor(sortedNumbers.length / TARGET_NUMBERS))
  const finalNumbers: number[] = []
  for (let i = 0; i < sortedNumbers.length && finalNumbers.length < TARGET_NUMBERS; i += step) {
    finalNumbers.push(sortedNumbers[i])
  }
  // Fill remaining from unused
  const used = new Set(finalNumbers)
  for (const n of sortedNumbers) {
    if (finalNumbers.length >= TARGET_NUMBERS)
      break
    if (!used.has(n))
      finalNumbers.push(n)
  }
  finalNumbers.sort((a, b) => a - b)

  console.log(`\nAfter trimming:`)
  console.log(`  identifiers: ${finalIdents.length}`)
  console.log(`  strings:     ${finalStrings.length}`)
  console.log(`  numbers:     ${finalNumbers.length}`)

  // ── Write output ───────────────────────────────────────────────────────────

  const output = {
    identifiers: finalIdents,
    strings: finalStrings,
    numbers: finalNumbers,
  }

  // Resolve relative to the repo root (parent of scripts/)
  const scriptDir = import.meta.dir ?? new URL('.', import.meta.url).pathname
  const repoRoot = resolve(scriptDir, '..')
  const outPath = resolve(repoRoot, 'packages/core/src/scraped-names.json')

  writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`)
  console.log(`\nWrote ${outPath}`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
