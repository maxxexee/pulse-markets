/**
 * Images for discovered topics whose article has no usable picture.
 *
 * Keyed by the underscored article title. A value is either a path inside the
 * published `app/` directory or an absolute https URL. Only images the project
 * has the right to publish belong here: the automatic sources (Wikipedia lead
 * image, Wikidata P18) are free-licensed, while a press or social photo is not.
 */
export const TOPIC_IMAGES: Readonly<Record<string, string>> = {};

/** Curated image for an article, or null when none was supplied. */
export function curatedImage(article: string): string | null {
  const value = TOPIC_IMAGES[article];
  return value === undefined || value.trim() === '' ? null : value;
}
