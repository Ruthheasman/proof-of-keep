// Numbers behind the white paper's security and cost sections. Every input is a named constant.
// npx tsx src/economics.ts
import { PeriodTerms, periodLockingScript } from './script.js'

// ---- network inputs (29 Oct 2026) ---------------------------------------------------------
const BSV_USD = 17.70          // CoinGecko, 29 Oct 2026
const SUBSIDY_BSV = 3.125      // block subsidy until block 1,050,000
const FEE_SAT_PER_KB = 1       // TAAL / GorillaPool rate since 2023; the SDK fetches the live rate
const HEADER_USD = SUBSIDY_BSV * BSV_USD // ~cost of one header at current difficulty

// ---- storage inputs -----------------------------------------------------------------------
const COLD_USD_GB_MONTH = 0.00099 // S3 Glacier Deep Archive list price
const HOT_USD_GB_MONTH = 0.023    // S3 Standard list price
const ERASURE_OVERHEAD = 2        // rate-1/2 code
const REPLICAS = 3
const MARGIN = 2                  // operator price over raw cost

const usd = (x: number) => x >= 100 ? `$${x.toFixed(0)}` : x >= 1 ? `$${x.toFixed(2)}` : x >= 0.01 ? `$${x.toFixed(3)}` : `$${x.toPrecision(2)}`
const sats = (usdAmt: number) => Math.round(usdAmt / BSV_USD * 1e8)

console.log(`One header at current difficulty ≈ ${SUBSIDY_BSV} BSV ≈ ${usd(HEADER_USD)}\n`)

// ---- 1. cost of forging one floor-meeting header, and the per-window cap ------------------
console.log('Floor (fraction of current difficulty) | forge one header | hashrate drop the floor survives')
for (const F of [1, 16, 64, 256, 1024]) {
  console.log(`1/${F} | ${usd(HEADER_USD / F)} | ${F}x`)
}

// ---- 2. grinding: holding less than half the encoded chunks (data unrecoverable) ----------
console.log('\nSamples m | headers to pass once holding 49% | cost at floor 1/64')
for (const m of [8, 12, 16, 24, 32]) {
  const headers = 1 / Math.pow(0.49, m)
  console.log(`${m} | ${headers.toExponential(2)} | ${usd(headers * HEADER_USD / 64)}`)
}
// free choice among real headers in a 6h window (~36 blocks)
const freeChance = 1 - Math.pow(1 - Math.pow(0.49, 16), 36)
console.log(`Chance a 49% holder passes using only the ~36 real headers in a 6h window (m=16): ${(freeChance * 100).toFixed(4)}%`)

// ---- 3. script and claim sizes ------------------------------------------------------------
const fakeTerms = (depth: number, samples: number): PeriodTerms => ({
  root: new Array(32).fill(7), chunkCount: 2 ** depth - 1, depth, samples,
  windowStart: 2000000000, windowEnd: 2000021600, keepTarget: 1n << 230n,
  operatorKey: [2, ...new Array(32).fill(9)], lapseTime: 2001231200, lapseTarget: 1n << 234n,
  stewardKey: [3, ...new Array(32).fill(8)]
})
console.log('\nChunk size | max raw file per deal (65,535 chunks, rate 1/2) | locking script | claim tx | claim fee')
for (const chunk of [4096, 65536, 262144, 524288]) {
  const d = 16, m = 16
  const lock = periodLockingScript(fakeTerms(d, m)).toBinary().length
  const unlock = 74 + m * (chunk + 5 + d * 33) + 81 + 1
  const claim = 10 + 32 + 4 + 5 + unlock + 4 + 1 + 8 + 26 + 4
  const maxRaw = 65535 * chunk / ERASURE_OVERHEAD
  console.log(`${chunk / 1024} KiB | ${(maxRaw / 2 ** 30).toFixed(2)} GiB | ${lock} B | ${(claim / 1e3).toFixed(0)} kB | ${Math.ceil(claim / 1000 * FEE_SAT_PER_KB)} sat`)
}

// ---- 4. endowment for 1 GiB, 50 years, monthly windows ------------------------------------
const years = 50
const endow = (perGbMonth: number, decline: number) => {
  let total = 0
  for (let y = 0; y < years; y++) total += 12 * perGbMonth * Math.pow(1 - decline, y)
  return total * ERASURE_OVERHEAD * REPLICAS * MARGIN
}
console.log(`\nEndowment for 1 GiB, ${years} years, ${REPLICAS} operators, rate-1/2 code, ${MARGIN}x margin`)
console.log('Storage tier | flat cost | 0.5%/yr decline (Arweave assumption) | 5%/yr decline')
for (const [name, c] of [['cold', COLD_USD_GB_MONTH], ['hot', HOT_USD_GB_MONTH]] as const) {
  console.log(`${name} (${usd(c)}/GB-month) | ${usd(endow(c, 0))} | ${usd(endow(c, 0.005))} | ${usd(endow(c, 0.05))}`)
}
const monthlyPerOp = COLD_USD_GB_MONTH * ERASURE_OVERHEAD * MARGIN
console.log(`Cold, per operator per month for 1 GiB: ${usd(monthlyPerOp)} = ${sats(monthlyPerOp)} sat`)

// ---- 5. on-chain overhead for that deal ---------------------------------------------------
const periods = years * 12
const lock = periodLockingScript(fakeTerms(16, 16)).toBinary().length
const fundingBytes = REPLICAS * periods * (lock + 9 + 3)
const claimBytes = 74 + 16 * (65536 + 5 + 16 * 33) + 200
const totalClaims = REPLICAS * periods
console.log(`\nOn-chain overhead, 1 GiB deal, 64 KiB chunks, monthly windows, ${years} years:`)
console.log(`  period UTXOs: ${REPLICAS * periods}, funding bytes ${(fundingBytes / 1e6).toFixed(1)} MB, fee ${Math.ceil(fundingBytes / 1000 * FEE_SAT_PER_KB)} sat (${usd(fundingBytes / 1000 * FEE_SAT_PER_KB / 1e8 * BSV_USD)})`)
console.log(`  claims: ${totalClaims} × ${(claimBytes / 1e3).toFixed(0)} kB, total fees ${Math.ceil(totalClaims * claimBytes / 1000 * FEE_SAT_PER_KB)} sat (${usd(totalClaims * claimBytes / 1000 * FEE_SAT_PER_KB / 1e8 * BSV_USD)})`)
console.log(`  UTXO-set footprint while unspent: up to ${(REPLICAS * periods * lock / 1e6).toFixed(1)} MB`)

// ---- 6. what one window may hold ----------------------------------------------------------
// The cap applies to the whole deal's payment per window, not per operator: one party holding
// several operator keys can use one forged header for all of their UTXOs in that window.
const SAFETY = 4 // hold at most a quarter of the forging cost per window
const cap = HEADER_USD / 64 / SAFETY
console.log(`\nPer-window cap for the whole deal (1/64 floor, ${SAFETY}x safety): ${usd(cap)}, i.e. ${usd(cap / REPLICAS)} per operator with ${REPLICAS} operators`)
console.log('Largest deal each window cadence can carry, cold tier:')
for (const [label, perMonth] of [['monthly', 1], ['weekly', 30.44 / 7], ['daily', 30.44]] as const) {
  const dealMonthlyPerGb = COLD_USD_GB_MONTH * ERASURE_OVERHEAD * MARGIN * REPLICAS
  const gb = cap * perMonth / dealMonthlyPerGb
  console.log(`  ${label}: up to ${gb.toFixed(0)} GiB`)
}

// ---- 7. full copies vs shards -------------------------------------------------------------
// Full copies: every operator holds the whole rate-1/2 encoded file (any one operator rebuilds).
// Shards: the file is encoded once so that any q of r operators' shares rebuild it; each operator
// holds 1/q of the file's size, and the total stored is r/q of the original.
type Layout = { name: string, operators: number, multiple: number, survives: number, perOperatorShare: number, maxChunksFraction: number }
const layouts: Layout[] = [
  { name: 'Full copies, 3 operators', operators: 3, multiple: 3 * ERASURE_OVERHEAD, survives: 2, perOperatorShare: ERASURE_OVERHEAD, maxChunksFraction: 1 / ERASURE_OVERHEAD },
  { name: 'Shards, any 2 of 3', operators: 3, multiple: 3 / 2, survives: 1, perOperatorShare: 1 / 2, maxChunksFraction: 2 / 3 },
  { name: 'Shards, any 2 of 4', operators: 4, multiple: 4 / 2, survives: 2, perOperatorShare: 1 / 2, maxChunksFraction: 2 / 4 },
  { name: 'Shards, any 3 of 5', operators: 5, multiple: 5 / 3, survives: 2, perOperatorShare: 1 / 3, maxChunksFraction: 3 / 5 },
  { name: 'Shards, any 4 of 7', operators: 7, multiple: 7 / 4, survives: 3, perOperatorShare: 1 / 4, maxChunksFraction: 4 / 7 }
]
const flatEndow = (multiple: number) => 12 * years * COLD_USD_GB_MONTH * multiple * MARGIN
console.log(`\nLayouts for 1 GiB over ${years} years, cold tier, ${MARGIN}x margin, monthly windows`)
console.log('Layout | stored | operator losses survived | cost (flat) | cost (0.5%/yr) | per operator per month | largest monthly deal under the cap | largest file per deal at 64 KiB chunks | v1 period UTXOs')
for (const l of layouts) {
  const declining = endow(COLD_USD_GB_MONTH, 0.005) / (ERASURE_OVERHEAD * REPLICAS) * l.multiple
  const perOp = COLD_USD_GB_MONTH * l.perOperatorShare * MARGIN
  const monthlyCapGb = cap / (COLD_USD_GB_MONTH * l.multiple * MARGIN)
  const maxFile = 65535 * 65536 * l.maxChunksFraction / 2 ** 30
  console.log(`${l.name} | ${l.multiple.toFixed(2)}x | ${l.survives} | ${usd(flatEndow(l.multiple))} | ${usd(declining)} | ${usd(perOp)} | ${monthlyCapGb.toFixed(0)} GiB | ${maxFile.toFixed(1)} GiB | ${l.operators * periods}`)
}
// Detection inside a shard: there is no per-shard slack, so any loss eats the deal's shared margin.
console.log('\nShard holder pass rate per claim (m=16):')
for (const f of [0.99, 0.95, 0.9, 0.8]) console.log(`  holding ${(f * 100).toFixed(0)}% of their shard: passes ${(Math.pow(f, 16) * 100).toFixed(1)}% of claims`)
