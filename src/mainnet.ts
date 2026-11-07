// Proof of Keep mainnet test.
//
// Funds one small development deal (env byte 0x00) that stores the white paper, then:
//   period A: the operator claims it through the keep path with a real block header
//   period B: nobody claims it, and the steward sweeps it through the lapse path
// Every payment comes back to the same low-float address, and `withdraw` returns the lot.
//
//   npm run mainnet -- setup                 make or show the test key and address
//   npm run mainnet -- fund <txid>           build and broadcast the deal from a payment to that address
//   npm run mainnet -- claim                 wait for a block in A's window, then claim A
//   npm run mainnet -- sweep [A|B]           wait for the lapse time, then sweep (default B)
//   npm run mainnet -- status                where everything stands
//   npm run mainnet -- rebroadcast           resend anything stored but not yet accepted
//   npm run mainnet -- withdraw <address>    send everything left back to your wallet
//
// Add --dry-run to any command to rehearse against a local fake chain. Nothing is broadcast and
// nothing costs money; dry-run state lives in .pok-dryrun/, separate from real state.
import { PrivateKey, P2PKH, Transaction, LockingScript, UnlockingScript, Spend, KeyDeriver, OP, SatoshisPerKilobyte, TransactionOutput } from '@bsv/sdk'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bytes, sha256, toHex, fromHex, u32le } from './bytes.js'
import { encode } from './erasure.js'
import { FileTree } from './merkle.js'
import { challengeIndices, meetsTarget } from './beacon.js'
import { PeriodTerms, periodLockingScript, keepUnlockingScript, lapseUnlockingScript, push, Proof } from './script.js'
import { Chain, LiveChain, DryChain, Header, bitsToTarget, headerBits, easierBy } from './chain.js'

// ---- settings -------------------------------------------------------------------------------
const args = process.argv.slice(2).filter(a => a !== '--dry-run')
const DRY = process.argv.includes('--dry-run') || process.env.POK_DRY_RUN === '1'
const DIR = DRY ? '.pok-dryrun' : '.pok-mainnet'
const STATE = join(DIR, 'state.json')
const FILE_COPY = join(DIR, 'file.bin')
const DEAL_FILE = process.env.POK_FILE ?? 'proof-of-keep-whitepaper.md'
const PERIOD_SATS = Number(process.env.POK_PERIOD_SATS ?? 10_000)
const MIN_FUNDING = 2 * PERIOD_SATS + 5_000
const SAMPLES = 16
const KEEP_FLOOR = 64     // keep path accepts headers 64x easier than the network's current target
const LAPSE_FLOOR = 1024
const HOUR = 3600
const WOC = 'https://whatsonchain.com/tx/'

const feeModel = DRY ? new SatoshisPerKilobyte(100) : undefined // undefined = SDK LivePolicy from ARC
const chain: Chain = DRY ? new DryChain(join(DIR, 'chain.json')) : new LiveChain()

// ---- state ----------------------------------------------------------------------------------
type Status = 'submitted' | 'accepted' | 'rejected'
interface Sent { hex: string, txid: string, status: Status, detail: string }
interface PeriodState {
  label: 'A' | 'B'
  purpose: string
  vout: number
  sats: number
  terms: Record<string, string | number>
  spend?: Sent & { path: 'keep' | 'lapse', header: { height: number, hash: string } }
}
interface State {
  network: 'main' | 'dry'
  createdAt: string
  address: string
  file: { name: string, length: number, sha256: string, chunkSize: number, k: number, n: number, root: string }
  fundedAtHeight: number
  funding?: Sent & { sourceTxid: string }
  periods: PeriodState[]
  withdrawals: Sent[]
}

const load = (): State | undefined => existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : undefined
const save = (s: State) => { mkdirSync(DIR, { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)) }
const need = (): State => {
  const s = load()
  if (!s) throw new Error(`No deal yet. Run: npm run mainnet -- fund <txid>${DRY ? ' --dry-run' : ''}`)
  return s
}

const termsOut = (t: PeriodTerms): Record<string, string | number> => ({
  root: toHex(t.root), chunkCount: t.chunkCount, depth: t.depth, samples: t.samples,
  windowStart: t.windowStart, windowEnd: t.windowEnd, keepTarget: t.keepTarget.toString(16),
  operatorKey: toHex(t.operatorKey), lapseTime: t.lapseTime, lapseTarget: t.lapseTarget.toString(16),
  stewardKey: toHex(t.stewardKey)
})
const termsIn = (r: Record<string, string | number>): PeriodTerms => ({
  root: fromHex(r.root as string), chunkCount: r.chunkCount as number, depth: r.depth as number,
  samples: r.samples as number, windowStart: r.windowStart as number, windowEnd: r.windowEnd as number,
  keepTarget: BigInt('0x' + r.keepTarget), operatorKey: fromHex(r.operatorKey as string),
  lapseTime: r.lapseTime as number, lapseTarget: BigInt('0x' + r.lapseTarget), stewardKey: fromHex(r.stewardKey as string)
})

// ---- keys -----------------------------------------------------------------------------------
function rootKey (): PrivateKey {
  const wif = process.env.POK_WIF ?? (DRY && existsSync(join(DIR, 'dry.wif')) ? readFileSync(join(DIR, 'dry.wif'), 'utf8').trim() : undefined)
  if (wif) return PrivateKey.fromWif(wif)
  if (DRY) {
    const k = PrivateKey.fromRandom()
    mkdirSync(DIR, { recursive: true }); writeFileSync(join(DIR, 'dry.wif'), k.toWif())
    return k
  }
  throw new Error('POK_WIF is not set. Run: npm run mainnet -- setup')
}
const PROTOCOL: [0, string] = [0, 'proof of keep test']
const keys = () => {
  const root = rootKey()
  const kd = new KeyDeriver(root)
  return {
    root,
    operator: kd.derivePrivateKey(PROTOCOL, 'operator', 'self'),
    steward: kd.derivePrivateKey(PROTOCOL, 'steward', 'self')
  }
}
const payBack = (root: PrivateKey) => new P2PKH().lock(root.toAddress())

// ---- the stored file --------------------------------------------------------------------------
function chunksOf (bytes: Bytes) {
  const pow2 = (x: number) => 2 ** Math.ceil(Math.log2(x))
  const chunkSize = Math.max(64, pow2(Math.ceil(bytes.length / 128))) // GF(2^8) code: at most 128 data chunks
  const k = Math.ceil(bytes.length / chunkSize)
  const data = Array.from({ length: k }, (_, i) => {
    const c = bytes.slice(i * chunkSize, (i + 1) * chunkSize)
    while (c.length < chunkSize) c.push(0)
    return c
  })
  const chunks = encode(data, 2 * k)
  return { chunkSize, k, n: 2 * k, chunks, tree: new FileTree(chunks) }
}

function dealRecord (s: State['file'], root: Bytes): LockingScript {
  const u64 = (n: number) => [...u32le(n % 2 ** 32), ...u32le(Math.floor(n / 2 ** 32))]
  const packed = [
    0x01, // protocol version
    0x00, // env: development
    0x01, // tree construction version
    0x01, // layout: full copies
    1, 1, // r operators, q needed
    ...u32le(s.k), ...u32le(s.n), ...u32le(s.chunkSize),
    0x00, // code: prototype Reed-Solomon over GF(2^8), development deals only
    ...u64(s.length), ...fromHex(s.sha256), ...root
  ]
  return new LockingScript([{ op: OP.OP_FALSE }, { op: OP.OP_RETURN }, push([...Buffer.from('POK')]), push(packed)])
}

// ---- transaction helpers ------------------------------------------------------------------------
function verifyInput (tx: Transaction, i: number) {
  const input = tx.inputs[i]
  const src = input.sourceTransaction!
  const out = src.outputs[input.sourceOutputIndex]
  const ok = new Spend({
    sourceTXID: src.id('hex'), sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: out.satoshis ?? 0, lockingScript: out.lockingScript,
    transactionVersion: tx.version, otherInputs: [], allInputs: tx.inputs,
    outputs: tx.outputs, inputIndex: i, unlockingScript: input.unlockingScript!,
    inputSequence: input.sequence ?? 0xffffffff, lockTime: tx.lockTime
  }).validate()
  if (!ok) throw new Error(`input ${i} failed local script check`)
}

/** An unlocking template that signs like P2PKH, then wraps the signature in our own script. */
const wrapSig = (key: PrivateKey, out: TransactionOutput, build: (sig: Bytes) => UnlockingScript) => ({
  sign: async (tx: Transaction, i: number) => {
    const base = await new P2PKH().unlock(key, 'all', false, out.satoshis, out.lockingScript).sign(tx, i)
    return build(base.chunks[0].data as Bytes)
  },
  estimateLength: async () => build(new Array(73).fill(0)).toBinary().length
})

async function send (tx: Transaction, record: (s: Sent) => void, label: string): Promise<Sent> {
  const sent: Sent = { hex: tx.toHex(), txid: tx.id('hex'), status: 'submitted', detail: '' }
  record(sent) // stored before broadcasting, so an unclear outcome is rebroadcast rather than rebuilt
  console.log(`${label}: ${sent.txid} (${tx.toBinary().length} bytes, fee ${await tx.getFee()} sats)`)
  try {
    const r = await chain.broadcast(tx)
    if (r.ok === null) {
      // the reply was unreadable, so ask WhatsOnChain whether the network has the transaction
      sent.detail = `ARC's reply could not be read (${r.detail}).`
      if (await seenByWoc(sent.txid)) {
        sent.status = 'accepted'
        sent.detail += ' WhatsOnChain has the transaction, so the network accepted it.'
      } else {
        sent.detail += ' WhatsOnChain has not seen it yet. Run status in a minute.'
      }
    } else {
      sent.status = r.ok ? 'accepted' : 'rejected'
      sent.detail = r.detail
    }
  } catch (e) {
    sent.detail = `no clear answer from the broadcaster: ${(e as Error).message}. Run rebroadcast.`
  }
  record(sent)
  console.log(`  ${sent.status.toUpperCase()}  ${sent.detail}`)
  if (sent.status === 'accepted' && !DRY) console.log(`  ${WOC}${sent.txid}`)
  return sent
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** WhatsOnChain can take a few seconds to index a new transaction, so look a few times. */
async function seenByWoc (txid: string, tries = 5): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await chain.getTx(txid).then(() => true, () => false)) return true
    if (i < tries - 1) await sleep(3000)
  }
  return false
}
const when = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z')

// ---- commands ---------------------------------------------------------------------------------
async function setup () {
  if (!process.env.POK_WIF && !DRY) {
    const k = PrivateKey.fromRandom()
    console.log('New test key. Save this as a Replit Secret named POK_WIF, then run setup again:\n')
    console.log(`  POK_WIF = ${k.toWif()}\n`)
    console.log('Treat it as a throwaway wallet. Never put more than a few pence in it.')
    return
  }
  const { root } = keys()
  console.log(`Test address: ${root.toAddress()}`)
  console.log(`Send it at least ${MIN_FUNDING.toLocaleString()} sats (about 30,000 is plenty), then run:`)
  console.log(`  npm run mainnet -- fund <txid of that payment>${DRY ? ' --dry-run' : ''}`)
}

async function fund (txidArg?: string) {
  if (load()?.funding) throw new Error(`A deal already exists in ${DIR}. Run status.`)
  const { root, operator, steward } = keys()
  let txid = txidArg
  if (DRY && !txid) {
    const fake = new Transaction()
    fake.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
    fake.addOutput({ lockingScript: payBack(root), satoshis: 50_000 })
    txid = (chain as DryChain).fakeFunding(fake)
    console.log(`Dry run: made a pretend 50,000-sat payment to ${root.toAddress()}`)
  }
  if (!txid) throw new Error('Give the txid of the payment to your test address: fund <txid>')

  const source = await chain.getTx(txid)
  const mine = payBack(root).toHex()
  const outs = source.outputs.map((o, i) => ({ o, i })).filter(({ o }) => o.lockingScript.toHex() === mine)
  const total = outs.reduce((a, { o }) => a + (o.satoshis ?? 0), 0)
  if (outs.length === 0) throw new Error(`Transaction ${txid} does not pay ${root.toAddress()}`)
  if (total < MIN_FUNDING) throw new Error(`Only ${total} sats arrived; need at least ${MIN_FUNDING}`)

  // the file
  const bytes = [...readFileSync(DEAL_FILE)]
  const { chunkSize, k, n, tree } = chunksOf(bytes)
  mkdirSync(DIR, { recursive: true }); writeFileSync(FILE_COPY, Buffer.from(bytes))
  const fileInfo = { name: DEAL_FILE, length: bytes.length, sha256: toHex(sha256(bytes)), chunkSize, k, n, root: toHex(tree.root) }

  // the windows start just after the current tip, so only a block mined after funding can claim
  const tip = await chain.tip()
  const target = bitsToTarget(headerBits(tip.bytes))
  const S = tip.time + 1
  const common = {
    root: tree.root, chunkCount: tree.count, depth: tree.depth, samples: SAMPLES,
    keepTarget: easierBy(target, KEEP_FLOOR), lapseTarget: easierBy(target, LAPSE_FLOOR),
    operatorKey: operator.toPublicKey().encode(true) as Bytes, stewardKey: steward.toPublicKey().encode(true) as Bytes
  }
  const A: PeriodTerms = { ...common, windowStart: S, windowEnd: S + 3 * HOUR, lapseTime: S + 6 * HOUR }
  const B: PeriodTerms = { ...common, windowStart: S, windowEnd: S + HOUR / 2, lapseTime: S + HOUR }

  const tx = new Transaction()
  for (const { i } of outs) tx.addInput({ sourceTransaction: source, sourceOutputIndex: i, sequence: 0xffffffff, unlockingScriptTemplate: new P2PKH().unlock(root) })
  tx.addOutput({ lockingScript: dealRecord(fileInfo, tree.root), satoshis: 0 })
  tx.addOutput({ lockingScript: periodLockingScript(A), satoshis: PERIOD_SATS })
  tx.addOutput({ lockingScript: periodLockingScript(B), satoshis: PERIOD_SATS })
  tx.addOutput({ lockingScript: payBack(root), change: true })
  await tx.fee(feeModel)
  await tx.sign()
  tx.inputs.forEach((_, i) => verifyInput(tx, i))

  const state: State = {
    network: DRY ? 'dry' : 'main', createdAt: new Date().toISOString(), address: root.toAddress(),
    file: fileInfo, fundedAtHeight: tip.height, withdrawals: [],
    periods: [
      { label: 'A', purpose: 'operator claims through the keep path', vout: 1, sats: PERIOD_SATS, terms: termsOut(A) },
      { label: 'B', purpose: 'steward sweeps through the lapse path', vout: 2, sats: PERIOD_SATS, terms: termsOut(B) }
    ]
  }
  console.log(`Deal: ${fileInfo.name}, ${bytes.length} bytes as ${n} chunks of ${chunkSize} B, root ${fileInfo.root.slice(0, 16)}…`)
  console.log(`Period scripts: ${periodLockingScript(A).toBinary().length} bytes each`)
  await send(tx, sent => { state.funding = { ...sent, sourceTxid: txid! }; save(state) }, 'Funding')
  if (state.funding?.status === 'accepted') {
    console.log(`\nA: claim window ${when(A.windowStart)} to ${when(A.windowEnd)}. Next: npm run mainnet -- claim${DRY ? ' --dry-run' : ''}`)
    console.log(`B: steward can sweep from ${when(B.lapseTime)}. Then: npm run mainnet -- sweep B${DRY ? ' --dry-run' : ''}`)
  }
}

async function findHeader (pick: (h: Header) => boolean, from: number, until: number, mineAt: (tip: Header) => number): Promise<Header> {
  const seen = new Map<number, Header>()
  for (;;) {
    const tip = await chain.tip()
    for (let h = Math.max(from, tip.height - 40); h <= tip.height; h++) {
      if (!seen.has(h)) seen.set(h, h === tip.height ? tip : await chain.header(h))
      if (pick(seen.get(h)!)) return seen.get(h)!
    }
    if (DRY) { (chain as DryChain).mine(mineAt(tip)); continue }
    if (Date.now() / 1000 > until) throw new Error('No qualifying block appeared in time.')
    process.stdout.write(`  ${new Date().toISOString().slice(11, 19)} tip ${tip.height} at ${when(tip.time)}, waiting…\n`)
    await sleep(60_000)
  }
}

function period (s: State, label: string): PeriodState {
  const p = s.periods.find(x => x.label === label.toUpperCase())
  if (!p) throw new Error(`No period ${label}`)
  if (s.funding?.status !== 'accepted') throw new Error('The funding transaction has not been accepted. Run status.')
  if (p.spend && p.spend.status !== 'rejected') throw new Error(`Period ${p.label} already has a ${p.spend.path} spend (${p.spend.status}). Run status or rebroadcast.`)
  return p
}

async function claim () {
  const s = need()
  const p = period(s, 'A')
  const t = termsIn(p.terms)
  const { root, operator } = keys()
  const { chunks, tree } = chunksOf([...readFileSync(FILE_COPY)])
  if (toHex(tree.root) !== toHex(t.root)) throw new Error('The stored file no longer matches the deal root')

  console.log(`Looking for a block with a timestamp in ${when(t.windowStart)} to ${when(t.windowEnd)}…`)
  const header = await findHeader(
    h => h.time >= t.windowStart && h.time < t.windowEnd && meetsTarget(h.bytes, t.keepTarget),
    s.fundedAtHeight + 1, t.windowEnd + 2 * HOUR, tip => Math.max(t.windowStart, tip.time + 1))
  console.log(`Using block ${header.height} (${header.hash}), time ${when(header.time)}`)

  const proofs: Proof[] = challengeIndices(header.bytes, tree.root, tree.count, t.samples)
    .map(i => ({ chunk: chunks[i], siblings: tree.path(i) }))
  const funding = Transaction.fromHex(s.funding!.hex)
  const out = funding.outputs[p.vout]
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: funding, sourceOutputIndex: p.vout, sequence: 0xffffffff,
    unlockingScriptTemplate: wrapSig(operator, out, sig => keepUnlockingScript(sig, header.bytes, proofs)) })
  tx.addOutput({ lockingScript: payBack(root), change: true })
  await tx.fee(feeModel)
  await tx.sign()
  verifyInput(tx, 0)
  console.log('Claim passes the local script check.')
  await send(tx, sent => { p.spend = { ...sent, path: 'keep', header: { height: header.height, hash: header.hash } }; save(s) }, 'Claim A')
}

async function sweep (label = 'B') {
  const s = need()
  const p = period(s, label)
  const t = termsIn(p.terms)
  const { root, steward } = keys()
  console.log(`Period ${p.label} lapses at ${when(t.lapseTime)}. Waiting for a block at or after that…`)
  const header = await findHeader(
    h => h.time >= t.lapseTime && meetsTarget(h.bytes, t.lapseTarget),
    s.fundedAtHeight + 1, Infinity, tip => Math.max(t.lapseTime, tip.time + 1))
  console.log(`Using block ${header.height} (${header.hash}), time ${when(header.time)}`)

  const funding = Transaction.fromHex(s.funding!.hex)
  const out = funding.outputs[p.vout]
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: funding, sourceOutputIndex: p.vout, sequence: 0xffffffff,
    unlockingScriptTemplate: wrapSig(steward, out, sig => lapseUnlockingScript(sig, header.bytes)) })
  tx.addOutput({ lockingScript: payBack(root), change: true })
  await tx.fee(feeModel)
  await tx.sign()
  verifyInput(tx, 0)
  console.log('Sweep passes the local script check.')
  await send(tx, sent => { p.spend = { ...sent, path: 'lapse', header: { height: header.height, hash: header.hash } }; save(s) }, `Sweep ${p.label}`)
}

async function status () {
  const s = need()
  const now = Math.floor(Date.now() / 1000)
  console.log(`${s.network === 'dry' ? 'DRY RUN ' : ''}deal created ${s.createdAt}`)
  console.log(`Address ${s.address}`)
  console.log(`File ${s.file.name}: ${s.file.length} bytes, ${s.file.n} chunks of ${s.file.chunkSize} B`)
  const line = (name: string, x?: Sent) => console.log(x
    ? `${name}: ${x.status}  ${x.txid}${x.detail ? `\n    ${x.detail}` : ''}`
    : `${name}: not sent`)
  line('Funding', s.funding)
  for (const p of s.periods) {
    const t = termsIn(p.terms)
    console.log(`\nPeriod ${p.label} (${p.sats} sats): ${p.purpose}`)
    console.log(`  window ${when(t.windowStart)} to ${when(t.windowEnd)}, lapse ${when(t.lapseTime)}${now >= t.lapseTime ? ' (open now)' : ''}`)
    line(`  ${p.spend ? p.spend.path : 'spend'}`, p.spend)
  }
  for (const w of s.withdrawals) line('\nWithdrawal', w)
  if (!DRY) {
    // WhatsOnChain is the ground truth: a transaction it has seen was accepted by the network,
    // whatever the broadcaster's reply said, so the record is corrected and saved.
    const all = [s.funding, ...s.periods.map(p => p.spend), ...s.withdrawals].filter(Boolean) as Sent[]
    let changed = false
    console.log('')
    for (const x of all) {
      const seen = await chain.getTx(x.txid).then(() => true, () => false)
      console.log(`${x.txid.slice(0, 12)}… ${seen ? 'seen by WhatsOnChain' : 'not seen by WhatsOnChain yet'}`)
      if (seen && x.status !== 'accepted') {
        console.log(`  was recorded as ${x.status}; now marked accepted`)
        x.status = 'accepted'
        x.detail = `${x.detail ? x.detail + ' ' : ''}Later found on WhatsOnChain, so marked accepted.`
        changed = true
      }
    }
    if (changed) save(s)
  }
}

/** Give a stored transaction back its source transactions, so ARC gets the extended format. */
async function withSources (s: State, hex: string): Promise<Transaction> {
  const tx = Transaction.fromHex(hex)
  const known = [s.funding, ...s.periods.map(p => p.spend), ...s.withdrawals].filter(Boolean) as Sent[]
  for (const input of tx.inputs) {
    const k = known.find(x => x.txid === input.sourceTXID)
    input.sourceTransaction = k ? Transaction.fromHex(k.hex) : await chain.getTx(input.sourceTXID!)
  }
  return tx
}

async function rebroadcast () {
  const s = need()
  const items: Array<[string, Sent, (x: Sent) => void]> = []
  if (s.funding && s.funding.status === 'submitted') items.push(['Funding', s.funding, x => { s.funding = { ...s.funding!, ...x } }])
  for (const p of s.periods) if (p.spend?.status === 'submitted') items.push([`Period ${p.label}`, p.spend, x => { p.spend = { ...p.spend!, ...x } }])
  s.withdrawals.forEach((w, i) => { if (w.status === 'submitted') items.push(['Withdrawal', w, x => { s.withdrawals[i] = x }]) })
  if (items.length === 0) { console.log('Nothing waiting to be resent.'); return }
  for (const [label, sent, set] of items) {
    const tx = await withSources(s, sent.hex)
    await send(tx, x => { set(x); save(s) }, label)
  }
}

async function withdraw (address?: string) {
  if (!address) throw new Error('Give the address to send everything to: withdraw <address>')
  const s = need()
  const { root } = keys()
  const mine = payBack(root).toHex()
  const sources = [s.funding, ...s.periods.map(p => p.spend)].filter(x => x?.status === 'accepted') as Sent[]
  const spent = new Set(s.withdrawals.filter(w => w.status !== 'rejected')
    .flatMap(w => Transaction.fromHex(w.hex).inputs.map(i => `${i.sourceTXID}:${i.sourceOutputIndex}`)))
  const tx = new Transaction()
  let total = 0
  for (const src of sources) {
    const t = Transaction.fromHex(src.hex)
    t.outputs.forEach((o, i) => {
      if (o.lockingScript.toHex() === mine && !spent.has(`${src.txid}:${i}`)) {
        tx.addInput({ sourceTransaction: t, sourceOutputIndex: i, sequence: 0xffffffff, unlockingScriptTemplate: new P2PKH().unlock(root) })
        total += o.satoshis ?? 0
      }
    })
  }
  if (tx.inputs.length === 0) { console.log('Nothing left to withdraw.'); return }
  tx.addOutput({ lockingScript: new P2PKH().lock(address), change: true })
  await tx.fee(feeModel)
  await tx.sign()
  tx.inputs.forEach((_, i) => verifyInput(tx, i))
  console.log(`Withdrawing ${total} sats from ${tx.inputs.length} outputs to ${address}`)
  const i = s.withdrawals.length
  await send(tx, sent => { s.withdrawals[i] = sent; save(s) }, 'Withdrawal')
}

// ---- main ---------------------------------------------------------------------------------------
const commands: Record<string, (arg?: string) => Promise<void>> = { setup, fund, claim, sweep, status, rebroadcast, withdraw }
const [cmd, arg] = args
const run = commands[cmd ?? '']
if (!run) {
  console.log('Commands: setup | fund <txid> | claim | sweep [A|B] | status | rebroadcast | withdraw <address>   (add --dry-run to rehearse)')
  process.exit(cmd ? 1 : 0)
}
if (DRY) console.log('DRY RUN: local fake chain, nothing is broadcast.\n')
run(arg).catch(e => { console.error(`\n${(e as Error).message}`); process.exit(1) })
