import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

/** Neon writes the branch's Managed Auth URL here; it is public, never a secret. */
const AUTH_URL_ENV = 'NEON_AUTH_BASE_URL';

/** Browser module that is bundled; it is not published, the bundle is. */
export const AUTH_CLIENT_SOURCE = 'auth-client.js';

/** Bundle the sign-up page loads. Generated, so it is not in version control. */
export const AUTH_CLIENT_BUNDLE = 'auth-client.bundle.js';

/**
 * Bundles the sign-up page's auth module, injecting the branch auth URL.
 *
 * The site is published to a plain file host, so there is no request time to
 * resolve `@neon/auth` or its bare imports. The bundle is written beside the app
 * files it ships with, which keeps one path in both the server and the export.
 *
 * @throws when the auth URL is missing, because a bundle built without it would
 * sign nobody up and only fail in the browser.
 */
export async function buildAuthClient(appDir: string, repoRoot: string): Promise<void> {
  const baseUrl = readAuthBaseUrl(repoRoot);
  await build({
    entryPoints: [join(appDir, AUTH_CLIENT_SOURCE)],
    outfile: join(appDir, AUTH_CLIENT_BUNDLE),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    logLevel: 'silent',
    define: { __PULSE_AUTH_URL__: JSON.stringify(baseUrl) },
  });
}

/**
 * Reads the auth URL from the environment Neon populated.
 *
 * `.env.local` wins over `.env`; a variable set in the shell wins over both,
 * because Node does not overwrite what is already set.
 */
function readAuthBaseUrl(repoRoot: string): string {
  for (const name of ['.env.local', '.env']) {
    const path = join(repoRoot, name);
    if (existsSync(path)) process.loadEnvFile(path);
  }
  const baseUrl = process.env[AUTH_URL_ENV]?.trim();
  if (baseUrl === undefined || baseUrl === '') {
    throw new Error(
      `missing ${AUTH_URL_ENV}: run \`neon deploy\` to write it into .env.local, ` +
        'or export it before exporting the site',
    );
  }
  return baseUrl;
}
