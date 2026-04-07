import { encode as _encode, type EncodeOptions } from './encode'
import { decode as _decode, type DecodeOptions } from './decode'
import { MAX_EXPR_DEPTH } from './context'

export interface CodecOptions {
  /** Seed for cosmetic PRNG. Affects names/numbers/strings but not decoded data. */
  seed?: number
  /** Max expression nesting depth. Limits AST depth to keep output parseable
   *  by recursive-descent parsers. Default: Infinity (no limit). */
  maxExprDepth?: number
}

export interface Codec {
  encode: (message: Uint8Array) => string
  decode: (jsSource: string) => Uint8Array
}

/**
 * Create an encoder/decoder pair with shared configuration.
 * Both sides agree on structural parameters (maxExprDepth).
 */
export function createCodec(options: CodecOptions = {}): Codec {
  const { seed, maxExprDepth = MAX_EXPR_DEPTH } = options
  return {
    encode: (message: Uint8Array) => _encode(message, { seed, maxExprDepth }),
    decode: (jsSource: string) => _decode(jsSource, { maxExprDepth }),
  }
}

/** Encode bytes to JS source. */
export const encode = _encode

/** Decode JS source to bytes. */
export const decode = _decode

export type { EncodeOptions, DecodeOptions }
