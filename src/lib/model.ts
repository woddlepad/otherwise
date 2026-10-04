import { createAnthropic } from '@ai-sdk/anthropic';

const DEFAULT_MODEL = 'neon/claude-opus-5-5';

/**
 * The LLM every agent uses, picked by MODEL (any Mastra model-router id).
 * Mastra's built-in `neon/` provider talks to the gateway's chat-completions endpoint, which returns
 * reasoning Claude models (Opus 5.5) as content-block arrays it can't parse ("Invalid JSON response").
 * So `neon/claude-*` goes through the gateway's native Anthropic Messages endpoint instead.
 */
export function languageModel() {
  const id = process.env.MODEL || DEFAULT_MODEL;
  const claude = id.match(/^neon\/(claude-.+)$/);
  if (!claude) return id;
  return createAnthropic({
    baseURL: `${process.env.NEON_AI_GATEWAY_BASE_URL?.replace(/\/$/, '')}/anthropic/v1`,
    authToken: process.env.NEON_AI_GATEWAY_TOKEN,
  })(claude[1]);
}
