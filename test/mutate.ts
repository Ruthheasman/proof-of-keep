// Mutation check: break the locking script one rule at a time and confirm the suite goes red.
// A mutation that survives means some rule has no test behind it.
// npx tsx test/mutate.ts
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = new URL('..', import.meta.url).pathname
const source = readFileSync(join(root, 'src/script.ts'), 'utf8')

const mutations: Array<[string, string, string]> = [
  ['no pinned-height check', 'push(hp), op(OP.OP_EQUALVERIFY), // its scriptSig opens with the pinned height', 'op(OP.OP_DROP), // its scriptSig opens with the pinned height'],
  ['no coinbase input check', 'push(COINBASE_INPUT), op(OP.OP_EQUALVERIFY), // a coinbase', 'op(OP.OP_DROP), // a coinbase'],
  ['coinbase not tied to the header', 'op(OP.OP_ROT), op(OP.OP_EQUALVERIFY) // [header]', 'op(OP.OP_ROT), op(OP.OP_2DROP) // [header]'],
  ['coinbase path folded in the wrong order', 'op(OP.OP_CAT), op(OP.OP_HASH256), // the coinbase is always the left child', 'op(OP.OP_SWAP), op(OP.OP_CAT), op(OP.OP_HASH256), // the coinbase is always the left child'],
  ['no keep PoW floor', '...powCheck(t.keepTarget), op(OP.OP_TOALTSTACK)', 'op(OP.OP_TOALTSTACK)'],
  ['no operator signature', 'push(t.operatorKey), op(OP.OP_CHECKSIG)', 'op(OP.OP_DROP), op(OP.OP_1)'],
  ['no root comparison', 'out.push(op(OP.OP_DROP), push(t.root), op(OP.OP_EQUALVERIFY))', 'out.push(op(OP.OP_2DROP))'],
  ['index not bound to header', 'op(OP.OP_FROMALTSTACK), op(OP.OP_DUP), op(OP.OP_TOALTSTACK),\n    push(t.root), op(OP.OP_CAT)', 'push(t.root)'],
  ['path ignores direction bits', 'op(OP.OP_IF), op(OP.OP_CAT), // cur is a right child', 'op(OP.OP_DROP), op(OP.OP_0), op(OP.OP_IF), op(OP.OP_CAT), // cur is a right child'],
  ['no leaf domain byte', 'ZERO_BYTE, op(OP.OP_SWAP), op(OP.OP_CAT), op(OP.OP_SHA256),\n    // index', 'op(OP.OP_SHA256),\n    // index'],
  ['no lapse time check', 'num(t.lapseTime), op(OP.OP_GREATERTHANOREQUAL), op(OP.OP_VERIFY),', 'op(OP.OP_DROP),'],
  ['no lapse PoW floor', '...powCheck(t.lapseTarget), op(OP.OP_DROP),', 'op(OP.OP_DROP),'],
  ['no steward signature', 'push(t.stewardKey), op(OP.OP_CHECKSIG)', 'op(OP.OP_DROP), op(OP.OP_1)']
]

let survived = 0
for (const [name, from, to] of mutations) {
  if (!source.includes(from)) { console.log(`HARNESS ERROR  pattern not found: ${name}`); process.exit(2) }
  const dir = mkdtempSync(join(tmpdir(), 'pok-mut-'))
  try {
    cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true })
    cpSync(join(root, 'test'), join(dir, 'test'), { recursive: true })
    cpSync(join(root, 'package.json'), join(dir, 'package.json'))
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'))
    writeFileSync(join(dir, 'src/script.ts'), source.replace(from, to))
    const run = spawnSync('npx', ['tsx', 'test/run.ts'], { cwd: dir, encoding: 'utf8', timeout: 300000 })
    if (run.signal || run.status === null) { console.log(`HARNESS ERROR  ${name}: runner died (${run.signal})`); process.exit(2) }
    const failed = (run.stdout.match(/^FAIL .*$/gm) ?? []).map(l => l.replace(/^FAIL\s+/, '').split('  — ')[0])
    if (run.status === 0) { survived++; console.log(`SURVIVED  ${name}`) } else console.log(`killed    ${name}  ← ${failed.join('; ')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
console.log(survived === 0 ? '\nEvery mutation was caught.' : `\n${survived} mutation(s) survived.`)
process.exit(survived === 0 ? 0 : 1)
