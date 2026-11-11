// Chain access for the mainnet test: block headers, coinbase proofs and raw transactions from
// WhatsOnChain, broadcasting through ARC. A dry-run implementation stands in for both, so the whole flow can be
// rehearsed with no network and no money.
import { Transaction, ARC, Broadcaster } from '@bsv/sdk'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Bytes, concat, u32le, fromHex, toHex, hash256, leToBigInt } from './bytes.js'
import { headerTime, headerMerkleRoot, makeCoinbase, txMerkleRoot, coinbasePath, foldCoinbasePath } from './beacon.js'

export interface Header { height: number, bytes: Bytes, time: number, hash: string }

/** A block's coinbase transaction and its Merkle path (siblings, leaf upward), for pinning a period. */
export interface CoinbaseProof { coinbase: Bytes, path: Bytes[] }

export interface Chain {
  readonly dry: boolean
  tip (): Promise<Header>
  header (height: number): Promise<Header>
  /** The coinbase of the block at `height` and its path to that block's Merkle root, checked. */
  coinbaseProof (height: number): Promise<CoinbaseProof>
  getTx (txid: string): Promise<Transaction>
  /** ok is null when the broadcaster's reply could not be read: the outcome is unknown, not a rejection. */
  broadcast (tx: Transaction): Promise<{ ok: boolean | null, txid: string, detail: string }>
}

/** Expand compact nBits to a full target. */
export const bitsToTarget = (bits: number): bigint => {
  const exp = BigInt(bits >>> 24)
  const mant = BigInt(bits & 0x7fffff)
  return exp <= 3n ? mant >> (8n * (3n - exp)) : mant << (8n * (exp - 3n))
}
export const headerBits = (h: Bytes): number => (h[72] | (h[73] << 8) | (h[74] << 16) | (h[75] << 24)) >>> 0
export const displayHash = (h: Bytes): string => toHex([...hash256(h)].reverse())
const MAX_UINT256 = (1n << 256n) - 1n
export const easierBy = (target: bigint, factor: number): bigint => {
  const t = target * BigInt(factor)
  return t > MAX_UINT256 ? MAX_UINT256 : t
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Rebuild the 80-byte header from WhatsOnChain's JSON and check it hashes to the block hash. */
export function headerFromJson (j: any, height: number): Header {
  const bits = typeof j.bits === 'number' ? j.bits : parseInt(j.bits, 16)
  const bytes = concat(
    u32le(j.version >>> 0),
    fromHex(j.previousblockhash).reverse(),
    fromHex(j.merkleroot).reverse(),
    u32le(j.time), u32le(bits), u32le(j.nonce)
  )
  if (displayHash(bytes) !== String(j.hash).toLowerCase()) throw new Error(`Header ${height} did not hash to ${j.hash}`)
  return { height, bytes, time: headerTime(bytes), hash: String(j.hash).toLowerCase() }
}

// ---- live: WhatsOnChain + ARC --------------------------------------------------------------

export class LiveChain implements Chain {
  readonly dry = false
  private readonly base = 'https://api.whatsonchain.com/v1/bsv/main'
  private last = 0
  private readonly broadcaster: Broadcaster

  constructor (arcUrl = process.env.POK_ARC_URL ?? 'https://arc.gorillapool.io', arcKey = process.env.POK_ARC_KEY) {
    this.broadcaster = arcKey ? new ARC(arcUrl, arcKey) : new ARC(arcUrl)
  }

  private async get (path: string, as: 'json' | 'text' = 'json'): Promise<any> {
    const headers: Record<string, string> = {}
    if (process.env.POK_WOC_KEY) headers.Authorization = process.env.POK_WOC_KEY
    // Shared hosts such as Replit share outbound addresses, so the free rate limit can run out
    // because of other people's traffic. A 429, a 5xx or a dropped connection is retried with a
    // growing wait (about two and a half minutes in all); any other status is an answer.
    const waits = [2, 5, 10, 20, 40, 60]
    for (let attempt = 0; ; attempt++) {
      const gap = 400 - (Date.now() - this.last) // stay under the free 3 requests/second limit
      if (gap > 0) await sleep(gap)
      this.last = Date.now()
      let res: Response | undefined
      let why = ''
      try { res = await fetch(this.base + path, { headers }) } catch (e) { why = (e as Error).message }
      if (res && res.ok) return as === 'json' ? res.json() : res.text()
      const retryable = !res || res.status === 429 || res.status >= 500
      if (!retryable || attempt >= waits.length) throw new Error(`WhatsOnChain ${path} returned ${res ? res.status : why}`)
      const after = Number(res?.headers.get('retry-after'))
      const secs = Number.isFinite(after) && after > 0 ? Math.min(after, 120) : waits[attempt]
      process.stdout.write(`  WhatsOnChain ${res ? res.status : 'unreachable'}, retrying in ${secs} s…\n`)
      await sleep(secs * 1000)
    }
  }

  async tip (): Promise<Header> {
    const list = await this.get('/block/headers')
    if (!Array.isArray(list) || typeof list[0]?.height !== 'number') throw new Error('Unexpected /block/headers response')
    return this.header(list[0].height)
  }

  async header (height: number): Promise<Header> {
    return headerFromJson(await this.get(`/block/${height}/header`), height)
  }

  async coinbaseProof (height: number): Promise<CoinbaseProof> {
    const header = await this.header(height)
    const root = toHex(headerMerkleRoot(header.bytes))
    const block = await this.get(`/block/hash/${header.hash}`)
    const listed: string[] = Array.isArray(block?.tx) ? block.tx : []
    const count: number = block?.txcount ?? block?.num_tx ?? listed.length
    const first = listed[0]
    if (typeof first !== 'string') throw new Error(`WhatsOnChain listed no transactions for block ${height}`)
    const coinbase = fromHex(String(await this.get(`/tx/${first}/hex`, 'text')).trim())
    const txid = hash256(coinbase)
    if (toHex([...txid].reverse()) !== first) throw new Error(`The coinbase of block ${height} came back with a different id`)
    const checked = (path: Bytes[]) => toHex(foldCoinbasePath(txid, path)) === root ? path : undefined

    // 1. WhatsOnChain's TSC proof for the coinbase. Its node byte order is not documented
    //    consistently, so both orders are tried and only one that folds to the header is used.
    try {
      const tsc = await this.get(`/tx/${first}/proof/tsc`)
      const nodes: string[] = (Array.isArray(tsc) ? tsc[0] : tsc)?.nodes ?? []
      for (const reverse of [true, false]) {
        let cur = txid
        const path: Bytes[] = []
        for (const n of nodes) {
          const sib = n === '*' ? cur : (reverse ? fromHex(n).reverse() : fromHex(n))
          path.push(sib)
          cur = hash256(concat(cur, sib))
        }
        const ok = checked(path)
        if (ok) return { coinbase, path: ok }
      }
    } catch { /* fall through to the transaction list */ }

    // 2. The block's whole transaction list, paged for large blocks.
    const tries: string[][] = [listed]
    if (listed.length < count) {
      const pages: string[] = []
      for (let n = 1; pages.length < count && n <= Math.ceil(count / 1000) + 1; n++) {
        const page = await this.get(`/block/hash/${header.hash}/page/${n}`)
        if (!Array.isArray(page) || page.length === 0) break
        pages.push(...page)
      }
      tries.push(pages, [...listed, ...pages])
    }
    for (const ids of tries) {
      if (ids.length !== count || ids[0] !== first) continue
      const leaves = ids.map(id => fromHex(id).reverse())
      if (toHex(txMerkleRoot(leaves)) === root) return { coinbase, path: coinbasePath(leaves) }
    }
    throw new Error(`Could not build a coinbase path for block ${height} that matches its Merkle root`)
  }

  async getTx (txid: string): Promise<Transaction> {
    const hex = String(await this.get(`/tx/${txid}/hex`, 'text')).trim()
    const tx = Transaction.fromHex(hex)
    if (tx.id('hex') !== txid) throw new Error(`Transaction ${txid} came back with a different id`)
    return tx
  }

  async broadcast (tx: Transaction): Promise<{ ok: boolean | null, txid: string, detail: string }> {
    const r = await this.broadcaster.broadcast(tx)
    if (r.status === 'success') return { ok: true, txid: r.txid, detail: r.message }
    // @bsv/sdk 4.0.1 refuses replies whose fields it cannot validate, such as GorillaPool's
    // "competingTxs": null, and reports them as ERR_INVALID_RESPONSE. That says nothing about
    // whether ARC accepted the transaction, so it is returned as unknown.
    if (r.code === 'ERR_INVALID_RESPONSE') return { ok: null, txid: tx.id('hex'), detail: `${r.code}: ${r.description}` }
    return { ok: false, txid: r.txid ?? tx.id('hex'), detail: `${r.code}: ${r.description}` }
  }
}

// ---- dry run: an in-memory chain saved to disk between commands ------------------------------

const DRY_BITS = 0x207fffff // regtest difficulty, so headers mine instantly

type DryBlock = Header & { coinbase: Bytes, txids: Bytes[] }

export class DryChain implements Chain {
  readonly dry = true
  private headers: DryBlock[] = []
  private txs: Record<string, string> = {}

  constructor (private readonly file: string) {
    if (existsSync(file)) {
      const s = JSON.parse(readFileSync(file, 'utf8'))
      if (s.headers.some((h: any) => !h.coinbase)) throw new Error(`${file} was made before periods were pinned to heights. Delete ${dirname(file)} and start the dry run again.`)
      this.headers = s.headers.map((h: any) => ({ ...h, bytes: fromHex(h.hex), coinbase: fromHex(h.coinbase), txids: h.txids.map(fromHex) }))
      this.txs = s.txs
    } else {
      this.mine(Math.floor(Date.now() / 1000) - 600)
    }
  }

  private save () {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify({
      headers: this.headers.map(h => ({ height: h.height, hex: toHex(h.bytes), time: h.time, hash: h.hash, coinbase: toHex(h.coinbase), txids: h.txids.map(toHex) })),
      txs: this.txs
    }, null, 2))
  }

  /** Mine a block with the given timestamp at regtest difficulty: a BIP34 coinbase and five made-up transactions. */
  mine (time: number): Header {
    const prev = this.headers.at(-1)
    const height = (prev?.height ?? 973000) + 1
    const prevHash = prev ? [...hash256(prev.bytes)] : new Array(32).fill(0)
    const coinbase = makeCoinbase(height, u32le(time))
    const txids = [hash256(coinbase), ...Array.from({ length: 5 }, (_, i) => hash256(concat(u32le(height), u32le(i))))]
    const root = txMerkleRoot(txids)
    const target = bitsToTarget(DRY_BITS)
    for (let nonce = 0; ; nonce++) {
      const bytes = concat(u32le(0x20000000), prevHash, root, u32le(time), u32le(DRY_BITS), u32le(nonce))
      if (leToBigInt(hash256(bytes)) < target) {
        const h: DryBlock = { height, bytes, time, hash: displayHash(bytes), coinbase, txids }
        this.headers.push(h)
        this.save()
        return h
      }
    }
  }

  async tip (): Promise<Header> { return this.headers.at(-1)! }

  async header (height: number): Promise<Header> {
    const h = this.headers.find(x => x.height === height)
    if (!h) throw new Error(`no dry-run block at ${height}`)
    return h
  }

  async coinbaseProof (height: number): Promise<CoinbaseProof> {
    const h = this.headers.find(x => x.height === height)
    if (!h) throw new Error(`no dry-run block at ${height}`)
    return { coinbase: h.coinbase, path: coinbasePath(h.txids) }
  }

  /** Dry-run only: put a made-up funding transaction "on chain" and return its id. */
  fakeFunding (tx: Transaction): string {
    const id = tx.id('hex')
    this.txs[id] = tx.toHex()
    this.save()
    return id
  }

  async getTx (txid: string): Promise<Transaction> {
    if (!this.txs[txid]) throw new Error(`no dry-run transaction ${txid}`)
    return Transaction.fromHex(this.txs[txid])
  }

  async broadcast (tx: Transaction): Promise<{ ok: boolean, txid: string, detail: string }> {
    const id = tx.id('hex')
    tx.toHexEF() // what ARC would be sent; throws if any input is missing its source transaction
    this.txs[id] = tx.toHex()
    this.save()
    return { ok: true, txid: id, detail: 'DRY RUN: recorded locally, not broadcast' }
  }
}
