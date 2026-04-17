# rANS Steganographic Encoding Design

**Goal:** Replace power-of-2 table encoding with range Asymmetric Numeral Systems (rANS) for near-optimal encoding efficiency. Eliminates wasted bits from rounding to power-of-2 table sizes.

**Breaking change:** v7.0.0 — entirely new encoding format.

## Why ANS works for stego when AC and range coding didn't

- **AC (E1/E2/E3):** Pending E3 bits accumulate when the interval straddles the midpoint. Flush picks an arbitrary resolution point, losing bit-level fidelity.
- **Range coding:** Carry propagation modifies already-output bytes. In stego, the encoder already consumed pre-carry values. Direction mismatch.
- **ANS:** State register IS the encoded information. No pending bits, no interval, no carry. After all symbols, remaining message bits are directly readable from the state. Bijective by design.

## Core primitives

### CDF construction

`buildCDF(candidates: Candidate[]): CDF` — converts weighted candidate list to a cumulative frequency table.

- Frequencies proportional to weights, quantized to integers summing to `M = 1 << 12` (4096).
- Power-of-2 total enables fast division via bit shifts.
- Minimum frequency 1 per candidate (no zero-probability entries).
- Deterministic: same candidates + same weights = same CDF every time.

```ts
interface CDF {
  cumFreqs: number[]   // cumFreqs[i] = sum of freqs[0..i-1], cumFreqs[0] = 0
  freqs: number[]      // freq of each candidate
  total: number        // M = sum of all freqs = 1 << 12
  candidates: Candidate[]
}
```

### rANS state

A single unsigned integer `x`, normalized to range `[L, 2L)` where `L = 1 << 16`.

- JS has 53-bit safe integers. Max arithmetic: `x * M = 2^32 * 2^12 = 2^44`. Well within range.
- Normalization: when `x` exits `[L, 2L)`, shift bits in (encoder) or out (decoder) to restore range.

### Stego-encoder (message bits -> candidate selection)

```
initialize x from message bits (read 32 bits)

for each position:
  cdf = buildCDF(filterCandidates(ctx))
  
  // Renormalize: refill state from message when too small
  while (x < L):
    x = (x << 1) | readMessageBit()
  
  // Decode symbol from state (ANS "decode" = stego "encode")
  t = x % M
  find symbol s such that cumFreqs[s] <= t < cumFreqs[s+1]
  x = (x / M) * freqs[s] + t - cumFreqs[s]
  
  select candidate[s], build AST node
  hash = mixHash(hash, s)
```

### Stego-decoder (candidate indices -> message bits)

Two passes:

**Pass 1 (forward):** Walk AST exactly as current decoder. At each position, build CDF from context and determine symbol index from the parsed node's candidate key. Store `(cdf, symbolIndex)` pairs in an array.

**Pass 2 (backward):** Process stored pairs in reverse order.

```
initialize x = known value (e.g., 0 or L)

for i = pairs.length - 1 down to 0:
  (cdf, s) = pairs[i]
  
  // Encode symbol into state (ANS "encode" = stego "decode")
  x = (x / freqs[s]) * M + cumFreqs[s] + (x % freqs[s])
  
  // Renormalize: output recovered bits when state too large
  while (x >= 2 * L):
    outputBit(x & 1)
    x >>= 1

output remaining bits from x (the initial 32 message bits)
reverse all output bits (LIFO -> FIFO)
extract message via 4-byte length prefix
```

## Block count encoding

Currently: raw 8-bit value (0-255).

With ANS: encode through the coder using a geometric distribution CDF favoring small counts. This assigns more probability mass to common block sizes (0-5), extracting more message bits from each block count decision.

`buildBlockCDF(): CDF` — cached, one geometric distribution.

## What replaces what

| Current | rANS |
|---------|------|
| `BitWriter` (encoder side) | `RansEncoder` — reads message bits into state, selects symbols |
| `BitWriter` (decoder side) | `RansDecoder` — two-pass: forward collect pairs, backward recover bits |
| `buildTable(candidates, hash)` | `buildCDF(candidates)` — no hash-based shuffle needed, CDF is deterministic from weights |
| `buildReverseTable(table)` | `CDF.reverseMap` — candidate key to symbol index |
| `bitWidth(N)` + `readBits(width)` | rANS decode operation (variable bits consumed per symbol based on frequency) |
| `out.write(value, bits)` | Forward pass stores `(cdf, index)`, backward pass does rANS encode |
| Raw block count byte | Block count through geometric CDF |

## Hash chain change

Current: `hash = mixHash(hash, tableIndex)` where `tableIndex` is the power-of-2 table position.

With ANS: `hash = mixHash(hash, symbolIndex)` where `symbolIndex` is the CDF position. The hash still evolves deterministically and identically in encoder/decoder. It no longer affects table shuffle (no tables), but still mixes into candidate filtering via the structural key.

Wait — the hash is currently used in two places:
1. `buildTable(candidates, hash)` — seeds the PRNG for weight-biased selection and shuffle
2. `mixHash(hash, value)` — evolves the running hash

With CDF, there's no table shuffle. But the hash is still part of the structural key system (`key` option mixes into initial hash). The hash should still evolve with each symbol to maintain the key-dependent behavior. `hash = mixHash(hash, symbolIndex)` after each symbol, same as before.

## Precision and JS safety

- State `x`: 32-bit range `[L, 2L)` where `L = 1 << 16`, so `x` is in `[65536, 131071]`
- CDF total `M = 1 << 12 = 4096`
- Max arithmetic: `x * M` during encode = `131071 * 4096 = 536,866,816` < `2^30`. Safe.
- `(x / M) * freqs[s]`: `(131071 / 4096) * 4096 = 131071`. Safe.
- All operations stay well under `Number.MAX_SAFE_INTEGER` (2^53).

## What does NOT change

- `filterCandidates` — still produces weighted candidate lists (with Markov transitions)
- Context tracking — scope, prevStmtKey, scopeBucket, inLoop, inFunction, etc.
- Cosmetic generation — names, strings, numbers, package names
- Codegen — unchanged
- Public API — `encode`, `decode`, `createCodec` signatures unchanged
- `isPad()` behavior — encoder stops generating data-carrying nodes past message boundary

## Encoding efficiency improvement

Current: `floor(log2(N))` bits per symbol where N = unique candidates. Wastes `N - 2^floor(log2(N))` candidates.

ANS: `log2(M / freq[s])` bits per symbol, proportional to `-log2(P(s))`. Near-optimal for any distribution. With 300 candidates and realistic weights, this should improve encoding density by 20-40% (more bytes per JS character).
