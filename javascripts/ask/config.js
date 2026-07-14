/** Every tunable in one place. */
export const LIMITS = {
    /** Conversational turns sent to the worker as context. */
    historyTurns: 6,
    /** Messages kept in the per-tab transcript store. */
    transcriptMessages: 20,
    /** Max question length, mirrored by the input's maxlength. */
    questionChars: 500,
    /** Context slice for the on-device (Prompt API) fallback. */
    localContextChars: 30000,
};
export const STORAGE_KEY = "gendoc-ask-transcript";
export const CONFIG_URL = "/ask-config.json";
/**
 * Load /ask-config.json.gz, falling back to /ask-config.json for local dev.
 * Handles the case where the server doesn't set Content-Encoding: gzip
 * (the response body is still compressed — decompress before parsing).
 * Returns null when the file is absent, malformed, or disabled --
 * the caller treats null as "do not install the widget".
 */
export async function loadAskConfig() {
    try {
        const res = await fetch(CONFIG_URL, { cache: "no-cache" });
        if (!res.ok)
            return null;
        const body = await res.arrayBuffer();
        const raw = JSON.parse(new TextDecoder().decode(body));
        if (typeof raw !== "object" || raw === null)
            return null;
        const cfg = raw;
        if (!cfg.enabled)
            return null;
        return {
            enabled: true,
            endpoint: cfg.endpoint ?? "",
            title: cfg.title ?? "Ask",
            placeholder: cfg.placeholder ?? "Ask a question...",
            llms_full_url: cfg.llms_full_url ?? "/llms-full.txt",
        };
    }
    catch {
        return null;
    }
}
