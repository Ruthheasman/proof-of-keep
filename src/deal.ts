// Glue: build a funding transaction holding period UTXOs, and spend one through the SDK interpreter.
import { Transaction, P2PKH, PrivateKey, Spend, UnlockingScript } from '@bsv/sdk'
import { Bytes } from './bytes.js'
import { PeriodTerms, periodLockingScript, keepUnlockingScript, lapseUnlockingScript, Proof } from './script.js'

export function fundingTx (terms: PeriodTerms[], satsEach: number): Transaction {
  // The parent is a stand-in: the test exercises the period scripts, not the funding input.
  const parent = new Transaction()
  parent.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: satsEach * terms.length + 1000 })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
  for (const t of terms) tx.addOutput({ lockingScript: periodLockingScript(t), satoshis: satsEach })
  return tx
}

type Path = { kind: 'keep', header: Bytes, proofs: Proof[] } | { kind: 'lapse', header: Bytes }

/** Spend output `vout` of `funding` to a P2PKH, signed by `key`, and run it through the interpreter. */
export async function trySpend (funding: Transaction, vout: number, key: PrivateKey, path: Path):
Promise<{ ok: boolean, error?: string, unlockingBytes: number, txBytes: number }> {
  const out = funding.outputs[vout]
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: funding,
    sourceOutputIndex: vout,
    sequence: 0xffffffff,
    unlockingScriptTemplate: {
      sign: async (t: Transaction, i: number) => {
        const base = await new P2PKH().unlock(key, 'all', false, out.satoshis, out.lockingScript).sign(t, i)
        const sig = base.chunks[0].data as Bytes
        return path.kind === 'keep'
          ? keepUnlockingScript(sig, path.header, path.proofs)
          : lapseUnlockingScript(sig, path.header)
      },
      estimateLength: async () => 0
    }
  })
  tx.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: (out.satoshis ?? 0) - 1 })
  await tx.sign()
  const input = tx.inputs[0]
  const spend = new Spend({
    sourceTXID: funding.id('hex'),
    sourceOutputIndex: vout,
    sourceSatoshis: out.satoshis ?? 0,
    lockingScript: out.lockingScript,
    transactionVersion: tx.version,
    otherInputs: [],
    outputs: tx.outputs,
    inputIndex: 0,
    unlockingScript: input.unlockingScript!,
    inputSequence: input.sequence ?? 0xffffffff,
    lockTime: tx.lockTime
  })
  const unlockingBytes = input.unlockingScript!.toBinary().length
  const txBytes = tx.toBinary().length
  try {
    return { ok: spend.validate(), unlockingBytes, txBytes }
  } catch (e) {
    return { ok: false, error: (e as Error).message.split('\n')[0].slice(0, 160), unlockingBytes, txBytes }
  }
}
