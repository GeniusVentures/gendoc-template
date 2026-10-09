import { buildSearchIndex, isSearchIndex, rankedSearch, searchSnippet } from "./search-index.js";
import type { AskSearchIndex, SearchDoc } from "./search-index.js";

let cached: AskSearchIndex | null = null;
let pending: Promise<AskSearchIndex | null> | null = null;

async function loadIndex(): Promise<AskSearchIndex | null> {
    if (cached) return cached;
    if (pending) return pending;
    pending = (async () => {
        try {
            const res = await fetch("/data/ask-search.json");
            if (res.ok) {
                const data: unknown = await res.json();
                if (isSearchIndex(data)) return (cached = data);
            }
        } catch { /* older deployment / unavailable — try Material's index */ }
        try {
            const res = await fetch("/search/search_index.json");
            if (!res.ok) return null;
            const data: { docs?: SearchDoc[] } = await res.json();
            if (!Array.isArray(data.docs)) return null;
            const docs = data.docs.filter(doc => doc && typeof doc.location === "string" &&
                typeof doc.title === "string" && typeof doc.text === "string");
            return (cached = buildSearchIndex(docs));
        } catch { return null; }
    })();
    try { return await pending; } finally { pending = null; }
}

/** Ask AI hints only. Material's search box keeps its own browser index. */
export async function searchHints(question: string): Promise<string> {
    if (!question.trim()) return "";
    const index = await loadIndex();
    if (!index) return "";
    const seen = new Set<string>();
    const hits: string[] = [];
    for (const doc of rankedSearch(index, question)) {
        if (seen.has(doc.location)) continue;
        seen.add(doc.location);
        const title = doc.title.replace(/[\[\]\r\n]/g, " ");
        const url = doc.location.replace(/[\s()]/g, ch => encodeURIComponent(ch));
        hits.push(`- [${title}](${url}): "${searchSnippet(doc, question)}"`);
        if (hits.length >= 10) break;
    }
    return hits.join("\n");
}
