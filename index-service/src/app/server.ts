import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { EntityDefinition } from '../config/entities.ts';
import { DEFAULT_MAX_AGE_DAYS, readSnapshotHealth } from '../adapters/health.ts';
import { basketPayload, historyPayload, marketsPayload } from './payloads.ts';
import { trendsPayload } from './trends.ts';
import { isValidDay } from '@pulse/index-core/dates.ts';
import { isHealthy } from '@pulse/index-core/health.ts';

export interface ServerOptions {
  readonly port: number;
  readonly publicDir: string;
  readonly snapshotsDir: string;
  readonly basket: readonly EntityDefinition[];
  /** Directory of published market specs, normally markets/ at the repo root. */
  readonly marketsDir: string;
  /** Directory of the landing page, served under /app/ for local checks. */
  readonly appDir: string;
  /** Days of lag tolerated before /api/health reports stale. */
  readonly maxAgeDays?: number;
}

interface RouteResult {
  readonly status: number;
  readonly body: string | Uint8Array;
  readonly contentType: string;
}

/** Types the landing page ships. Anything else is served as HTML, never guessed. */
const APP_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
};

/**
 * Serves the landing page's own files. Only a bare file name is accepted, so a
 * request cannot walk out of the directory, and only the types it ships.
 */
async function readAppFile(name: string, appDir: string): Promise<RouteResult> {
  if (name === '') {
    return readAppFile('index.html', appDir);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return json(404, JSON.stringify({ error: 'not-found' }));
  }
  const type = APP_TYPES[extname(name)] ?? 'text/html; charset=utf-8';
  try {
    return { status: 200, body: await readFile(join(appDir, name)), contentType: type };
  } catch {
    return json(404, JSON.stringify({ error: 'not-found' }));
  }
}

/** URL path to the page file it renders. */
const PAGES: Readonly<Record<string, string>> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/markets': 'markets.html',
  '/markets.html': 'markets.html',
};

const JSON_TYPE = 'application/json; charset=utf-8';
const JSON_HEADERS = { 'content-type': JSON_TYPE, 'cache-control': 'no-store' };

function json(status: number, body: string): RouteResult {
  return { status, body, contentType: JSON_TYPE };
}

async function readPublished(path: string): Promise<RouteResult> {
  try {
    return { status: 200, body: await readFile(path, 'utf8'), contentType: JSON_TYPE };
  } catch {
    return json(404, JSON.stringify({ error: 'not-found' }));
  }
}

/** Resolves a pathname against the fixed route table. No filesystem paths from URLs. */
async function route(
  pathname: string,
  options: ServerOptions,
  basket: string,
): Promise<RouteResult> {
  if (pathname === '/api/index/latest') {
    return readPublished(join(options.snapshotsDir, 'latest.json'));
  }
  if (pathname.startsWith('/api/index/snapshot/')) {
    const day = decodeURIComponent(pathname.slice('/api/index/snapshot/'.length));
    if (!isValidDay(day)) {
      return json(400, JSON.stringify({ error: 'invalid-day' }));
    }
    return readPublished(join(options.snapshotsDir, `${day}.json`));
  }
  if (pathname === '/api/social/latest') {
    return readPublished(join(options.snapshotsDir, 'social.json'));
  }
  if (pathname === '/api/trends/epoch/latest') {
    return readPublished(join(options.snapshotsDir, 'trends', 'latest.json'));
  }
  if (pathname.startsWith('/api/trends/epoch/')) {
    const day = decodeURIComponent(pathname.slice('/api/trends/epoch/'.length));
    if (!isValidDay(day)) {
      return json(400, JSON.stringify({ error: 'invalid-day' }));
    }
    return readPublished(join(options.snapshotsDir, 'trends', `${day}.json`));
  }
  if (pathname === '/api/health') {
    const report = await readSnapshotHealth({
      snapshotsDir: options.snapshotsDir,
      maxAgeDays: options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS,
    });
    // 503 for anything that is not current: an uptime monitor should page on it.
    return json(isHealthy(report) ? 200 : 503, JSON.stringify(report));
  }
  if (pathname === '/api/basket') {
    return json(200, basket);
  }
  if (pathname === '/api/trends') {
    return json(200, await trendsPayload({ snapshotsDir: options.snapshotsDir, basket: options.basket }));
  }
  if (pathname.startsWith('/app/')) {
    return readAppFile(pathname.slice('/app/'.length), options.appDir);
  }
  if (pathname === '/api/markets') {
    return json(200, await marketsPayload(options.marketsDir));
  }
  if (pathname === '/api/index/history') {
    return json(200, await historyPayload(options.snapshotsDir));
  }
  const page = PAGES[pathname];
  if (page !== undefined) {
    try {
      const body = await readFile(join(options.publicDir, page));
      return { status: 200, body: body.toString('utf8'), contentType: 'text/html; charset=utf-8' };
    } catch {
      return json(500, JSON.stringify({ error: 'page-missing' }));
    }
  }
  return json(404, JSON.stringify({ error: 'not-found' }));
}

/**
 * Starts the public index server.
 *
 * The routes are a fixed table rather than a path join, so no request can reach
 * a file outside the two published directories. Every JSON response is
 * uncached, because a cached score would defeat the point of an oracle.
 */
export async function startServer(options: ServerOptions): Promise<Server> {
  const basket = basketPayload(options.basket);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method !== 'GET') {
      response.writeHead(405, JSON_HEADERS).end(JSON.stringify({ error: 'method-not-allowed' }));
      return;
    }

    const result = await route(url.pathname, options, basket);
    response
      .writeHead(result.status, { 'content-type': result.contentType, 'cache-control': 'no-store' })
      .end(result.body);
  });

  await new Promise<void>((resolve) => server.listen(options.port, () => resolve()));
  return server;
}
