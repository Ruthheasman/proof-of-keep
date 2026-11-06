// Systematic Reed-Solomon erasure code over GF(2^8), chunk-wise.
//
// k data chunks are evaluations of a degree < k polynomial at x = 0..k-1 (one polynomial per byte
// column). Parity chunks are the same polynomial evaluated at x = k..n-1. Any k of the n chunks
// rebuild everything (MDS). GF(2^8) caps n at 256; production deals use GF(2^16) for up to 65,535
// chunks, which keeps the same property. This file exists to show the recovery claim holds.
import { Bytes } from './bytes.js'

const EXP = new Array<number>(512)
const LOG = new Array<number>(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
})()

const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])
const div = (a: number, b: number): number => {
  if (b === 0) throw new Error('divide by zero')
  return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255]
}

/** Lagrange basis weights for evaluating at `x` from known points `xs`. */
const weights = (xs: number[], x: number): number[] =>
  xs.map((xi, i) => {
    let num = 1, den = 1
    xs.forEach((xj, j) => {
      if (j === i) return
      num = mul(num, x ^ xj) // subtraction is XOR in GF(2^m)
      den = mul(den, xi ^ xj)
    })
    return div(num, den)
  })

const evaluate = (known: Map<number, Bytes>, x: number, size: number): Bytes => {
  const xs = [...known.keys()]
  const w = weights(xs, x)
  const out = new Array<number>(size).fill(0)
  xs.forEach((xi, i) => {
    const chunk = known.get(xi)!
    for (let b = 0; b < size; b++) out[b] ^= mul(w[i], chunk[b])
  })
  return out
}

export function encode (data: Bytes[], n: number): Bytes[] {
  const k = data.length
  if (n > 256 || n < k) throw new Error('need k <= n <= 256')
  const size = data[0].length
  const known = new Map<number, Bytes>(data.map((c, i) => [i, c]))
  const parity: Bytes[] = []
  for (let x = k; x < n; x++) parity.push(evaluate(known, x, size))
  return [...data, ...parity]
}

/** Rebuild the k data chunks from any k surviving chunks (index -> chunk). */
export function decode (surviving: Map<number, Bytes>, k: number): Bytes[] {
  if (surviving.size < k) throw new Error(`need ${k} chunks, have ${surviving.size}`)
  const use = new Map([...surviving.entries()].slice(0, k))
  const size = [...use.values()][0].length
  const out: Bytes[] = []
  for (let x = 0; x < k; x++) out.push(use.has(x) ? use.get(x)! : evaluate(use, x, size))
  return out
}
