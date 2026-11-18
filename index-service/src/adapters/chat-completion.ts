/**
 * Build-time text generation over an OpenAI-compatible chat completions API.
 *
 * Only the discovery notes use this, which is why it stays a thin POST with no
 * retry: a note that fails is dropped and the card keeps its measured summary.
 * Nothing on the settlement path may depend on a third party finishing a
 * sentence.
 */

const DEFAULT_BASE_URL = 'https://api.z.ai/api/paas/v4';
const DEFAULT_MODEL = 'glm-4.5-flash';
const TIMEOUT_MS = 30_000;

export interface ChatConfig {
  readonly apiKey: string;
  /** Base URL without the trailing `/chat/completions`. */
  readonly baseUrl: string;
  readonly model: string;
}

/** Reads the provider settings, or null when no key is configured. */
export function chatConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ChatConfig | null {
  const apiKey = env['PULSE_SUMMARY_API_KEY'];
  if (apiKey === undefined || apiKey.trim() === '') {
    return null;
  }
  return {
    apiKey,
    baseUrl: env['PULSE_SUMMARY_API_BASE'] ?? DEFAULT_BASE_URL,
    model: env['PULSE_SUMMARY_MODEL'] ?? DEFAULT_MODEL,
  };
}

export async function completeChat(args: {
  readonly config: ChatConfig;
  readonly system: string;
  readonly user: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<string> {
  const response = await (args.fetchImpl ?? fetch)(`${args.config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.config.apiKey}`,
    },
    body: JSON.stringify({
      model: args.config.model,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      temperature: 0.2,
      max_tokens: 120,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`chat completion failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('chat completion returned no text');
  }
  return content.trim();
}
