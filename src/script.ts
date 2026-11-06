// Proof of Keep v1 period script.
//
// One UTXO per (operator, period). Two spending paths:
//
//   KEEP   (selector 1): a header in [windowStart, windowEnd) meeting the PoW floor, m chunks at the
//                        indices that header selects, each with its Merkle path to the deal root,
//                        and the operator's signature.
//   LAPSE  (selector 0): a header with time >= lapseTime meeting the lapse floor, and the steward's
//                        signature. Used to recover a period the operator failed to claim.
//
// The script reads no chain state. Unpredictability comes from the header hash; the cost of
// forging a header that meets the floor is what bounds how much one period UTXO may hold.
import { LockingScript, UnlockingScript, OP } from '@bsv/sdk'
import { Bytes, u32le } from './bytes.js'

type Chunk = { op: number, data?: number[] }

export const push = (data: Bytes): Chunk => {
  if (data.length === 0) return { op: OP.OP_0 }
  if (data.length === 1 && data[0] >= 1 && data[0] <= 16) return { op: OP.OP_1 + data[0] - 1 }
  if (data.length <= 75) return { op: data.length, data }
  if (data.length <= 0xff) return { op: OP.OP_PUSHDATA1, data }
  if (data.length <= 0xffff) return { op: OP.OP_PUSHDATA2, data }
  return { op: OP.OP_PUSHDATA4, data }
}

/** Minimal script number encoding (little-endian sign-magnitude). */
export const scriptNum = (v: bigint): Bytes => {
  if (v === 0n) return []
  const neg = v < 0n
  let x = neg ? -v : v
  const out: Bytes = []
  while (x > 0n) { out.push(Number(x & 0xffn)); x >>= 8n }
  if (out[out.length - 1] & 0x80) out.push(neg ? 0x80 : 0x00)
  else if (neg) out[out.length - 1] |= 0x80
  return out
}

export const num = (v: number | bigint): Chunk => {
  const b = BigInt(v)
  if (b === 0n) return { op: OP.OP_0 }
  if (b >= 1n && b <= 16n) return { op: OP.OP_1 + Number(b) - 1 }
  if (b === -1n) return { op: OP.OP_1NEGATE }
  return push(scriptNum(b))
}

const op = (o: number): Chunk => ({ op: o })
const ZERO_BYTE: Chunk = { op: 1, data: [0x00] } // a one-byte push of 0x00 (not OP_0, which is empty)

export interface PeriodTerms {
  root: Bytes          // 32-byte deal root
  chunkCount: number   // N, leaves that may be challenged
  depth: number        // d, fixed path length
  samples: number      // m, chunks proven per claim
  windowStart: number  // unix seconds, inclusive
  windowEnd: number    // unix seconds, exclusive
  keepTarget: bigint   // PoW floor for the keep path
  operatorKey: Bytes   // 33-byte compressed pubkey
  lapseTime: number    // unix seconds
  lapseTarget: bigint  // PoW floor for the lapse path
  stewardKey: Bytes    // 33-byte compressed pubkey
}

/** Header on top -> header, with time pushed. Leaves [header, time] on the stack. */
const headerTime = (): Chunk[] => [
  op(OP.OP_SIZE), num(80), op(OP.OP_EQUALVERIFY),
  op(OP.OP_DUP), num(68), op(OP.OP_SPLIT), op(OP.OP_NIP),
  num(4), op(OP.OP_SPLIT), op(OP.OP_DROP),
  ZERO_BYTE, op(OP.OP_CAT), op(OP.OP_BIN2NUM) // u32 time, kept positive past 2038
]

/** [h] -> [h], failing unless LE(h) < target. */
const powCheck = (target: bigint): Chunk[] => [
  op(OP.OP_DUP), ZERO_BYTE, op(OP.OP_CAT), op(OP.OP_BIN2NUM),
  num(target), op(OP.OP_LESSTHAN), op(OP.OP_VERIFY)
]

/** One sampled chunk: [.. sib_{d-1} .. sib_0 chunk] -> [..], with H(header) on the alt stack. */
const challenge = (t: PeriodTerms, j: number): Chunk[] => {
  const out: Chunk[] = [
    // leaf = SHA256(0x00 || chunk)
    ZERO_BYTE, op(OP.OP_SWAP), op(OP.OP_CAT), op(OP.OP_SHA256),
    // index = LE(SHA256(h || root || u32le(j))) mod N
    op(OP.OP_FROMALTSTACK), op(OP.OP_DUP), op(OP.OP_TOALTSTACK),
    push(t.root), op(OP.OP_CAT), push(u32le(j)), op(OP.OP_CAT), op(OP.OP_SHA256),
    ZERO_BYTE, op(OP.OP_CAT), op(OP.OP_BIN2NUM), num(t.chunkCount), op(OP.OP_MOD)
  ]
  for (let lvl = 0; lvl < t.depth; lvl++) {
    out.push(
      // [sib cur idx] -> [sib cur bit], idx>>1 parked on the alt stack
      op(OP.OP_DUP), num(2), op(OP.OP_MOD),
      op(OP.OP_SWAP), num(2), op(OP.OP_DIV), op(OP.OP_TOALTSTACK),
      op(OP.OP_IF), op(OP.OP_CAT), // cur is a right child: sib || cur
      op(OP.OP_ELSE), op(OP.OP_SWAP), op(OP.OP_CAT), // cur is a left child: cur || sib
      op(OP.OP_ENDIF),
      num(1), op(OP.OP_SWAP), op(OP.OP_CAT), op(OP.OP_SHA256), // node = SHA256(0x01 || l || r)
      op(OP.OP_FROMALTSTACK)
    )
  }
  out.push(op(OP.OP_DROP), push(t.root), op(OP.OP_EQUALVERIFY))
  return out
}

export function periodLockingScript (t: PeriodTerms): LockingScript {
  const keep: Chunk[] = [
    ...headerTime(), num(t.windowStart), num(t.windowEnd), op(OP.OP_WITHIN), op(OP.OP_VERIFY),
    op(OP.OP_HASH256), ...powCheck(t.keepTarget), op(OP.OP_TOALTSTACK)
  ]
  for (let j = 0; j < t.samples; j++) keep.push(...challenge(t, j))
  keep.push(op(OP.OP_FROMALTSTACK), op(OP.OP_DROP), push(t.operatorKey), op(OP.OP_CHECKSIG))

  const lapse: Chunk[] = [
    ...headerTime(), num(t.lapseTime), op(OP.OP_GREATERTHANOREQUAL), op(OP.OP_VERIFY),
    op(OP.OP_HASH256), ...powCheck(t.lapseTarget), op(OP.OP_DROP),
    push(t.stewardKey), op(OP.OP_CHECKSIG)
  ]
  return new LockingScript([op(OP.OP_IF), ...keep, op(OP.OP_ELSE), ...lapse, op(OP.OP_ENDIF)])
}

export interface Proof { chunk: Bytes, siblings: Bytes[] } // siblings from leaf level upward

/** Unlocking script for the keep path. Proofs are in challenge order j = 0..m-1. */
export function keepUnlockingScript (sig: Bytes, header: Bytes, proofs: Proof[]): UnlockingScript {
  const chunks: Chunk[] = [push(sig)]
  for (let j = proofs.length - 1; j >= 0; j--) {
    const p = proofs[j]
    for (let lvl = p.siblings.length - 1; lvl >= 0; lvl--) chunks.push(push(p.siblings[lvl]))
    chunks.push(push(p.chunk))
  }
  chunks.push(push(header), num(1))
  return new UnlockingScript(chunks)
}

export function lapseUnlockingScript (sig: Bytes, header: Bytes): UnlockingScript {
  return new UnlockingScript([push(sig), push(header), { op: OP.OP_0 }])
}
