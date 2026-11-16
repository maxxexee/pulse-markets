# Index research

Status: decision pending. Nothing below is implemented.

## What the original site implied

`pulse-markets.netlify.app` shipped a front end that expected one endpoint,
`/api/trends`, which is dead (replit dev host returns "This project isn't
available right now"). The fields it read from each trend, taken from the
deployed bundle:

| Field | Meaning |
|---|---|
| `topic`, `hashtag`, `category`, `id` | what the trend is |
| `sources[]` with `source` and `volume` | per-platform volume, multi-source |
| `sourceCount` | how many platforms carried it |
| `momentum`, `velocityLabel` | `surging` / `trending` / `stable` / `fading` / `new` |
| `preTrend`, `firstSeen` | detected before mainstream coverage |
| `status` | `trending` / `fading` etc |

So the intended index was a **social trend-velocity score**: how fast a topic is
being talked about across platforms, and whether it is accelerating or dying.

That is a reasonable dashboard product. It is a bad settlement source, for three
reasons:

1. **Not recomputable.** A third party cannot reproduce an X/TikTok mention
   count from public data. Platform APIs are paid, rate limited, and their terms
   restrict redistribution. If the resolver says 71.4 and a trader says 69.0,
   there is no way to settle the argument.
2. **Cheap to manipulate.** Sybil engagement is purchasable, bots are cheap, and
   the cost of moving the score is decoupled from the cost of moving the market.
   A trader who can buy the score profitably will.
3. **No snapshot boundary.** Social volume has no block height and no
   finalisation. "As of epoch end" is a wall-clock claim, not a verifiable one.

Attention is the worst possible thing to settle a market on. It is fine to
display.

## What the chain gives us, measured

Probes run against the public RPC on 2026-11-16, no API key:

**pm-AMM program activity** (`GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y`):

- Mainnet: 5 signatures in the entire retrievable history, from roughly
  2026-07-29 to 2026-10-15, two of them failed instructions. The program is
  effectively unused on mainnet.
- Devnet: finalised transactions from the previous day. Devnet is the only
  cluster with real pm-AMM activity.

**Cost of counting events** via `getSignaturesForAddress`, 1000 signatures per
page:

| Program | Rate | Pages per day | Notes |
|---|---|---|---|
| Jupiter v6 | ~12,000 tx/min | ~17,280 | 6 pages covered only 30 seconds |
| Pyth push feed | ~16 tx/min | ~24 | one page per hour |

Public mainnet RPC returns 429 under sustained pagination. The free keyed tiers
(Helius free: 1M credits/month, 10 req/s) can absorb roughly 33,000 calls a day,
so a single busy program consumes over half of that budget before you have
counted anything else.

**Conclusion:** any index built by scanning transaction history is expensive,
fragile, and needs archive access plus exact slot bounds to be reproducible.

## Candidate index families

| | Reproducible | Daily cost | Manipulation | Verdict |
|---|---|---|---|---|
| A. Social attention | no | paid, ToS | bots | reject |
| B. Event counts | with archive | 17k pages | spam fees | expensive |
| C. State reads | exactly | tens of calls | capital | recommend |
| D. Price feed | yes | low | depth | component |

- **A. Social attention.** X, TikTok, Reddit, Google Trends. The original PULSE
  design.
- **B. Event counts.** Transaction counts per program, read from raw RPC or an
  indexer. Reproducible only with archive access and exact slot bounds.
- **C. Bounded state reads.** Account state read at a fixed slot, such as AMM
  reserves or market prices.
- **D. Price feed.** Pyth or Switchboard. The oracle is already decentralized,
  so there is nothing to add on the truth side.

D is worth stating plainly: if the index is just a price, the oracle problem is
already solved by Pyth and PULSE adds nothing on the truth side. The product has
to be the attestation and settlement machinery, not a re-derivation of a number
somebody else already signs.

## Recommended direction

Family C, instantiated as **bounded on-chain state**, because that is the only
option where cost, reproducibility, and manipulation resistance all land in the
same place.

The concrete idea worth evaluating: an index over **implied probabilities of
existing prediction markets**, read directly from market accounts at a fixed
slot. Properties:

- Each epoch costs one account read per market in the basket. A 20-market basket
  is 20 calls, not 17,000 pages.
- Deterministic at a slot, so the snapshot is unambiguous.
- No vendor, no key, no terms of service.
- It exercises pm-AMM twice, once as the source of the index and once as the
  venue that trades the index, which is the sponsor's stated interest.

Known weaknesses, to be resolved before this is chosen:

1. **Circularity.** Markets created by the same deployer to feed the index are
   self-referential and gameable by anyone trading them. The basket needs
   markets with independent resolvers, or a rule that excludes self-created
   markets.
2. **Devnet data is thin and fake.** A devnet basket has no meaningful prices,
   so the index would be noise. Reading a mainnet basket while trading on
   devnet is the obvious fix and needs checking against the hackathon rules.
3. **Continuity.** pm-AMM markets expire. The basket has a rolling membership,
   and membership changes must be published in advance of the epoch, never
   discovered after.

## Open questions

- Does the hackathon permit a devnet deployment whose index reads mainnet? The
  rules say judges want devnet or mainnet deployment; nothing read so far
  forbids a mainnet data source.
- What is the epoch? Long enough that a market has time to trade, short enough
  that the demo can show a settlement inside the judging window. A 24 hour epoch
  makes a live settlement demo impossible.
- Who signs snapshots, and what is the dispute procedure when a recomputation
  disagrees? This is the actual product surface and is not designed yet.
