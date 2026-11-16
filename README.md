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

Pre-build. The index definition, snapshot format, resolution rule, and dispute
window are specified before implementation, because every component below them
inherits those constraints.

Devnet only. Nothing here handles real funds.

## Built for

Solana Perps and Prediction Markets hackathon, deadline 2026-12-05.

- pm-AMM program: `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y`
- Devnet collateral mint (mUSDC, 6 decimals):
  `3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ`
