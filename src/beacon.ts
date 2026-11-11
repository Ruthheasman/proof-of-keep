// Block headers as the challenge beacon.
//
// Each period is pinned to one block height. The claim supplies that block's 80-byte header, its
// coinbase transaction, and the coinbase's Merkle path to the header's Merkle root. The coinbase
// records the block's height (BIP34, a consensus rule), so the header can only be the block at the
// pinned height. Its hash must also meet the deal's proof-of-work floor, so nobody knows the
// challenge before that block is mined unless they pay for the work to forge one.
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
export const headerMerkleRoot = (header: Bytes): Bytes => header.slice(36, 68)
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

// ---- the coinbase and its height ----------------------------------------------------------------

/** Minimal script number, as BIP34 serialises the height. */
const scriptNumBytes = (v: number): Bytes => {
  const out: Bytes = []
  for (let x = v; x > 0; x = Math.floor(x / 256)) out.push(x % 256)
  if (out.length && out[out.length - 1] & 0x80) out.push(0)
  return out
}

/** The bytes a coinbase's scriptSig opens with at `height`: a push of the height (BIP34). */
export const heightPush = (height: number): Bytes => { const n = scriptNumBytes(height); return [n.length, ...n] }

/** Bytes 4..40 of every coinbase: one input, spending the null outpoint. */
export const COINBASE_INPUT: Bytes = [0x01, ...new Array(32).fill(0), 0xff, 0xff, 0xff, 0xff]

/** The height a coinbase records, or undefined if it is not a BIP34 coinbase. */
export function coinbaseHeight (coinbase: Bytes): number | undefined {
  if (coinbase.length < 46 || COINBASE_INPUT.some((b, i) => coinbase[4 + i] !== b)) return undefined
  const len = coinbase[42]
  if (len < 1 || len > 8 || coinbase.length < 43 + len) return undefined
  let h = 0
  for (let i = len - 1; i >= 0; i--) h = h * 256 + coinbase[43 + i]
  return h
}

/** A minimal coinbase transaction for `height` (tests and the dry run). */
export function makeCoinbase (height: number, tag: Bytes = []): Bytes {
  const script = [...heightPush(height), ...tag]
  return concat(
    u32le(1), COINBASE_INPUT, [script.length], script, u32le(0xffffffff),
    [1], u32le(312500000), u32le(0), [1], [0x51], // one output of 3.125 BSV to OP_TRUE
    u32le(0)
  )
}

// ---- Merkle paths for the coinbase ------------------------------------------------------------

/** Bitcoin's transaction Merkle root (double SHA-256, odd nodes paired with themselves). */
export function txMerkleRoot (txids: Bytes[]): Bytes {
  let level = txids
  while (level.length > 1) {
    const next: Bytes[] = []
    for (let i = 0; i < level.length; i += 2) next.push(hash256(concat(level[i], level[i + 1] ?? level[i])))
    level = next
  }
  return level[0]
}

/** Siblings of transaction 0 from the leaf upward. The coinbase is always the left child. */
export function coinbasePath (txids: Bytes[]): Bytes[] {
  const path: Bytes[] = []
  let level = txids
  while (level.length > 1) {
    path.push(level[1] ?? level[0])
    const next: Bytes[] = []
    for (let i = 0; i < level.length; i += 2) next.push(hash256(concat(level[i], level[i + 1] ?? level[i])))
    level = next
  }
  return path
}

/** Fold a coinbase path the way the script does. */
export const foldCoinbasePath = (txid: Bytes, path: Bytes[]): Bytes =>
  path.reduce((cur, sib) => hash256(concat(cur, sib)), txid)

// ---- test blocks ----------------------------------------------------------------------------

/** Build a header with chosen time and Merkle root and grind the nonce until it meets `target` (tests only). */
export function mineHeader (time: number, target: bigint, salt = 0, merkleRoot?: Bytes): Bytes {
  const prev = sha256(u32le(salt)) // arbitrary, the script does not check chain linkage
  const merkle = merkleRoot ?? sha256(u32le(salt + 1))
  for (let nonce = 0; nonce < 0xffffffff; nonce++) {
    const h = concat(u32le(0x20000000), prev, merkle, u32le(time), u32le(0x1d00ffff), u32le(nonce))
    if (meetsTarget(h, target)) return h
  }
  throw new Error('no nonce found')
}

export interface TestBlock { header: Bytes, coinbase: Bytes, path: Bytes[], txids: Bytes[] }

/** A block at `height` with a BIP34 coinbase and `others` further transactions, mined to `target`. */
export function mineBlock (height: number, time: number, target: bigint, others = 6, salt = 0, coinbase = makeCoinbase(height, u32le(salt))): TestBlock {
  const txids = [hash256(coinbase), ...Array.from({ length: others }, (_, i) => sha256(concat(u32le(salt), u32le(i))))]
  const header = mineHeader(time, target, salt, txMerkleRoot(txids))
  return { header, coinbase, path: coinbasePath(txids), txids }
}
