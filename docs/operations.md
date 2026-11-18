# Operations

How the index publishes itself, and how to keep the signing key.

## The daily job

```
ops/install-epoch-build.sh [utc_hour] [utc_minute]   # default 09:15 UTC
ops/uninstall-epoch-build.sh
```

The installer renders `ops/com.pulse.epoch-build.plist.template` into
`~/Library/LaunchAgents/com.pulse.epoch-build.plist`, loads it with
`launchctl bootstrap`, and prints the local clock time that matches the UTC
slot, because launchd schedules in local time and epochs are UTC days. Re-run
the installer to change the slot.

09:15 UTC is deliberate. A build publishes the previous UTC day, and the build
refuses to publish a day it cannot fully read, so the slot has to be late enough
that Wikipedia's daily pageview counts are final. Wikipedia and Hacker News
story counts for day D land during D+1; rebuilding a day after a failure is
safe because a published day is never overwritten.

`ops/run-epoch-build.sh` is what launchd runs:

- absolute `node` path, no inherited shell environment
- `node src/cli.ts build --catch-up 7`
- three attempts, 15 minutes apart, so a source that posts its daily figure late
  in the morning still lands in the same run
- `node src/cli.ts verify` after a successful build, logged as `verify ok` or
  `verify reported a difference`; set `VERIFY_ON_BUILD=0` to skip it
- every line appended to `index-service/.logs/epoch-build.log`
- exit 1 if all attempts fail; nothing is published in that case

`--catch-up 7` fills any day in the trailing week that has no snapshot, so a
laptop asleep for two nights heals itself rather than leaving a hole in the
momentum reference. A published day is skipped unless `--force` is passed, so a
rerun can never replace a signed epoch.

The verify step rebuilds the newest published epoch from the sources it names
and compares every score against the signed record. It does not fail the job,
because a difference usually means Wikipedia or Hacker News revised a daily
figure after publication, and the snapshot is already signed and cannot be
rewritten. The log line is the signal: a steady run logs `verify ok`, and a run
after a source revision logs the differing values on the lines above it.

## The index definition

`index-service/definitions/<id>.json` holds the published terms: the base day,
the calibration window, the weight cap, and each constituent's frozen anchor and
weight. `build` refuses to run without it, and every snapshot embeds the whole
object plus its SHA-256, so a reader can recompute a level from the file alone.

Do not edit it by hand. Regenerate it from source data:

```
cd index-service
node src/cli.ts calibrate --base-day 2026-11-16 --days 180
```

Calibration fetches the whole base period, which is why it walks it in 60-day
chunks: the Hacker News adapter refuses ranges over 62 days. Then publish the
base day once with `build --day 2026-11-16 --force`.

The published id is part of the contract. Changing the base day, the window, the
cap, an anchor or a weight defines a different index, so it needs a new id and a
new definition file; markets pin the digest, and a snapshot from old terms will
not settle a market that pins the new ones.

## Publishing the site

Live at <https://maxxexee.github.io/pulse-markets/> and
<https://maxxexee.github.io/pulse-markets/markets.html>.

```
ops/deploy-pages.sh
```

`node src/cli.ts export --out DIR` writes the pages and every JSON route as
plain files, and the deploy script force-pushes that directory to `gh-pages`,
which GitHub Pages serves. The pages ask for `./api/...`, so the same build works
served from this machine and from the project subpath on Pages.

The daily run deploys after a successful build, so the site follows the index.
Set `DEPLOY_ON_BUILD=0` to stop that. Two consequences worth knowing: the site is
a copy from deploy time, so a failed build leaves the live page showing the last
successful epoch until the next one lands, and `/api/health` exists on the local
server but not on the static site. Check freshness on a static deployment by
reading `api/index/latest` and comparing its `epochDay`.

Because `gh-pages` is replaced wholesale, anything committed there by hand is
lost on the next deploy.

## Front end contract

`app/pulse-live.js` refreshes the landing page from one endpoint:

```
GET /api/trends?filter=all   ->   { "trends": [ Trend ] }

Trend {
  id: string, topic: string, hashtag: string,
  status: 'surging' | 'trending' | 'stable' | 'fading',
  momentum: number | null,     // percent, rendered with one decimal, dash when null
  sourceCount: number,
  sources: [{ source, volume, link }],
  imageUrl?: string,
  discovered?: boolean,        // true for a topic found by the daily ranking
  baseline?: number,           // discovered only: mean views over the window
  baselineDays?: number,       // discovered only
  context?: string             // discovered only: one generated sentence, absent when none was written
}
```

The basket part of the list is one trend per entity that scored in the epoch:
`momentum` is that entity's seven-day change in level, `status` is the band it
falls in, and each signal contributes its `volume` and a link a reader can open.
An entity the index cannot measure is left out rather than shown flat, and a
momentum with no reference epoch is `null`.

After the basket, the payload appends the topics that trended on their own.
Those come from the daily Wikipedia ranking (`wikipedia-top-v1`), are compared
against their own seven-day average, and are gated by `minViews` (20,000) and
`minMomentum` (100 percent) in `snapshots/discovery/<day>.json`. The payload's
`discovery` header repeats those thresholds. This list is display only: it is
not signed and never feeds settlement, which is why the page labels those
summaries as outside the index.

## Trending discovery

`build` runs `discover` for the newest published day once the epoch is written.
The command is also available on its own:

```
node src/cli.ts discover --day 2026-11-15
```

It fetches the day's top English Wikipedia articles, drops utility namespaces
and standing list pages, measures the biggest unclaimed articles over the seven
days before the epoch, fetches their lead images, and writes
`snapshots/discovery/<day>.json`. A failure is logged and never blocks the epoch:
the page then shows only measured basket trends.

### Context notes

Each discovered topic can carry one generated sentence saying what the page is
and, where its own article says so, why people would look it up. It is written at
build time, from the article's lead section plus the measured traffic, and stored
on the entry as `context { text, model, promptVersion, sourceUrl }`; the record's
`contextModel` names the model for the whole day.

The writer is off unless a key is configured:

```
PULSE_SUMMARY_API_KEY     required to turn notes on
PULSE_SUMMARY_API_BASE    default https://api.z.ai/api/paas/v4
PULSE_SUMMARY_MODEL       default glm-4.5-flash
```

The API is OpenAI compatible. Prompt `trend-context-v1` asks for one sentence,
forbids inventing people, events, dates and causes, and any reply containing a
digit is discarded, because the numbers on the card come from the signed record
and a figure in the prose would not. A missing key, an unreadable article or a
failed call drops the note; the measured numbers are unaffected, and no part of
the signed epoch depends on this.

## History and definition changes

`GET /api/index/history` returns one row per published epoch with `day`, `index`,
`momentum`, `coverageRatio`, `seriesScored`, `seriesExpected`, `definitionId`
and `definitionSha256`. Days signed before definitions were embedded report a
`definitionId` with a `null` digest. The markets page draws one line per run of
identical terms, so a definition change appears as a break rather than a jump:
levels computed under different anchors and formulas are not comparable, and the
chart says so instead of implying a trend across the boundary.

`verify` reports such a day as `legacy` and exits 1: the signature is checked and
valid, but there is nothing in the record to rebuild the number from.

## Verifying a published epoch

```
node src/cli.ts verify --day 2026-11-16
```

The command reads the signed snapshot, checks its payload hash and signature,
rebuilds the day from the sources named in the snapshot under the definition
embedded in it, and compares the headline, every signal index, every entity
score, and the coverage counts. It exits 1 on any difference and prints each one
with the published and recomputed value.

A difference is not automatically a bug: Wikipedia and Hacker News both revise
daily figures after publication, and a rebuild reads today's version. It does
mean the published number can no longer be reproduced from the source as it
stands, which is exactly what a reader checking the index needs to know.

## Checking it works

```
launchctl print gui/$UID/com.pulse.epoch-build | head -20
launchctl kickstart -k gui/$UID/com.pulse.epoch-build
tail -f index-service/.logs/epoch-build.log
```

A healthy run ends with `build ok` and a fresh `snapshots/<day>.json`. A run
that never reaches that line is a failure and the previous snapshot is still
serving, which is correct but silent, so watch the log or ask the index itself:

```
node src/cli.ts health                    # exits 1 unless the latest snapshot is current
curl -s localhost:8080/api/health         # 200 current, 503 missing, unverified or stale
```

One day of lag is healthy, because today's build has not run at the time you ask.
Two days is a miss. Verification outranks freshness: a fresh snapshot that does
not check out is reported as `unverified`, never `ok`.

## The signing key

`index-service/.keys/index-signer.pem` is the index identity. It is created on
first build, mode `0600`, and ignored by git. It is not a wallet and never holds
funds, but it is the thing markets name as their trusted signer, so losing it
means previously published snapshots can no longer be extended under the same
address.

Custody rules:

- Never commit it, never paste it into an issue, a chat, or a build log.
- Back it up outside this machine before the first market exists on it:
  an encrypted archive of the file plus the public key printed beside it.
  The backup must be usable with no other context, so record the public key and
  the date it was created in the same archive.
- Keep one offline copy. The key is small and static; a password manager entry
  or a hardware token holding the PEM text is enough. Losing the machine with no
  backup means a new signer and every existing market pointing at a dead one.
- Only this job needs read access. Do not copy it into a CI runner, a
  container image, or a deploy bundle.
- On a shared machine its parent directory should be `0700` as well as the file
  being `0600`.

Rotation, if the key is ever compromised:

1. Generate a fresh key by moving the key aside first, then letting the next
   build create one:
   `mv index-service/.keys index-service/.keys.retired-$(date -u +%F)`.
2. Note the new public key from the build output.
3. Markets already created against the old address keep publishing their
   recorded `snapshotSigner` and payload hash, so their resolution stays
   auditable, but no new market may name the old signer.

## Pageview revisions

Wikimedia revises a day's counts after it closes, so rebuilding an old day can
produce a slightly different score than the snapshot already on disk: a rebuild
of 2026-11-08 came back 60.21 where the day's first build recorded 60.2. This is
why a published day is never overwritten and why a scheduled run rebuilds only
missing days. Momentum is derived from the snapshot files on disk, so a day
published before its reference was published carries null momentum, and a
reference that was later revised is still the reference the snapshot names.
Markets settle on the index score, not on momentum, so this cannot change an
outcome.

## Failure modes

| Symptom | Meaning | Action |
| --- | --- | --- |
| `epoch <day> already published, leaving it untouched` | rerun of a day that is on disk | nothing; use `--force` only to repair a bad snapshot |
| `HTTP 429` / `HTTP 403` from a source | upstream throttling | the job retries; if a full day is missed, `--catch-up 7` recovers it |
| exit 1 with a source and entity named | a series could not be read | previous snapshot stays published; retry later |
| `nothing to build: every day up to <day> is published` | the job ran and had work already done | nothing |
| no log line at the scheduled time | launchd job not loaded, or the Mac was asleep | launchd runs a missed interval on wake; check `launchctl print` |
| `refusing to publish <day>: coverage ... below the 0.5 floor` | a source had not posted that day yet | nothing; the next run fills it, and `--catch-up 7` keeps it in the window |
