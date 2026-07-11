/**
 * Shared types for the Ask AI Cloudflare Worker
 */

export interface Env {
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  LLMS_URL?: string;
  ALLOWED_ORIGINS?: string;
  GEMINI_MODEL?: string;
  OPENROUTER_MODELS?: string;
  PROVIDERS?: string;
  BOT_NAME?: string;
  SITE_URL?: string;
  ASK_RATE_LIMITER?: {
    limit: (options: { key: string }) => Promise<{ success: boolean }>;
  };
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
  thinking?: string;
  sources?: Array<{ title: string; url: string }>;
  provider?: string;
  done?: boolean;
  error?: string;
}
