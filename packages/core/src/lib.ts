import type { DecodeOptions } from './decode'
import type { EncodeOptions } from './encode'
import { MAX_EXPR_DEPTH } from './context'
import { decode as _decode } from './decode'
import { encode as _encode } from './encode'

export interface CodecOptions {
  /** Cosmetic seed — affects names/strings/numbers but not decoded data. */
  seed?: number
  /** Structural key — affects candidate selection. Both encode and decode must agree. */
  key?: number
  /**
   * Max expression nesting depth. Limits AST depth to keep output parseable
   *  by recursive-descent parsers. Default: Infinity (no limit).
   */
  maxExprDepth?: number
}

export interface Codec {
  encode: (message: Uint8Array) => string
  decode: (jsSource: string) => Uint8Array
}

/**
 * Create an encoder/decoder pair with shared configuration.
 * Both sides agree on key and maxExprDepth.
 */
export function createCodec(options: CodecOptions = {}): Codec {
  const { seed, key, maxExprDepth = MAX_EXPR_DEPTH } = options
  return {
    encode: (message: Uint8Array) => _encode(message, { seed, key, maxExprDepth }),
    decode: (jsSource: string) => _decode(jsSource, { key, maxExprDepth }),
  }
}

/** Encode bytes to JS source. */
export const encode = _encode

/** Decode JS source to bytes. */
export const decode = _decode

export type { DecodeOptions, EncodeOptions }
