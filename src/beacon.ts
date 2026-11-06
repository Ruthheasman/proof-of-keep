// Block headers as the challenge beacon.
//
// The challenge for a period is derived from the hash of any 80-byte header whose timestamp falls
// in that period's window and whose hash meets the deal's proof-of-work floor. Nobody knows that
// hash before the window opens unless they pay for the work to make one.
import { Bytes, hash256, sha256, concat, u32le, readU32le, leToBigInt } from './bytes.js'

export const MAX_TARGET = 0xffffn << 208n // difficulty-1 target

/** Target for a given difficulty (difficulty 1 = MAX_TARGET). */
export const targetForDifficulty = (difficulty: number): bigint => {
  // Work in fixed point so fractional difficulties (test floors) are exact enough.
  const scaled = BigInt(Math.round(difficulty * 1e6))
  return (MAX_TARGET * 1000000n) / scaled
}

export const headerHash = (header: Bytes): Bytes => hash256(header)
export const headerTime = (header: Bytes): number => readU32le(header, 68)
export const meetsTarget = (header: Bytes, target: bigint): boolean =>
  leToBigInt(headerHash(header)) < target

/** seed_j = SHA256(H(header) || root || u32le(j)); index = LE(seed_j) mod N */
export function challengeIndices (header: Bytes, root: Bytes, n: number, m: number): number[] {
  const h = headerHash(header)
  const out: number[] = []
  for (let j = 0; j < m; j++) {
    const seed = sha256(concat(h, root, u32le(j)))
    out.push(Number(leToBigInt(seed) % BigInt(n)))
  }
  return out
}

/** Build a header with chosen time and grind the nonce until it meets `target` (tests only). */
export function mineHeader (time: number, target: bigint, salt = 0): Bytes {
  const prev = sha256(u32le(salt)) // arbitrary, the script does not check chain linkage
  const merkle = sha256(u32le(salt + 1))
  for (let nonce = 0; nonce < 0xffffffff; nonce++) {
    const h = concat(u32le(0x20000000), prev, merkle, u32le(time), u32le(0x1d00ffff), u32le(nonce))
    if (meetsTarget(h, target)) return h
  }
  throw new Error('no nonce found')
}
