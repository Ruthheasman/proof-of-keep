// Chain access for the mainnet test: block headers and raw transactions from WhatsOnChain,
// broadcasting through ARC. A dry-run implementation stands in for both, so the whole flow can be
// rehearsed with no network and no money.
import { Transaction, ARC, Broadcaster } from '@bsv/sdk'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Bytes, concat, u32le, fromHex, toHex, hash256, leToBigInt } from './bytes.js'
import { headerTime } from './beacon.js'

export interface Header { height: number, bytes: Bytes, time: number, hash: string }

export interface Chain {
  readonly dry: boolean
  tip (): Promise<Header>
  header (height: number): Promise<Header>
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
    const wait = 400 - (Date.now() - this.last) // stay under the free 3 requests/second limit
    if (wait > 0) await sleep(wait)
    this.last = Date.now()
    const headers: Record<string, string> = {}
    if (process.env.POK_WOC_KEY) headers.Authorization = process.env.POK_WOC_KEY
    const res = await fetch(this.base + path, { headers })
    if (!res.ok) throw new Error(`WhatsOnChain ${path} returned ${res.status}`)
    return as === 'json' ? res.json() : res.text()
  }

  async tip (): Promise<Header> {
    const list = await this.get('/block/headers')
    if (!Array.isArray(list) || typeof list[0]?.height !== 'number') throw new Error('Unexpected /block/headers response')
    return this.header(list[0].height)
  }

  async header (height: number): Promise<Header> {
    return headerFromJson(await this.get(`/block/${height}/header`), height)
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

export class DryChain implements Chain {
  readonly dry = true
  private headers: Header[] = []
  private txs: Record<string, string> = {}

  constructor (private readonly file: string) {
    if (existsSync(file)) {
      const s = JSON.parse(readFileSync(file, 'utf8'))
      this.headers = s.headers.map((h: any) => ({ ...h, bytes: fromHex(h.hex) }))
      this.txs = s.txs
    } else {
      this.mine(Math.floor(Date.now() / 1000) - 600)
    }
  }

  private save () {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify({
      headers: this.headers.map(h => ({ height: h.height, hex: toHex(h.bytes), time: h.time, hash: h.hash })),
      txs: this.txs
    }, null, 2))
  }

  /** Mine a block with the given timestamp at regtest difficulty. */
  mine (time: number): Header {
    const prev = this.headers.at(-1)
    const prevHash = prev ? [...hash256(prev.bytes)] : new Array(32).fill(0)
    const target = bitsToTarget(DRY_BITS)
    for (let nonce = 0; ; nonce++) {
      const bytes = concat(u32le(0x20000000), prevHash, new Array(32).fill(7), u32le(time), u32le(DRY_BITS), u32le(nonce))
      if (leToBigInt(hash256(bytes)) < target) {
        const h = { height: (prev?.height ?? 973000) + 1, bytes, time, hash: displayHash(bytes) }
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
