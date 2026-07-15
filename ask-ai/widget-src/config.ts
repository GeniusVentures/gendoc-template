import type { AskConfig } from "./types.js";

/** Every tunable in one place. */
export const LIMITS = {
  /** Conversational turns sent to the worker as context. */
  historyTurns: 6,
  /** Messages kept in the per-tab transcript store. */
  transcriptMessages: 20,
  /** Max question length, mirrored by the input's maxlength. */
  questionChars: 500,
  /** Context slice for the on-device (Prompt API) fallback. */
  localContextChars: 30_000,
} as const;

export const STORAGE_KEY = "gendoc-ask-transcript";
export const CONFIG_URL = "/ask-config.json";
export const LOCAL_CONFIG_URL = "/ask-config.local.json";

/** Shared parse-and-validate logic for a fetch Response. */
async function parseConfig(res: Response): Promise<AskConfig | null> {
  const body = await res.arrayBuffer();
  const raw: unknown = JSON.parse(new TextDecoder().decode(body));
  if (typeof raw !== "object" || raw === null) return null;
  const cfg = raw as Partial<AskConfig>;
  if (!cfg.enabled) return null;
  return {
    enabled: true,
    endpoint: cfg.endpoint ?? "",
    title: cfg.title ?? "Ask",
    placeholder: cfg.placeholder ?? "Ask a question...",
    llms_full_url: cfg.llms_full_url ?? "/llms-full.txt",
  };
}

/**
 * Load the ask widget configuration.
 *
 * On localhost, try /ask-config.local.json first (created by
 * test-local.sh).  Falls back to /ask-config.json if the local
 * file is absent — so you can test against the production worker
 * by simply not running test-local.sh.
 *
 * When deploy.cloudflare.gzip_json is true, the fetch-gzip.js
 * wrapper transparently rewrites .json → .json.gz with client-side
 * decompression.
 *
 * Returns null when no config is available, malformed, or disabled —
 * the caller treats null as "do not install the widget".
 */
export async function loadAskConfig(): Promise<AskConfig | null> {
  const isLocal = window.location.hostname === "localhost"
               || window.location.hostname === "127.0.0.1";

  // ── localhost: try ask-config.local.json first ──────────────────────────
  if (isLocal) {
    try {
      const res = await fetch(LOCAL_CONFIG_URL, { cache: "no-cache" });
      if (res.ok) {
        const cfg = await parseConfig(res);
        if (cfg) return cfg;
      }
    } catch { /* absent — fall through to normal config */ }
  }

  // ── Normal config (works locally when .local.json is absent, and in prod) ──
  try {
    const res = await fetch(CONFIG_URL, { cache: "no-cache" });
    if (!res.ok) return null;
    return await parseConfig(res);
  } catch {
    return null;
  }
}
