import { join } from 'node:path';
import { DISCOVERY_V1 } from '@pulse/index-core/discovery.ts';
import { methodologyPayloads } from './methodology.ts';
import { coveragePayload } from './trend-coverage.ts';
import { chainManifest, verifyTrendChain } from './trend-epoch.ts';

export interface ArtifactContext {
  readonly snapshotsDir: string;
  /** Directory of the published docs, normally docs/ at the repo root. */
  readonly docsDir: string;
}

/** Content types for the artifacts that are not JSON. */
export const ARTIFACT_TYPES: Readonly<Record<string, string>> = {
  'api/methodology-changelog': 'text/markdown; charset=utf-8',
};

/**
 * Files published beside the signed documents, keyed by the path they serve at.
 *
 * One builder for both the file export and the server, because a settlement
 * contract that differs between the host that proves it and the host that serves
 * it is not a contract. A missing changelog throws rather than publishing rules
 * with no history.
 */
export async function publishedArtifacts(ctx: ArtifactContext): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const chain = await verifyTrendChain(ctx.snapshotsDir);
  if (chain.days.length > 0) {
    files.set('api/trend-epoch/chain', chainManifest(chain));
    files.set('api/trend-coverage', await coveragePayload(ctx.snapshotsDir));
  }
  const methodology = await methodologyPayloads(
    DISCOVERY_V1,
    join(ctx.docsDir, 'methodology-changelog.md'),
  );
  files.set('api/methodology', JSON.stringify(methodology.document, null, 2));
  files.set('api/methodology-changelog', methodology.changelog);
  return files;
}
