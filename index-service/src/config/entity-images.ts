/**
 * Images for entities the landing page can show. Presentation only: an entity
 * without an entry gets the page's gradient card, so this map can lag the basket
 * without breaking anything.
 *
 * Paths are relative to the site root, so they resolve from /app/ on the server
 * and from app/ on Pages, where the page sits one directory down.
 */
export const ENTITY_IMAGES: Readonly<Record<string, string>> = {
  openai: 'openai.webp',
  'elon-musk': 'elon.webp',
  solana: 'solana.webp',
};
