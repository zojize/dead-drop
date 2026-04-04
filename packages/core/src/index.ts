#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { encode } from './encode'
import { decode } from './decode'

// Public API exports
export { encode, decode }

// CLI
const args = process.argv.slice(2)
const command = args[0]

function usage(): never {
  console.error(`Usage:
  dead-drop encode "message"        Encode a text message to JS
  dead-drop encode --file <path>    Encode a file to JS
  dead-drop decode                  Decode JS from stdin
  dead-drop test                    Run a quick round-trip test`)
  process.exit(1)
}

if (!command) usage()

switch (command) {
  case 'encode': {
    let input: Uint8Array
    if (args[1] === '--file') {
      if (!args[2]) {
        console.error('Error: --file requires a path')
        process.exit(1)
      }
      input = readFileSync(args[2])
    } else if (args[1]) {
      input = new TextEncoder().encode(args[1])
    } else {
      console.error('Error: encode requires a message or --file <path>')
      process.exit(1)
    }
    process.stdout.write(encode(input))
    process.stdout.write('\n')
    break
  }

  case 'decode': {
    let jsSource: string
    if (args[1]) {
      jsSource = readFileSync(args[1], 'utf-8')
    } else {
      jsSource = readFileSync('/dev/stdin', 'utf-8')
    }
    const decoded = decode(jsSource)
    process.stdout.write(decoded)
    break
  }

  case 'test': {
    const msg = new TextEncoder().encode('The quick brown fox jumps over the lazy dog')
    const js = encode(msg)
    const result = decode(js)
    const original = new TextDecoder().decode(msg)
    const roundTripped = new TextDecoder().decode(result)
    if (original === roundTripped) {
      console.log('Round-trip OK!')
      console.log(`  Input:   "${original}"`)
      console.log(`  JS size: ${js.length} chars`)
      console.log(`  Output:  "${roundTripped}"`)
    } else {
      console.error('Round-trip FAILED!')
      console.error(`  Input:  "${original}"`)
      console.error(`  Output: "${roundTripped}"`)
      process.exit(1)
    }
    break
  }

  default:
    console.error(`Unknown command: ${command}`)
    usage()
}
