# PULSE Markets

Resolution layer for pm-AMM: attention-index prediction markets on Solana.

## The gap

pm-AMM (Predict) can create and trade prediction markets, but settlement is
manual and there is no oracle. Someone has to decide the outcome and sign it.
Predict's own documentation names resolution and oracles as the first thing
missing from the stack.

PULSE supplies that piece. It maintains an attention index, publishes a signed
snapshot of it every epoch, and resolves threshold markets against the snapshot.

Example market:

> Will the PULSE Attention Index close above 72.0 at the epoch ending
> 2026-12-20T00:00:00Z?

## Components

1. **Index service.** Computes the index for each epoch from a defined set of
   sources and publishes a signed, timestamped snapshot. The index definition is
   fixed before any market is created, so the resolution of a market cannot be
   argued after the fact.
2. **Resolver and market factory.** Creates `PULSE_ATTENTION_ABOVE_X_AT_T`
   markets on the pm-AMM program and resolves them from the published snapshot
   once the epoch closes. Resolution rules and the dispute window are written
   into the market metadata at creation time.
3. **Markets UI.** The market list with each spec's terms and a settlement
   preview against the published snapshot. Read only in this version: no wallet,
   no orders, because there is nothing on chain to trade against yet.

## Repo layout

```
packages/
  index-core/    published terms, scoring, snapshot and verification shared by
                 the index service and the resolver
index-service/   index computation, signed epoch snapshots, public pages
app/             landing page and markets front end, served at /app/
resolver/        market factory and settlement
markets/         published market specs, one JSON file each
docs/            index definition, snapshot format, resolution rules, operations
ops/             daily build job and static deploy
```

Install once at the root: `npm install`. Workspaces link `@pulse/index-core`
into both services, so a change to the terms, scoring or verification code reaches
the index service and the resolver together.

Reading the index from another program uses the same package:

```ts
import { readLatest, readHistory } from '@pulse/index-core';

const { snapshot, verified } = await readLatest({ baseUrl: 'https://maxxexee.github.io/pulse-markets' });
if (verified) console.log(snapshot.epochDay, snapshot.index.score);

// every reading carries the signature check made locally; the host is not trusted
for (const day of await readHistory({ baseUrl: 'https://maxxexee.github.io/pulse-markets' })) {
  console.log(day.day, day.index);
}
```

Live: [app](https://maxxexee.github.io/pulse-markets/app/) ·
[index](https://maxxexee.github.io/pulse-markets/) ·
[markets](https://maxxexee.github.io/pulse-markets/markets.html)

## Status

The index service is implemented and publishes signed daily snapshots. The
resolver's terms, id derivation and settlement engine are implemented in
`resolver/`. Create and resolve are also wired to the pm-AMM program through
`@pm-amm/sdk`, behind `--on-chain` in the resolver CLI. That path builds real
instructions for program `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y`, but it
has not been sent to a funded cluster yet, so no transaction is claimed. The
trade app is not built yet.

Index definition, version `pulse-attention-v6`. The full definition, including
anchors and weights, is embedded in every snapshot beside its SHA-256
(`definitionSha256`), so a market can pin the exact terms instead of a name.

- Basket of seven entities, each pinned to a fixed Wikipedia article and a
  fixed Hacker News query.
- Every constituent has a frozen anchor: its daily volume over the 180-day base
  period ending 2026-11-17. A rolling baseline moved with each entity's own slow
  trend, so the same score meant different things in different months and a
  market could not say what it was settling on. Anchors do not move inside a
  definition version; new terms mean a new version and a new id.
- Three signals with published weights:
  - `wikipedia-pageviews` (`pulse-level-v1`, weight 0.60): daily pageviews of
    the English article, median anchor over the base period.
  - `wikipedia-pageviews-global` (`pulse-level-v1`, weight 0.15): daily
    pageviews summed over the German, French, Spanish, Japanese, Russian and
    Chinese articles. Each constituent's per-edition titles are resolved from
    Wikidata during calibration and frozen into the definition, so a build and a
    verify read exactly the pages the terms name. This is a second population on
    the same Wikimedia dataset, not a second independent supplier.
  - `hacker-news-stories` (`pulse-level-counts-v1`, weight 0.25): daily story
    mentions from the public Algolia API, smoothed mean anchor (prior of 1), and
    no score below 3 stories where a unit is noise.
- Score: `clamp(50 + 12.5 * log2(value / anchor), 0, 100)` per entity.
- Constituent weight, inside each signal: base-period volume share, capped at
  25 percent and redistributed. Measured 30-day pageview shares are lopsided
  enough (one entity at 40 percent, another under 1 percent) that an uncapped
  share would let a single entity set the series.
- Signal index: weighted mean of that signal's entity scores. An entity with no
  anchor or no value for the day is reported as unscored and excluded, and the
  remaining weights are renormalised over what did score, never guessed.
- Headline index: weighted mean of the signal indices that scored, at their
  published weights, renormalised over the signals that scored. Readership
  carries 0.75 because it is dense and filtered upstream, split between English
  (0.60) and the six other editions (0.15); story counts carry 0.25 because they
  are sparse and skew technical.
- Momentum: the change in the index against the snapshot 7 days earlier, scored
  as `clamp(50 + delta, 0, 100)`. Missing history publishes `null`, not a guess.
- Coverage: series scored over series expected, published beside the score as
  a coverage ratio, plus `weightScored`, the share of headline weight that
  actually scored, summed over constituents rather than taken from the series
  headline. A 71 from 2 of 21 series is not the same claim as a 71 from 21.
- Snapshot: canonical JSON, SHA-256, signed with Ed25519. The signing key is a
  Solana address, so snapshot signatures can be checked on chain later.

Source survey, including the social platforms tested and rejected and the
measured reasons no free news count survived, is in
[`docs/attention-sources.md`](docs/attention-sources.md).

Every input is a public URL recorded in the snapshot, so a third party can
refetch it and recompute the score without access to this server. The formula
must be frozen before a market is created on it.

```
npm install                 # once, at the repository root
cd index-service
node src/cli.ts build     # compute, sign and publish the previous UTC day
node src/cli.ts calibrate --base-day 2026-11-16 --days 180   # rebuild the definition
node src/cli.ts social    # optional display-only social panel
node src/cli.ts health    # exits 1 unless the latest snapshot is current
node src/cli.ts verify    # recompute the latest epoch from its sources and compare
node src/cli.ts export --out .site   # same pages and JSON as plain files
node src/cli.ts serve     # public index page and JSON API on :8080
```

```
ops/install-epoch-build.sh   # publish every day at 09:15 UTC, unattended
ops/uninstall-epoch-build.sh
```

A published day is never overwritten, a day read from less than half the basket
is refused outright, and a missed day is caught up on the next run. Signing key
custody and failure handling are in [`docs/operations.md`](docs/operations.md).

```
cd resolver
node src/cli.ts create  --threshold 55 --comparison above --day 2026-11-20 --signer <base58> \
                        --definition-sha256 <64 hex>   # optional: pin the exact terms
node src/cli.ts resolve --spec market.json --snapshot ../index-service/snapshots/2026-11-20.json

# A discovered topic settles on the signed trend epoch, not the index score.
node src/cli.ts create  --kind trend --article Grand_Theft_Auto_VI --threshold 300 \
                        --comparison above --day 2026-11-20 --signer <base58> \
                        --definition-sha256 <64 hex>
node src/cli.ts resolve --kind trend --spec trend-market.json \
                        --trends ../index-service/snapshots/trends/2026-11-20.json
```

The social panel is fetched from twitterapi.io and shown beside the index. It is
display only: `settlementWeight` is `0`, no social number reaches the score, and
without `TWITTERAPI_IO_KEY` the panel is simply not published.

Market terms, identity and tie policy are in
[`docs/resolution-rules.md`](docs/resolution-rules.md).

A build publishes nothing unless every source answered, so a failing source
leaves the previous snapshot in place and exits non-zero with the source and
entity named. Retry later; snapshots are never written with a source silently
left out.

Devnet only. Nothing here handles real funds.

## Accounts

Sign-up on the app pages is Neon's Managed Better Auth, hosted on the
`production` branch of the `pulse` project. `neon.ts` declares the service and
`neon deploy` turns it on; the branch auth URL lands in `.env.local` as
`NEON_AUTH_BASE_URL`.

The pages are static, so `app/auth-client.js` imports the auth SDK and is
bundled to `app/auth-client.bundle.js` by `export` and `serve` before the site
is written. Both commands stop with an error when the auth URL is missing,
rather than publish a page that cannot sign anyone up.

Origins are allowlisted on the branch, and `localhost` is approved for local
testing only as `localhost`, not `127.0.0.1`:

```
neon neon-auth domain add https://maxxexee.github.io
neon neon-auth domain list
```

Google sign-in uses Neon's shared development credentials, which show Neon's
name on the consent screen. Production needs your own OAuth client:
`neon neon-auth oauth-provider add --provider-id google`.

## Built for

Solana Perps and Prediction Markets hackathon, deadline 2026-12-05.

- pm-AMM program: `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y`
- Devnet collateral mint (mUSDC, 6 decimals):
  `3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ`
