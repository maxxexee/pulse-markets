import { completeChat, type ChatConfig } from '../adapters/chat-completion.ts';
import { fetchArticleExtract } from '../adapters/wikipedia-top.ts';
import { mapWithConcurrency } from '../domain/concurrency.ts';
import type { DiscoveredTopic } from '../domain/discovery.ts';

/**
 * One sentence of context for a topic the daily ranking surfaced.
 *
 * The model is not asked what happened in the world. It is given the article's
 * own opening plus the measured traffic, and asked what the page is and, only
 * where the page says so, why people would look it up. A note with a number in
 * it is thrown away: the card already shows the figures, so any digit in the
 * sentence came from the model rather than from the record.
 */
export const CONTEXT_PROMPT_VERSION = 'trend-context-v1';

const MAX_WORDS = 35;
const MAX_EXTRACT_CHARS = 1_200;
const CONCURRENCY = 2;

const SYSTEM_PROMPT =
  'You write one sentence of context for a public index of what people look up online. ' +
  'You are given a topic, the traffic it received on one day, and the opening of its ' +
  'encyclopedia article. State what the topic is, and why people might be looking it up ' +
  'only if the article states it plainly. Never invent an event, cause, date or person, and ' +
  'never mention the traffic figures because the page shows them. No hype, no speculation, ' +
  'no advice. One sentence, at most 35 words, plain English.';

export interface ContextNote {
  readonly text: string;
  readonly model: string;
  readonly promptVersion: string;
  /** Article the note was grounded in. */
  readonly sourceUrl: string;
}

function promptFor(args: {
  readonly topic: DiscoveredTopic;
  readonly day: string;
  readonly extract: string;
}): string {
  return [
    `Topic: ${args.topic.topic}`,
    `Day: ${args.day}`,
    `Traffic: ${args.topic.views} views against a ${args.topic.baselineDays} day average of ${args.topic.baseline}`,
    'Article opening:',
    args.extract.slice(0, MAX_EXTRACT_CHARS),
  ].join('\n');
}

/** Rejects anything that is not one clean, number-free sentence. */
export function cleanNote(raw: string): string | null {
  const text = raw
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'“”]+|[\s"'“”]+$/g, '')
    .trim();
  if (text === '') {
    return null;
  }
  if (/[0-9]/.test(text)) {
    return null;
  }
  return text.split(' ').length > MAX_WORDS ? null : text;
}

/** One note, or null when the article is unreadable or the reply is rejected. */
async function noteFor(args: {
  readonly topic: DiscoveredTopic;
  readonly day: string;
  readonly config: ChatConfig;
  readonly fetchImpl?: typeof fetch;
  readonly log: (line: string) => void;
}): Promise<readonly [string, ContextNote] | null> {
  const fetchOption = args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl };
  const article = await fetchArticleExtract(args.topic.article, fetchOption);
  if (article === null || article.extract === '') {
    args.log(`context skipped for ${args.topic.article}: article unreadable`);
    return null;
  }
  try {
    const raw = await completeChat({
      config: args.config,
      system: SYSTEM_PROMPT,
      user: promptFor({ topic: args.topic, day: args.day, extract: article.extract }),
      ...fetchOption,
    });
    const text = cleanNote(raw);
    if (text === null) {
      args.log(`context dropped for ${args.topic.article}: not one clean sentence`);
      return null;
    }
    return [
      args.topic.article,
      {
        text,
        model: args.config.model,
        promptVersion: CONTEXT_PROMPT_VERSION,
        sourceUrl: article.url,
      } satisfies ContextNote,
    ];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.log(`context failed for ${args.topic.article}: ${message}`);
    return null;
  }
}

/**
 * Writes a note per topic, skipping any topic whose article cannot be read and
 * any topic whose completion fails. Returns notes keyed by article title.
 */
export async function notesForTopics(args: {
  readonly topics: readonly DiscoveredTopic[];
  readonly day: string;
  readonly config: ChatConfig;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
}): Promise<ReadonlyMap<string, ContextNote>> {
  const log = args.log ?? (() => undefined);
  const written = await mapWithConcurrency(args.topics, CONCURRENCY, (topic) =>
    noteFor({
      topic,
      day: args.day,
      config: args.config,
      log,
      ...(args.fetchImpl === undefined ? {} : { fetchImpl: args.fetchImpl }),
    }),
  );
  return new Map(written.filter((entry) => entry !== null));
}
