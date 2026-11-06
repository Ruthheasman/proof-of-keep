// Runs every Proof of Keep v1 case through the @bsv/sdk script interpreter.
// npx tsx test/run.ts
import { PrivateKey } from '@bsv/sdk'
import { Bytes, randomBytes, fromHex, toHex } from '../src/bytes.js'
import { encode, decode } from '../src/erasure.js'
import { FileTree, checkPath } from '../src/merkle.js'
import { MAX_TARGET, targetForDifficulty, challengeIndices, mineHeader, headerTime, headerHash, meetsTarget } from '../src/beacon.js'
import { PeriodTerms, Proof, periodLockingScript } from '../src/script.js'
import { fundingTx, trySpend } from '../src/deal.js'
import { headerFromJson, bitsToTarget } from '../src/chain.js'

let failures = 0
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!cond) failures++
}

// Real mainnet headers (BSV shares Bitcoin's history to 2017). Hashes are checked below.
const GENESIS = fromHex('0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c')
const BLOCK1 = fromHex('010000006fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000982051fd1e4ba744bbbe680e1fee14677ba1a3c3540bf7b1cdb606e857233e0e61bc6649ffff001d01e36299')

const proofsFor = (tree: FileTree, chunks: Bytes[], header: Bytes, m: number): Proof[] =>
  challengeIndices(header, tree.root, tree.count, m).map(i => ({ chunk: chunks[i], siblings: tree.path(i) }))

async function main () {
  const rng = { s: 0x1234567 }
  const operator = PrivateKey.fromRandom()
  const steward = PrivateKey.fromRandom()
  const stranger = PrivateKey.fromRandom()

  // ---- headers -----------------------------------------------------------------------------
  check('genesis header hash', toHex([...headerHash(GENESIS)].reverse()) === '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f')
  check('block 1 header hash', toHex([...headerHash(BLOCK1)].reverse()) === '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048')

  // ---- headers as WhatsOnChain returns them (used by the mainnet test) ----------------------
  const b1 = headerFromJson({ hash: '00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048', version: 1,
    previousblockhash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
    merkleroot: '0e3e2357e806b6cdb1f70b54c3a3a17b6714ee1f0e68bebb44a74b1efd512098',
    time: 1231469665, bits: '1d00ffff', nonce: 2573394689 }, 1)
  check('header rebuilt from JSON matches the real block 1 bytes', toHex(b1.bytes) === toHex(BLOCK1))
  check('compact bits 1d00ffff expand to the difficulty-1 target', bitsToTarget(0x1d00ffff) === MAX_TARGET)

  // ---- file: 64 data chunks, rate-1/2 erasure code -> 128 chunks of 256 bytes ---------------
  const k = 64, n = 128, size = 256, m = 16
  const data = Array.from({ length: k }, () => randomBytes(size, rng))
  const chunks = encode(data, n)
  const tree = new FileTree(chunks)
  console.log(`\nfile: ${k} data + ${n - k} parity chunks of ${size} B, depth ${tree.depth}, root ${toHex(tree.root).slice(0, 16)}…`)

  // erasure: any half rebuilds the file, one fewer cannot
  const order = Array.from({ length: n }, (_, i) => i).sort(() => (randomBytes(1, rng)[0] - 128))
  const keepHalf = new Map(order.slice(0, k).map(i => [i, chunks[i]]))
  const rebuilt = decode(keepHalf, k)
  check('erasure: random half of chunks rebuilds the data', rebuilt.every((c, i) => toHex(c) === toHex(data[i])))
  let threw = false
  try { decode(new Map(order.slice(0, k - 1).map(i => [i, chunks[i]])), k) } catch { threw = true }
  check('erasure: one chunk short of half cannot rebuild', threw)

  // ---- deal terms --------------------------------------------------------------------------
  const base = {
    root: tree.root, chunkCount: tree.count, depth: tree.depth, samples: m,
    operatorKey: operator.toPublicKey().encode(true) as Bytes,
    stewardKey: steward.toPublicKey().encode(true) as Bytes
  }
  // Period 0: a window around the genesis block, floor = difficulty 1 (real 2009 headers meet it)
  const realTerms: PeriodTerms = {
    ...base, windowStart: 1231000000, windowEnd: 1231010000, keepTarget: MAX_TARGET,
    lapseTime: 1231400000, lapseTarget: MAX_TARGET
  }
  // Period 1: a 2030 window with a cheap test floor so we can mine headers locally
  const testTarget = targetForDifficulty(1 / 65536)
  const t2030 = 1893456000
  const testTerms: PeriodTerms = {
    ...base, windowStart: t2030, windowEnd: t2030 + 6 * 3600, keepTarget: testTarget,
    lapseTime: t2030 + 6 * 3600 + 14 * 86400, lapseTarget: testTarget
  }
  const funding = fundingTx([realTerms, testTerms], 5000)
  const lockBytes = periodLockingScript(realTerms).toBinary().length
  console.log(`period locking script: ${lockBytes} B (m=${m}, d=${tree.depth})\n`)

  // ---- keep path ---------------------------------------------------------------------------
  const honest = proofsFor(tree, chunks, GENESIS, m)
  check('off-chain path check agrees', honest.every((p, j) => checkPath(p.chunk, challengeIndices(GENESIS, tree.root, tree.count, m)[j], p.siblings, tree.root)))
  let r = await trySpend(funding, 0, operator, { kind: 'keep', header: GENESIS, proofs: honest })
  check('keep: operator, real genesis header in window, honest proofs', r.ok, r.error ?? `unlocking ${r.unlockingBytes} B, claim tx ${r.txBytes} B`)

  const inWindow = mineHeader(t2030 + 600, testTarget, 7)
  r = await trySpend(funding, 1, operator, { kind: 'keep', header: inWindow, proofs: proofsFor(tree, chunks, inWindow, m) })
  check('keep: operator, mined 2030 header in window', r.ok, r.error)

  const tampered = honest.map(p => ({ ...p, chunk: [...p.chunk] }))
  tampered[3].chunk[10] ^= 1
  r = await trySpend(funding, 0, operator, { kind: 'keep', header: GENESIS, proofs: tampered })
  check('keep rejects: one flipped bit in one chunk', !r.ok, r.error)

  const idx = challengeIndices(GENESIS, tree.root, tree.count, m)
  const wrongIdx = honest.map((p, j) => j === 5 ? { chunk: chunks[(idx[j] + 1) % n], siblings: tree.path((idx[j] + 1) % n) } : p)
  r = await trySpend(funding, 0, operator, { kind: 'keep', header: GENESIS, proofs: wrongIdx })
  check('keep rejects: valid chunk + path, but for a different index', !r.ok, r.error)

  const wrongSib = honest.map((p, j) => j === 0 ? { ...p, siblings: p.siblings.map((s, l) => l === 2 ? randomBytes(32, rng) : s) } : p)
  r = await trySpend(funding, 0, operator, { kind: 'keep', header: GENESIS, proofs: wrongSib })
  check('keep rejects: corrupted sibling hash', !r.ok, r.error)

  r = await trySpend(funding, 0, operator, { kind: 'keep', header: BLOCK1, proofs: proofsFor(tree, chunks, BLOCK1, m) })
  check('keep rejects: real header outside the window (block 1)', !r.ok, r.error)

  const lateTest = mineHeader(testTerms.windowEnd + 60, testTarget, 9)
  r = await trySpend(funding, 1, operator, { kind: 'keep', header: lateTest, proofs: proofsFor(tree, chunks, lateTest, m) })
  check('keep rejects: header one minute after window end', !r.ok, r.error)

  const weak = [...inWindow]; weak[76] ^= 0xff // break the nonce
  if (meetsTarget(weak, testTarget)) weak[77] ^= 0xff
  r = await trySpend(funding, 1, operator, { kind: 'keep', header: weak, proofs: proofsFor(tree, chunks, weak, m) })
  check('keep rejects: header below the PoW floor', !r.ok, r.error)

  r = await trySpend(funding, 0, stranger, { kind: 'keep', header: GENESIS, proofs: honest })
  check('keep rejects: correct proofs, signed by someone else', !r.ok, r.error)

  r = await trySpend(funding, 0, operator, { kind: 'keep', header: GENESIS, proofs: honest.slice(0, m - 1) })
  check('keep rejects: one proof short', !r.ok, r.error)

  // ---- lapse path --------------------------------------------------------------------------
  r = await trySpend(funding, 0, steward, { kind: 'lapse', header: BLOCK1 })
  check('lapse: steward, real header after lapse time (block 1)', r.ok, r.error)
  r = await trySpend(funding, 0, steward, { kind: 'lapse', header: GENESIS })
  check('lapse rejects: header before lapse time', !r.ok, r.error)
  r = await trySpend(funding, 0, operator, { kind: 'lapse', header: BLOCK1 })
  check('lapse rejects: signed by the operator', !r.ok, r.error)
  const weakLapse = mineHeader(testTerms.lapseTime + 1, testTarget, 11); weakLapse[76] ^= 0xff
  if (meetsTarget(weakLapse, testTarget)) weakLapse[77] ^= 0xff
  r = await trySpend(funding, 1, steward, { kind: 'lapse', header: weakLapse })
  check('lapse rejects: late header below the floor', !r.ok, r.error)

  // ---- a cheater who kept 40% of chunks ----------------------------------------------------
  // With m=16 they would need ~1/0.4^16 = 2.3 million floor-meeting headers per claim. To measure
  // the rate in reasonable time we use m=4 here (expected pass rate 0.4^4 = 2.56%).
  const kept = new Set(order.slice(0, Math.round(0.4 * n)))
  const trials = 20000, mSmall = 4
  let passes = 0
  for (let t = 0; t < trials; t++) {
    const fakeHeader = randomBytes(80, rng) // stands in for a fresh header each attempt
    if (challengeIndices(fakeHeader, tree.root, tree.count, mSmall).every(i => kept.has(i))) passes++
  }
  const f = kept.size / n
  const rate = passes / trials, expected = f ** mSmall
  check(`cheater pass rate matches f^m (f=${f.toFixed(3)}, m=${mSmall})`, Math.abs(rate - expected) < 4 * Math.sqrt(expected / trials),
    `measured ${(rate * 100).toFixed(2)}%, expected ${(expected * 100).toFixed(2)}%`)

  // ---- split layout: 5 operators, any 3 rebuild ---------------------------------------------
  // 48 data chunks encoded to 80; operator i holds chunks i, i+5, i+10 ... (16 each, 1.67x total)
  const q = 3, r5 = 5, kS = 48, nS = kS * r5 / q
  const sData = Array.from({ length: kS }, () => randomBytes(size, rng))
  const sChunks = encode(sData, nS)
  const shardOf = (op: number) => sChunks.map((c, i) => [i, c] as const).filter(([i]) => i % r5 === op)
  const combos: number[][] = []
  for (let a = 0; a < r5; a++) for (let b = a + 1; b < r5; b++) for (let c = b + 1; c < r5; c++) combos.push([a, b, c])
  const allRebuild = combos.every(ops => {
    const got = decode(new Map(ops.flatMap(shardOf)), kS)
    return got.every((c, i) => toHex(c) === toHex(sData[i]))
  })
  check(`split 3-of-5: every one of the ${combos.length} sets of 3 operators rebuilds the data`, allRebuild)
  threw = false
  try { decode(new Map([0, 1].flatMap(shardOf)), kS) } catch { threw = true }
  check('split 3-of-5: 2 operators cannot rebuild', threw)

  const shard0 = shardOf(0).map(([, c]) => c), shard1 = shardOf(1).map(([, c]) => c)
  const tree0 = new FileTree(shard0), tree1 = new FileTree(shard1)
  const shardTerms: PeriodTerms = { ...realTerms, root: tree0.root, chunkCount: tree0.count, depth: tree0.depth }
  const shardFunding = fundingTx([shardTerms], 5000)
  r = await trySpend(shardFunding, 0, operator, { kind: 'keep', header: GENESIS, proofs: proofsFor(tree0, shard0, GENESIS, m) })
  check('keep: operator claims against its own shard root', r.ok, r.error)
  r = await trySpend(shardFunding, 0, operator, { kind: 'keep', header: GENESIS, proofs: proofsFor(tree1, shard1, GENESIS, m) })
  check("keep rejects: another operator's shard", !r.ok, r.error)

  // ---- full-size tree: 65,535 chunks, depth 16 ---------------------------------------------
  const big = Array.from({ length: 65535 }, (_, i) => randomBytes(64, rng))
  const bigTree = new FileTree(big)
  const bigTerms: PeriodTerms = { ...realTerms, root: bigTree.root, chunkCount: bigTree.count, depth: bigTree.depth }
  const bigFunding = fundingTx([bigTerms], 5000)
  r = await trySpend(bigFunding, 0, operator, { kind: 'keep', header: GENESIS, proofs: proofsFor(bigTree, big, GENESIS, m) })
  const bigLock = periodLockingScript(bigTerms).toBinary().length
  check('keep: 65,535-chunk deal, depth 16, m=16', r.ok, r.error ?? `locking ${bigLock} B, unlocking ${r.unlockingBytes} B with 64 B chunks`)

  console.log(`\n${failures === 0 ? 'All checks passed.' : failures + ' check(s) failed.'}`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
