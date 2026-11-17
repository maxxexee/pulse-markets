/**
 * Images for the basket entities. Presentation only: an entity without an entry
 * gets the page's gradient card, so this map can lag the basket without breaking
 * anything.
 *
 * Local files sit beside the page, so they are named without a directory. The
 * rest are Wikimedia lead images, keyless and stable, served at a width the
 * cards can use at 2x.
 */
function commons(hash: string, file: string, width = 330): string {
  const [first, second] = hash.split('/');
  return (
    `https://thumb.wikimedia.org/wikipedia/commons/thumb/${first}/${second}/` +
    `${file}/${width}px-${file}`
  );
}

export const ENTITY_IMAGES: Readonly<Record<string, string>> = {
  openai: 'openai.webp',
  'elon-musk': 'elon.webp',
  solana: 'solana.webp',
  nvidia: commons('7/75', '2788-2888_San_Tomas_Expwy.jpg'),
  anthropic: commons(
    'c/c3',
    'Slack_offices%2C_Howard_Street%2C_San_Francisco_%28viewed_from_the_south-west%2C_January_2020%29.jpg',
  ),
  'sam-altman': commons(
    '5/5a',
    'Meeting_with_Masayoshi_Son_and_Sam_Altman_%28February_3%2C_2025%29_%283x4_cropped_on_Altman%29.jpg',
  ),
  'jensen-huang': commons(
    'c/c8',
    'Jensen_Huang_Stanford_2026-04-30_010_%28cropped%29.jpg',
  ),
};
