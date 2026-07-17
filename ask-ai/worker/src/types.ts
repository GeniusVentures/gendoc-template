/**
 * Shared types for the Ask AI Cloudflare Worker
 */

export interface Env {
  // LLM Provider Keys (use wrangler secret put)
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;

  // Configuration
  LLMS_URL?: string;
  ALLOWED_ORIGINS?: string;
  GEMINI_MODEL?: string;
  OPENROUTER_MODELS?: string;
  PROVIDERS?: string;           // comma-separated, e.g. "openrouter,gemini"
  BOT_NAME?: string;
  SITE_URL?: string;

  // Rate Limiting (optional Cloudflare Rate Limiting binding)
  ASK_RATE_LIMITER?: {
    limit: (options: { key: string }) => Promise<{ success: boolean }>;
  };

  // Optional KV for advanced rate limiting (future)
  // RATE_LIMIT_KV?: KVNamespace;
}

export interface CatalogEntry {
  title: string;
  url: string;
  desc?: string;
  score?: number;
  tiebreak?: number;
}

export interface DocContent {
  title: string;
  url: string;
  text: string;
}

export interface SSEMessage {
  text?: string;
  /** Replace the current answer text, used when a streamed final fails validation. */
  replaceText?: string;
  thinking?: string;
  sources?: Array<{ title: string; url: string }>;
  provider?: string;
  done?: boolean;
  error?: string;
}

export interface JailbreakCheckResult {
  blocked: boolean;
  reason?: string;
}
