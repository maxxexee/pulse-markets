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
3. **Trade app.** Wallet connect, market list, quotes, and buy/sell against
   devnet.

## Repo layout

```
index-service/   index computation and signed epoch snapshots
resolver/        market factory and settlement
app/             trade UI
docs/            index definition, snapshot format, resolution rules
```

## Status

The index service is implemented and publishes signed daily snapshots. The
resolver, the market factory and the trade app are not built yet.

Index definition, version `pulse-attention-v3`:

- Basket of seven entities, each anchored to a fixed Wikipedia article, a fixed
  Hacker News query and a fixed GDELT phrase.
- Three independent signals, each scored on its own trailing baseline:
  - `wikipedia-pageviews` (`pulse-level-v1`): daily pageviews, median baseline
    over the 30 days before the epoch day.
  - `hacker-news-stories` (`pulse-level-counts-v1`): daily story mentions from
    the public Algolia API, smoothed mean baseline (prior of 1) over the same
    window, and no score below 3 stories where a unit is noise.
  - `gdelt-articles` (`pulse-level-counts-v1`): daily news article counts from
    the public GDELT DOC API, same baseline and floor. GDELT omits days from its
    own timeline, so a series is accepted only if the epoch day is present and
    at least 70 percent of the window came back; omitted days are excluded from
    the baseline, never counted as zero.
- Score: `clamp(50 + 12.5 * log2(value / baseline), 0, 100)` per entity.
- Signal index: mean of that signal's entity scores. An entity without at least
  7 baseline days is reported as unscored and excluded, never guessed.
- Headline index: mean of the signal indices that scored, so each signal is
  weighted equally rather than by how many entities it happened to score.
- Snapshot: canonical JSON, SHA-256, signed with Ed25519. The signing key is a
  Solana address, so snapshot signatures can be checked on chain later.

Source survey, including the social platforms tested and rejected, is in
[`docs/attention-sources.md`](docs/attention-sources.md).

Every input is a public URL recorded in the snapshot, so a third party can
refetch it and recompute the score without access to this server. The formula
must be frozen before a market is created on it.

```
cd index-service
npm install
node src/cli.ts build     # compute, sign and publish the previous UTC day
node src/cli.ts serve     # public index page and JSON API on :8080
```

A build publishes nothing unless every source answered, so a throttled source
(most often GDELT, which rate limits per IP) leaves the previous snapshot in
place and exits non-zero with the source and entity named. Retry later; snapshots
are never written with a source silently left out.

Devnet only. Nothing here handles real funds.

## Built for

Solana Perps and Prediction Markets hackathon, deadline 2026-12-05.

- pm-AMM program: `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y`
- Devnet collateral mint (mUSDC, 6 decimals):
  `3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ`
