import { verifyTrendChain, verifyTrendEpoch } from './trend-epoch.ts';

/**
 * Checks one signed trend epoch, the newest unless a day is named.
 *
 * Reports through the exit code, so a scheduled run fails on a bad document
 * instead of publishing a page nobody checked.
 */
export async function verifyTrends(
  snapshotsDir: string,
  day: string | boolean | undefined,
): Promise<void> {
  const result = await verifyTrendEpoch({
    snapshotsDir,
    ...(typeof day === 'string' ? { day } : {}),
  });
  if (!result.ok) {
    console.log(`trend epoch failed: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`trend epoch ${result.epochDay}: ${result.entries} topics, signature valid`);
  console.log(`signer ${result.signer}`);
  console.log(`payload sha256 ${result.payloadSha256}`);
}

/**
 * Prints the published chain, one epoch per line, and fails the command when a
 * link is broken so a scheduled run cannot publish on top of a bad record.
 */
export async function verifyChain(snapshotsDir: string): Promise<void> {
  const chain = await verifyTrendChain(snapshotsDir);
  for (const day of chain.days) {
    const link =
      day.prevDigest === null
        ? 'legacy, no link'
        : day.prevDigest === 'genesis'
          ? 'genesis'
          : `commits to ${day.prevDigest.slice(0, 12)}`;
    console.log(`${day.day}  ${day.payloadSha256}  ${link}`);
  }
  console.log(
    chain.ok
      ? `chain ok: ${chain.days.length} epochs from ${chain.days[0]?.day ?? 'none'}`
      : `chain broken: ${chain.problems.join('; ')}`,
  );
  if (!chain.ok) {
    process.exitCode = 1;
  }
}
