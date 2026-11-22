import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import type { EntityDefinition } from '../config/entities.ts';
import { AUTH_CLIENT_SOURCE } from './auth-bundle.ts';
import { rejectionsPayload } from './discovery.ts';
import { basketPayload, historyPayload, marketsPayload } from './payloads.ts';
import { publishedArtifacts } from './published-artifacts.ts';
import { trendsPayload } from './trends.ts';

export interface ExportOptions {
  readonly outDir: string;
  readonly publicDir: string;
  readonly appDir: string;
  readonly snapshotsDir: string;
  readonly marketsDir: string;
  readonly docsDir: string;
  readonly basket: readonly EntityDefinition[];
}

/** Signed snapshots already on disk, oldest first. */
async function publishedDays(snapshotsDir: string): Promise<readonly string[]> {
  try {
    const names = await readdir(snapshotsDir);
    return names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map((name) => name.slice(0, 10))
      .sort();
  } catch {
    return [];
  }
}

/** Days that already have a signed trend epoch, oldest first. */
async function publishedTrendDays(snapshotsDir: string): Promise<readonly string[]> {
  try {
    const names = await readdir(join(snapshotsDir, 'trends'));
    return names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map((name) => name.slice(0, 10))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Files of the marketing and markets app, published under /app/. Subdirectories hold the
 * signed-in dashboard and the assets it loads, so the walk has to go deeper than one level.
 */
async function appFiles(
  appDir: string,
  prefix = 'app',
): Promise<ReadonlyArray<readonly [string, string | Uint8Array]>> {
  let entries;
  try {
    entries = (await readdir(appDir, { withFileTypes: true }))
      // The auth source ships as a bundle, so publishing it would only add a file
      // the page cannot load.
      .filter((entry) => !entry.name.startsWith('.') && entry.name !== AUTH_CLIENT_SOURCE)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
  const files: Array<readonly [string, string | Uint8Array]> = [];
  for (const entry of entries) {
    const path = join(appDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await appFiles(path, `${prefix}/${entry.name}`)));
      continue;
    }
    files.push([`${prefix}/${entry.name}`, await readFile(path)]);
  }
  return files;
}

/** Assets a file host caches by URL, rather than revalidating every time. */
const VERSIONED_EXTENSIONS = ['.js', '.css'];

function digestOf(body: string | Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
  return hash.digest('hex').slice(0, 10);
}

/** Resolves a relative reference against the file that made it, or null. */
function resolveRef(fromPath: string, ref: string): string | null {
  const clean = ref.split('?')[0]?.split('#')[0] ?? '';
  if (clean === '' || clean.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
  if (!VERSIONED_EXTENSIONS.some((extension) => clean.endsWith(extension))) return null;
  return posix.normalize(posix.join(posix.dirname(fromPath), clean));
}

/**
 * Stamps every reference to a published script or stylesheet with that file's own
 * digest.
 *
 * The host caches these paths as immutable for a year and nothing purges them on
 * deploy, so a rebuilt file would keep serving the old bytes from the edge. The
 * digest changes the URL with the content, which keeps them in step without
 * renaming anything.
 */
function versionAssetReferences(files: Map<string, string | Uint8Array>): void {
  const versions = new Map<string, string>();
  for (const [path, body] of files) {
    if (VERSIONED_EXTENSIONS.some((extension) => path.endsWith(extension))) {
      versions.set(path, digestOf(body));
    }
  }
  const stamp = (fromPath: string, ref: string): string => {
    if (ref.includes('?')) return ref;
    const version = versions.get(resolveRef(fromPath, ref) ?? '');
    return version === undefined ? ref : `${ref}?v=${version}`;
  };

  for (const [path, body] of files) {
    const isHtml = path.endsWith('.html');
    if (!isHtml && !path.endsWith('.js')) continue;
    // App files are read as bytes, so text has to come back out before the
    // references in them can be rewritten.
    const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
    if (isHtml) {
      files.set(
        path,
        text.replace(
          /\b(src|href)=(["'])([^"']+)\2/g,
          (whole, attribute: string, quote: string, ref: string) => {
            const stamped = stamp(path, ref);
            return stamped === ref ? whole : `${attribute}=${quote}${stamped}${quote}`;
          },
        ),
      );
    } else {
      files.set(
        path,
        text.replace(
          /(\bfrom\s*|\bimport\s*\(\s*)(["'])([^"']+)\2/g,
          (whole, lead: string, quote: string, ref: string) => {
            const stamped = stamp(path, ref);
            return stamped === ref ? whole : `${lead}${quote}${stamped}${quote}`;
          },
        ),
      );
    }
  }
}

/**
 * Writes the site and every JSON route as static files.
 *
 * The page asks for the same relative paths either way, so one build serves both
 * from the server and from a plain file host. No route here does per-request
 * work, which is why the export cannot fall behind the server.
 */
export async function exportStatic(options: ExportOptions): Promise<number> {
  const files = new Map<string, string | Uint8Array>();
  const pages = (await readdir(options.publicDir)).filter((name) => name.endsWith('.html')).sort();
  if (!pages.includes('index.html')) {
    throw new Error(`missing page: ${join(options.publicDir, 'index.html')}`);
  }
  for (const name of pages) {
    files.set(name, await readFile(join(options.publicDir, name), 'utf8'));
  }
  for (const [target, body] of await appFiles(options.appDir)) {
    files.set(target, body);
  }
  const snapshotsDir = options.snapshotsDir;
  files.set('api/basket', basketPayload(options.basket));
  files.set('api/markets', await marketsPayload(options.marketsDir));
  files.set('api/index/history', await historyPayload(snapshotsDir));
  files.set(
    'api/trends',
    await trendsPayload({ snapshotsDir, basket: options.basket }),
  );

  for (const day of await publishedDays(snapshotsDir)) {
    files.set(`api/index/snapshot/${day}`, await readFile(join(snapshotsDir, `${day}.json`), 'utf8'));
  }
  for (const day of await publishedTrendDays(snapshotsDir)) {
    files.set(
      `api/trend-epoch/${day}`,
      await readFile(join(snapshotsDir, 'trends', `${day}.json`), 'utf8'),
    );
    files.set(`api/trend-rejections/${day}`, await rejectionsPayload(snapshotsDir, day));
  }
  for (const [target, body] of await publishedArtifacts({
    snapshotsDir,
    docsDir: options.docsDir,
  })) {
    files.set(target, body);
  }
  const optional: ReadonlyArray<readonly [string, string]> = [
    ['api/trend-epoch/latest', 'trends/latest.json'],
    ['api/index/latest', 'latest.json'],
    ['api/social/latest', 'social.json'],
  ];
  for (const [target, name] of optional) {
    try {
      files.set(target, await readFile(join(snapshotsDir, name), 'utf8'));
    } catch {
      // No signed epoch or panel yet: the route stays absent rather than empty.
    }
  }

  versionAssetReferences(files);

  for (const [path, body] of files) {
    const target = join(options.outDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  return files.size;
}
