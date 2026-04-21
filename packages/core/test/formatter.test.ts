/**
 * Formatter survival tests.
 *
 * The encoding is designed so that ALL structural data lives in the AST node
 * types, not in literal values. Formatters that only reformat syntax (spacing,
 * quotes, semicolons on statements) should therefore be transparent to decoding.
 *
 * The specific AST-structural transformations that would break decoding are:
 *   1. EmptyStatement removal — Prettier/Biome strip bare `;`, changing stmts.length
 *      and therefore the recovered count byte. Fixed by removing EmptyStatement:0
 *      from the candidate pool.
 *   2. DebuggerStatement removal — oxlint's no-debugger rule auto-removes `debugger;`.
 *      Fixed by removing DebuggerStatement:0 from the candidate pool.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'prettier'
import { describe, expect, it } from 'vitest'
import { decode } from '../src/decode'
import { encode } from '../src/encode'

// ─── helpers ────────────────────────────────────────────────────────────────

function deterministicData(seed: number, len: number): Uint8Array {
  const data = new Uint8Array(len)
  for (let j = 0; j < len; j++)
    data[j] = (seed * 31 + j * 7) & 0xFF
  return data
}

async function prettierFormat(js: string): Promise<string> {
  return format(js, { parser: 'babel' })
}

function oxlintFix(js: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dead-drop-oxlint-'))
  const file = join(dir, 'encoded.js')
  try {
    writeFileSync(file, js)
    try {
      execFileSync('bunx', ['oxlint', '--fix', file], { stdio: 'pipe' })
    }
    catch {
      // oxlint exits non-zero even for warnings — read file regardless
    }
    return readFileSync(file, 'utf8')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ─── prettier ───────────────────────────────────────────────────────────────

describe('formatter survival — prettier', () => {
  it('round-trips all 256 single-byte values after prettier formatting', async () => {
    for (let b = 0; b < 256; b++) {
      const data = new Uint8Array([b])
      const js = encode(data)
      const formatted = await prettierFormat(js)
      const out = decode(formatted)
      expect(Array.from(out), `byte 0x${b.toString(16).padStart(2, '0')}`).toEqual(Array.from(data))
    }
  })

  it('round-trips random payloads after prettier formatting (100 iterations)', async () => {
    for (let i = 0; i < 100; i++) {
      const data = deterministicData(i, 5 + (i % 20))
      const js = encode(data, { seed: i })
      const formatted = await prettierFormat(js)
      const out = decode(formatted)
      expect(Array.from(out), `seed=${i}`).toEqual(Array.from(data))
    }
  })

  it('prettier removes no EmptyStatements from encoded output', async () => {
    for (let i = 0; i < 100; i++) {
      const data = deterministicData(i, 5 + (i % 20))
      const js = encode(data, { seed: i })
      const formatted = await prettierFormat(js)
      // If formatter stripped nodes, output will be shorter
      // More importantly: no ;; sequences should appear (encoder never generates them)
      expect(js).not.toContain(';;')
      expect(formatted).not.toContain(';;')
    }
  })
})

// ─── oxlint ─────────────────────────────────────────────────────────────────

describe('formatter survival — oxlint --fix', () => {
  it('round-trips all 256 single-byte values after oxlint --fix', { timeout: 60_000 }, () => {
    for (let b = 0; b < 256; b++) {
      const data = new Uint8Array([b])
      const js = encode(data)
      const fixed = oxlintFix(js)
      const out = decode(fixed)
      expect(Array.from(out), `byte 0x${b.toString(16).padStart(2, '0')}`).toEqual(Array.from(data))
    }
  })

  it('round-trips random payloads after oxlint --fix (100 iterations)', { timeout: 30_000 }, () => {
    for (let i = 0; i < 100; i++) {
      const data = deterministicData(i, 5 + (i % 20))
      const js = encode(data, { seed: i })
      const fixed = oxlintFix(js)
      const out = decode(fixed)
      expect(Array.from(out), `seed=${i}`).toEqual(Array.from(data))
    }
  })
})
