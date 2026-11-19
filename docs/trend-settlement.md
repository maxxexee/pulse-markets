# Trend market settlement

A trend market asks one question: did topic T appear on PULSE for day D, and did
it clear a momentum bar. This document is the contract an operator implements. It
is deliberately small, because a settlement source that needs a meeting to
integrate is not a settlement source.

Index markets settle from a signed snapshot under `docs/resolution-rules.md`. This
document covers the trend record, which is a separate artifact with its own
signer, its own digest and its own thresholds.

## Artifacts

| Path | What it is |
| --- | --- |
| `api/trend-epoch/<day>` | The signed document for one day. This is the evidence. |
| `api/trend-epoch/latest` | The newest signed document. |
| `api/trend-epoch/chain` | Every published day, its payload hash and the hash it commits to. |
| `api/methodology` | Thresholds in force, definition digest, changelog hash. |
| `api/methodology-changelog` | Dated rule changes. |
| `api/trend-rejections/<day>` | Topics measured and dropped by a threshold, with numbers. |
| `api/trend-coverage` | Every topic with an attested day, so markets can be chosen from the inventory. |

Nothing here is computed per request. These are files, published daily by
`ops/run-epoch-build.sh`, and the same bytes serve from the local server and from
the file host.

## Fields a market must pin

| Field | Meaning |
| --- | --- |
| `definitionId` | `discovery-v1`. |
| `definitionSha256` | Digest of the method and settings. A market that omits it is settling under "whatever the rules were that day". |
| `signer` | Base58 Ed25519 key. Currently `BDFyypNLd5eGdxSjtCUGasgjZm1MFU6WBAbpt1c6ncmc`. |
| `epochDay` | UTC day being settled. |
| `topic` | The article name, e.g. `Manni_L._Perez`. Match on `article`, not on the displayed label: labels change with the title. |
| `minMomentum` | Optional. Additional bar the market wants beyond the published one. |

## Settlement, in order

1. Read `api/trend-epoch/<epochDay>`. It must parse and contain `trends` and
   `attestation`; anything else is a rejection, not a crash.
2. Recompute the payload hash from `trends` with canonical JSON: keys sorted
   recursively, no insignificant whitespace, UTF-8. It must equal
   `attestation.payloadSha256`. Verify the Ed25519 signature over the same bytes
   against `attestation.publicKey`, and require that key to equal the market's
   `signer`.
3. Require `trends.definitionId` and `trends.definitionSha256` to equal the
   market's pins, and `trends.epochDay` to equal the market's day.
4. Check the chain: `api/trend-epoch/chain` must list `epochDay`, and the day must
   carry a `prevDigest` that matches its predecessor's `payloadSha256`. A day that
   is present but unchained is evidence of a number and not of a date.
5. Resolve YES when `trends.entries` contains an entry with the market's
   `article` and `momentum >= market.minMomentum`. Resolve NO when the article is
   absent from `entries`.
6. Record the payload hash, the signer, the momentum, the outcome and the time.
   The payload hash is what a dispute cites.

An epoch for the day that does not exist yet is not a NO. Wait, or void the
market by its own terms. Resolving NO because a file is missing rewards whoever
noticed first.

## Reading a NO

Two NOs are not the same, and the record says which one happened:

- The topic is in `api/trend-rejections/<day>` with a `reason`. It was measured and
  failed a named bar: `views-below-floor`, `too-few-baseline-days`,
  `baseline-below-floor`, `momentum-below-floor`, or `no-views`.
- The topic appears nowhere. It was not a candidate that day: not in the top 24 by
  views, or excluded as a list or roundup page. There is nothing to measure.

The ledger starts on 2026-11-19. Days before it have the file with an empty
`rejected` list, which is a gap in the record and not a day where nothing failed.

## Choosing markets

`api/trend-coverage` lists each topic with the days it appeared, its momentum on
each of them, and that day's payload hash. A topic that appeared once on a thin
margin is a bad first market. One that appears on most days has a rule behind it
that already survived the thresholds.

## Integration recipe

```js
const base = 'https://maxxexee.github.io/pulse-markets';
const [epoch, chain] = await Promise.all([
  fetch(`${base}/api/trend-epoch/2026-11-18`).then((r) => r.json()),
  fetch(`${base}/api/trend-epoch/chain`).then((r) => r.json()),
]);

const day = chain.days.find((entry) => entry.day === epoch.trends.epochDay);
if (!day || day.payloadSha256 !== epoch.attestation.payloadSha256) {
  throw new Error('this day is not in the published chain');
}

const entry = epoch.trends.entries.find((item) => item.article === 'Manni_L._Perez');
const outcome = entry && entry.momentum >= market.minMomentum ? 'yes' : 'no';
```

Signature verification uses the same canonical JSON as the publisher, which is
`canonicalJson` in `packages/index-core/src/snapshot.ts`. Import it; reimplementing
it is how two implementations drift.

## What this contract does not promise

- That the sources will not revise. A source can revise a figure after the day is
  signed. The published epoch does not move, which is the point; the index
  `verify` command reports the disagreement separately.
- That a topic will be found. Discovery covers the top of the daily ranking plus
  resolved X trends. A topic nobody looked up on Wikipedia that day has no signal
  here, and no amount of methodology changes that.
