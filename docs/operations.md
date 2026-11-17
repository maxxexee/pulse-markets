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
- three attempts, 120 seconds apart
- every line appended to `index-service/.logs/epoch-build.log`
- exit 1 if all attempts fail; nothing is published in that case

`--catch-up 7` fills any day in the trailing week that has no snapshot, so a
laptop asleep for two nights heals itself rather than leaving a hole in the
momentum reference. A published day is skipped unless `--force` is passed, so a
rerun can never replace a signed epoch.

## Checking it works

```
launchctl print gui/$UID/com.pulse.epoch-build | head -20
launchctl kickstart -k gui/$UID/com.pulse.epoch-build
tail -f index-service/.logs/epoch-build.log
```

A healthy run ends with `build ok` and a fresh `snapshots/<day>.json`. A run
that never reaches that line is a failure and the previous snapshot is still
serving, which is correct but silent, so watch the log or watch the page.

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
