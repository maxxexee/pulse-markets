import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EntityDefinition } from '../config/entities.ts';
import { isValidDay } from '../domain/dates.ts';

export interface ServerOptions {
  readonly port: number;
  readonly publicDir: string;
  readonly snapshotsDir: string;
  readonly basket: readonly EntityDefinition[];
}

interface RouteResult {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
}

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
  basketPayload: string,
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
  if (pathname === '/api/basket') {
    return json(200, basketPayload);
  }
  if (pathname === '/' || pathname === '/index.html') {
    try {
      const page = await readFile(join(options.publicDir, 'index.html'));
      return { status: 200, body: page.toString('utf8'), contentType: 'text/html; charset=utf-8' };
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
  const basketUrl = (article: string) =>
    `https://en.wikipedia.org/wiki/${encodeURIComponent(article.replaceAll(' ', '_'))}`;

  const basketPayload = JSON.stringify({
    entities: options.basket.map((entity) => ({
      id: entity.id,
      label: entity.label,
      wikipediaUrl: basketUrl(entity.wikipediaArticle),
      hackerNewsQuery: entity.hackerNewsQuery,
    })),
  });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    if (request.method !== 'GET') {
      response.writeHead(405, JSON_HEADERS).end(JSON.stringify({ error: 'method-not-allowed' }));
      return;
    }

    const result = await route(url.pathname, options, basketPayload);
    response
      .writeHead(result.status, { 'content-type': result.contentType, 'cache-control': 'no-store' })
      .end(result.body);
  });

  await new Promise<void>((resolve) => server.listen(options.port, () => resolve()));
  return server;
}
