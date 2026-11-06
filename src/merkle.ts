// Fixed-depth file tree. This is a file tree, not a batch tree: leaf order is the file's chunk
// order, so leaves are NOT sorted. Depth is fixed so the locking script can unroll one path shape.
//
//   leaf  = SHA256(0x00 || chunk)
//   node  = SHA256(0x01 || left || right)
//   pad   = 32 zero bytes, filling positions N .. 2^d - 1 (never challenged, since index < N)
//
// Padding with a constant that no SHA-256 output is known to equal avoids the duplicate-last-node
// convention and its CVE-2012-2459 root collision.
import { Bytes, sha256, concat } from './bytes.js'

export const PAD: Bytes = new Array(32).fill(0)
export const leafHash = (chunk: Bytes): Bytes => sha256(concat([0x00], chunk))
export const nodeHash = (l: Bytes, r: Bytes): Bytes => sha256(concat([0x01], l, r))

export const depthFor = (n: number): number => Math.max(1, Math.ceil(Math.log2(n)))

export class FileTree {
  readonly levels: Bytes[][] // levels[0] = leaves (padded), levels[d] = [root]
  readonly depth: number
  readonly count: number

  constructor (chunks: Bytes[]) {
    this.count = chunks.length
    this.depth = depthFor(chunks.length)
    const width = 2 ** this.depth
    const leaves = chunks.map(leafHash)
    while (leaves.length < width) leaves.push(PAD)
    this.levels = [leaves]
    for (let lvl = 0; lvl < this.depth; lvl++) {
      const prev = this.levels[lvl]
      const next: Bytes[] = []
      for (let i = 0; i < prev.length; i += 2) next.push(nodeHash(prev[i], prev[i + 1]))
      this.levels.push(next)
    }
  }

  get root (): Bytes { return this.levels[this.depth][0] }

  /** Siblings from the leaf level upward. */
  path (index: number): Bytes[] {
    const sibs: Bytes[] = []
    let i = index
    for (let lvl = 0; lvl < this.depth; lvl++) {
      sibs.push(this.levels[lvl][i ^ 1])
      i >>= 1
    }
    return sibs
  }
}

/** Off-chain path check, mirroring the script. */
export function checkPath (chunk: Bytes, index: number, sibs: Bytes[], root: Bytes): boolean {
  let cur = leafHash(chunk)
  let i = index
  for (const s of sibs) {
    cur = (i & 1) === 1 ? nodeHash(s, cur) : nodeHash(cur, s)
    i >>= 1
  }
  return cur.every((b, k) => b === root[k])
}
