# Proof of Keep — prototype

Reference prototype for the Proof of Keep white paper ([`proof-of-keep-whitepaper.md`](proof-of-keep-whitepaper.md)), a BSV locking script that pays storage operators only when they prove they still hold a file. It is designed to fit [bstore](https://github.com/lightwebinc/bstore) as the on-chain output its spec reserves (paper section 2.1). It builds a file, erasure-codes it, funds period UTXOs and spends them through the `@bsv/sdk` script interpreter. `npm test` never touches mainnet; the separate mainnet test below does, with a few pence.

## Run it

```
npm install
npm test                 # 27 checks through the SDK interpreter
npm run mutate           # removes each script rule in turn; all 10 must be caught
npm run economics        # every number in sections 5 and 6 of the paper
```

## Mainnet test

`src/mainnet.ts` puts one small development deal on mainnet. It stores the white paper, with two period outputs of 10,000 sats each: period A is claimed by the operator through the keep path, period B is swept by the steward through the lapse path.

1. **Rehearse first** (no network, no money):
   ```
   npm run mainnet -- fund --dry-run
   npm run mainnet -- claim --dry-run
   npm run mainnet -- sweep B --dry-run
   npm run mainnet -- status --dry-run
   ```
2. **Make the test key:** `npm run mainnet -- setup`. Save the printed key as a Replit Secret called `POK_WIF`, then run `setup` again to see the address. Treat it as a throwaway wallet.
3. **Fund it:** send about 30,000 sats (about half a US cent) to that address from your wallet, copy the payment's txid, then run `npm run mainnet -- fund <txid>`.
4. **Claim A:** `npm run mainnet -- claim`. It waits for the next block (about 10 minutes), builds the claim, checks it locally and broadcasts it.
5. **Sweep B:** `npm run mainnet -- sweep B`, any time from an hour after funding.
6. **Get the money back:** `npm run mainnet -- withdraw <your address>`.

`status` shows every transaction with whether WhatsOnChain has seen it, and `rebroadcast` resends anything whose outcome was unclear. If ARC rejects the claim, its message answers the miner-policy question; period A can then be swept back with `sweep A` six hours after funding.

Optional settings: `POK_ARC_URL` and `POK_ARC_KEY` to broadcast somewhere other than GorillaPool's ARC, `POK_WOC_KEY` for a WhatsOnChain API key, `POK_FILE` to store a different file.

Tested on Node 22. No native dependencies, so it should run unchanged in a Replit Node project.

## Files

| File | What it does |
|---|---|
| `src/script.ts` | The period locking script (keep and lapse paths) and both unlocking scripts |
| `src/merkle.ts` | Fixed-depth file tree with domain-separated hashes and zero padding |
| `src/beacon.ts` | Header hashing, PoW floor targets, challenge index derivation, a test header miner |
| `src/erasure.ts` | Systematic Reed-Solomon over GF(2^8), to show any half of the chunks rebuilds the file |
| `src/deal.ts` | Builds a funding transaction and spends one output through `Spend` |
| `src/economics.ts` | Forging costs, grinding costs, script and claim sizes, endowment tables |
| `test/run.ts` | Positive and negative cases, a cheater simulation and a full-depth deal |
| `test/mutate.ts` | Mutation harness |
| `src/mainnet.ts`, `src/chain.ts` | The mainnet test, with WhatsOnChain headers, ARC broadcasting and a dry-run chain |

## Not production code

- The erasure code here is GF(2^8), capped at 256 chunks. Version 1 deals use GF(2^16) for up to 65,535.
- `npm test` uses a stand-in parent transaction and exercises only the period scripts. The mainnet test is the real end to end.
- Network figures in `src/economics.ts` are a 29 October 2026 snapshot. Refresh them before pricing a deal.
- Miner policy for these non-standard scripts has not been confirmed. See section 8 of the paper.

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
