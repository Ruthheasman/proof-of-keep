// Small byte helpers shared by the prototype. Everything is number[] to match @bsv/sdk.
import { Hash } from '@bsv/sdk'

export type Bytes = number[]

export const sha256 = (b: Bytes): Bytes => Hash.sha256(b) as Bytes
export const hash256 = (b: Bytes): Bytes => Hash.hash256(b) as Bytes

export const concat = (...parts: Bytes[]): Bytes => parts.flat()

export const u32le = (n: number): Bytes => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]

export const readU32le = (b: Bytes, off: number): number =>
  (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0

/** Interpret bytes as an unsigned little-endian integer (how Bitcoin compares hashes to targets). */
export const leToBigInt = (b: Bytes): bigint => {
  let x = 0n
  for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i])
  return x
}

export const randomBytes = (n: number, seed: { s: number }): Bytes => {
  // Deterministic xorshift so test runs are reproducible.
  const out: Bytes = []
  for (let i = 0; i < n; i++) {
    seed.s ^= seed.s << 13; seed.s ^= seed.s >>> 17; seed.s ^= seed.s << 5
    out.push(seed.s & 0xff)
  }
  return out
}

export const toHex = (b: Bytes): string => b.map(x => x.toString(16).padStart(2, '0')).join('')
export const fromHex = (h: string): Bytes => h.match(/../g)!.map(x => parseInt(x, 16))
