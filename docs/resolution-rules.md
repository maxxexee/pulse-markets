# Resolution rules

A market is one threshold on the PULSE attention index at one epoch. These rules
are fixed when the market is created and are not editable afterwards. The
settlement engine in `resolver/` implements exactly this document.

## Terms

| Field | Meaning |
| --- | --- |
| `definitionId` | Index definition the market settles under, e.g. `pulse-attention-v5`. |
| `definitionSha256` | Optional. SHA-256 of that definition. When set, the snapshot must have been computed under exactly those anchors and weights. |
| `signer` | Base58 Ed25519 key whose snapshots are accepted as evidence. A Solana address. |
| `threshold` | Index points, `0` to `100`, at most two decimals. |
| `comparison` | `above` or `below`. |
| `epochDay` | UTC day whose published index resolves the market. |
| `minConfidence` | Snapshot coverage floor, `0` to `1`. Default `0.5`. |
| `createdAt` | When the terms were fixed. |
| `id` | SHA-256 of the canonical terms. Derived, never chosen. |

## Identity

`id = sha256(canonicalJson(terms))`, with keys sorted recursively, the same
encoding used for signed snapshots. Two parties who agree on terms derive the
same id without coordinating, and any change to a term produces a different
market rather than an edit to this one. A spec whose stored id does not match
its terms is rejected.

## Settlement

1. The snapshot payload hash and Ed25519 signature must verify. A malformed or
   forged file is a rejection, not a crash.
2. `attestation.publicKey` must equal the market's `signer`.
3. `snapshot.definitionId` must equal the market's `definitionId`.
4. If the market pins `definitionSha256`, `snapshot.definitionSha256` must equal
   it. The id names the terms and the hash fixes them: without the pin, a reader
   trusts the publisher to keep meaning the same thing by the same name.
5. `snapshot.epochDay` must equal the market's `epochDay`.
6. `snapshot.index.score` must be present. A snapshot where no series scored
   cannot settle anything.
7. `snapshot.coverage.coverageRatio` must be at least `minConfidence`. A score read
   from a fragment of the basket is published but not settlement grade.
8. `above` resolves YES when `score > threshold`; `below` resolves YES when
   `score < threshold`.

## Ties

A score exactly equal to the threshold resolves **NO** in both directions.
This is part of the record (`policy: "tie-resolves-no"`) because a settled
market must not depend on an unstated convention.

## Settlement record

The resolver emits the market id, the terms it applied, the index score, the
outcome, the tie policy, the snapshot payload hash and signer, and the
timestamp. The payload hash is what makes the outcome auditable later: it pins
the exact bytes the decision was read from.

## On-chain settlement

`--on-chain` turns the off-chain decision into a pm-AMM action:

- `create --on-chain` opens a binary market whose name carries the side,
  threshold and epoch day, with `--duration-secs`, `--initial-price-bps` and
  `--deposit-usdc` controlling the listing. The signed terms stay in the market
  file; the chain only gets a name and a lifetime.
- `resolve --on-chain --market <pda>` maps the settlement outcome to the pm-AMM
  side (`yes` or `no`) and submits it. pm-AMM has no oracle, so only the market
  authority can resolve, and that authority is the keypair the CLI loads. The
  trust assumption is explicit: the resolver operator decides from a signed
  snapshot that anyone can re-verify.

Chain settings come from the environment, never from flags, so a transaction
can be reproduced from the shell history:

| Variable | Default |
| --- | --- |
| `PULSE_KEYPAIR` | required, path to a Solana keypair JSON file |
| `PULSE_RPC_URL` | `https://api.devnet.solana.com` |
| `PULSE_PM_AMM_PROGRAM` | `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y` |
| `PULSE_USDC_MINT` | devnet `3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ` |

On mainnet-beta only the collateral mint changes. A market created on devnet
with mUSDC is not the same market on mainnet: the listing is per-cluster, while
the signed market id is not.

## Status

The settlement engine is complete and tested against locally generated Ed25519
keys. The pm-AMM adapter builds `initializeMarket` and `resolveMarket`
instructions against the real program id and is covered by unit tests for config,
input limits and the outcome mapping. It has not been exercised end to end: this
environment has no devnet SOL (the RPC faucet is closed and the pm-AMM faucet
supplies only collateral), so no create or resolve transaction has been sent.
